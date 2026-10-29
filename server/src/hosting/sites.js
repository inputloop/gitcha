// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Static site hosting (sites made of plain files, served as they are).
// A user or a team owns each site. A site gets a subdomain on every configured
// hosting domain, can add DNS-verified custom domains (see domains.js), and
// serves the files of its active deploy.
// Deploys are immutable (never changed) folders on disk, under
// DATA_DIR/sites/<site>/<deploy id>. Activating one only switches which
// deploy the site record points at, in one step, so rollback is instant.
// Site records live in the store under data.sites, keyed by site name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { unpackFiles, extractTo } from '../../../extension/lib/tar.js';

// A site name is one DNS label: 1 to 63 lowercase letters, digits or "-", not starting or ending with "-".
export const SITE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Names nobody may take, because they look official or are used by Gitcha.
const RESERVED = new Set(['www', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1', 'ns2', 'gitcha', 'ring', 'ops', 'status', 'billing', 'static', 'cdn', 'login', 'auth', 'kiosk']);
// The optional settings file a site may include in its upload.
export const SITE_CONFIG = 'gitcha.site.json';
// One owner may hold this many sites, whatever the billing setting. (Each site
// is a name a certificate can be ordered for.)
const MAX_SITES = 25;
// One owner's sites together may hold this much on disk (all kept deploys,
// unpacked), whatever the billing setting. The careful default is ten times the
// per-site cap (the keepers can set config.hosting.maxOwnerBytes).
const OWNER_BYTES_FACTOR = 10;
// Second-level names under a country code that nobody can register by
// themselves (like co.uk or com.au). A short list, not the full Public Suffix List.
const SECOND_LEVELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/**
 * The registrable part of a host (the part you buy, like example.com), by a
 * rough rule: the last two labels, or the last three under a two-letter
 * country code with a second level (like example.co.uk).
 */
export function registrableDomain(host) {
  const labels = String(host ?? '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const n = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVELS.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-n).join('.');
}

// Content-Type for each file extension. Anything else is sent as application/octet-stream.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.org': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary',
};

/**
 * Parse and check the optional gitcha.site.json. Only known keys are kept:
 * spa (send index.html for unknown paths), notFound (the 404 page), routes
 * and headers. Headers that could break the HTTP reply or set cookies are
 * dropped, and line breaks are removed from values.
 */
export function parseSiteConfig(buf) {
  if (!buf) return {};
  let c;
  try { c = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad_site_config', `${SITE_CONFIG} is not valid JSON.`); }
  const out = {};
  if (c.spa !== undefined) out.spa = Boolean(c.spa);
  if (typeof c.notFound === 'string') out.notFound = c.notFound;
  if (c.routes && typeof c.routes === 'object') {
    // "/api/*": "function-name" means requests under that prefix go to a lambda
    // function (a small program that runs per request, see compute/functions.js).
    out.routes = {};
    for (const [pattern, fn] of Object.entries(c.routes)) {
      if (!/^\/[\w\-./]*\*?$/.test(pattern) || typeof fn !== 'string') throw new HttpError(400, 'bad_site_config', `Bad route "${pattern}".`);
      out.routes[pattern] = fn;
    }
  }
  if (c.headers && typeof c.headers === 'object') {
    out.headers = {};
    for (const [k, v] of Object.entries(c.headers)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /^(set-cookie|content-length|transfer-encoding|connection)$/i.test(k)) continue;
      out.headers[k] = String(v).slice(0, 1024).replace(/[\r\n]/g, '');
    }
  }
  return out;
}

/**
 * Creates, deploys, rolls back and deletes sites, and finds the file to send for a request.
 */
export class SiteService {
  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
    this.root = path.join(config.dataDir, 'sites');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // A hosting domain in the same registrable domain as the UI would make
    // tenants' pages "same-site" with the UI, so browsers would treat them as
    // one site for the UI's cookies. That is unsafe, so the server refuses to
    // start. The rule is rough (no Public Suffix List is bundled); see DEPLOY.md.
    const ui = registrableDomain(new URL(config.publicUrl).hostname);
    for (const d of config.hosting.domains) {
      if (ui && registrableDomain(d) === ui) {
        throw new Error(`GITCHA_HOSTING_DOMAINS: "${d}" shares the registrable domain ${ui} with GITCHA_PUBLIC_URL. Use a separate registrable domain for hosted sites.`);
      }
    }
  }

  // ---- ownership -----------------------------------------------------------
  // The owner for a new site: the user, or a team the user maintains.
  ownerFor(user, teamName) {
    if (!teamName) return { type: 'user', name: user.username };
    const team = this.teams.get(teamName);
    this.teams.require(team, user, 'maintainer');
    return { type: 'team', name: team.name };
  }

  // May change the site: the owning user, or a maintainer of the owning team.
  canManage(user, site) {
    if (!user) return false;
    if (site.owner.type === 'user') return site.owner.name === user.username;
    const team = this.store.team(site.owner.name);
    return Boolean(team && this.teams.has(team, user, 'maintainer'));
  }

  // May see the site's settings: the owner, team members, and admins.
  canSee(user, site) {
    if (!user) return false;
    if (site.owner.type === 'user') return site.owner.name === user.username || user.role === 'admin';
    const team = this.store.team(site.owner.name);
    return Boolean(team && this.teams.has(team, user, 'member')) || user.role === 'admin';
  }

  // Find a site by name, or throw 404.
  get(name) {
    const site = this.store.data.sites[String(name).toLowerCase()];
    if (!site) throw new HttpError(404, 'site_not_found', `No site named "${name}".`);
    return site;
  }

  // Find a site the user may change. Someone who can see it but not change it
  // gets 403; anyone else gets 404, so they cannot learn the site exists.
  manageable(user, name) {
    const site = this.get(name);
    if (!this.canManage(user, site)) {
      throw new HttpError(site && this.canSee(user, site) ? 403 : 404, site && this.canSee(user, site) ? 'site_forbidden' : 'site_not_found',
        this.canSee(user, site) ? `You need to own "${site.name}" (or maintain its team) to change it.` : `No site named "${name}".`);
    }
    return site;
  }

  // Every name the site answers on: its subdomains, then its verified custom domains.
  hostnames(site) {
    const sub = this.config.hosting.domains.map((d) => `${site.name}.${d}`);
    const custom = Object.values(this.store.data.domains).filter((d) => d.site === site.name && d.verified).map((d) => d.hostname);
    return [...sub, ...custom];
  }

  // The API shape of a site, with its deploys newest first.
  view(site, user) {
    return {
      name: site.name, owner: site.owner, createdAt: site.createdAt, description: site.description ?? '',
      urls: this.hostnames(site).map((h) => `https://${h}/`),
      activeDeploy: site.activeDeploy,
      config: site.config ?? {},
      deploys: site.deploys.slice().reverse().map((d) => ({ ...d, active: d.id === site.activeDeploy })),
      canManage: this.canManage(user, site),
    };
  }

  // Every site the user may see, sorted by name.
  listFor(user) {
    return Object.values(this.store.data.sites).filter((s) => this.canSee(user, s)).sort((a, b) => a.name.localeCompare(b.name)).map((s) => this.view(s, user));
  }

  // ---- lifecycle -------------------------------------------------------------
  // Make a new site record after checking the name, the owner's site limit
  // and billing. Each site gets a random uid (see identity()).
  create(user, { name, team, description = '' }, ip) {
    name = String(name ?? '').trim().toLowerCase();
    if (!SITE_RE.test(name)) throw new HttpError(400, 'bad_site_name', 'Site names are DNS labels: lowercase letters, digits and "-", 1-63 characters.');
    if (RESERVED.has(name)) throw new HttpError(409, 'site_reserved', `"${name}" is reserved.`);
    if (this.store.data.sites[name]) throw new HttpError(409, 'site_exists', `The site name "${name}" is taken.`);
    const owner = this.ownerFor(user, team);
    const count = Object.values(this.store.data.sites).filter((s) => s.owner.type === owner.type && s.owner.name === owner.name).length;
    if (count >= (this.config.hosting.maxSites ?? MAX_SITES)) throw new HttpError(403, 'site_limit', 'This account holds as many sites as it may.');
    this.billing?.check(`${owner.type}:${owner.name}`, 'sites', count);
    const site = { name, uid: crypto.randomBytes(8).toString('hex'), owner, description: String(description).slice(0, 300), createdAt: this.clock(), createdBy: user.username, deploys: [], activeDeploy: null, config: {} };
    this.store.tx((d) => {
      d.sites[name] = site;
      this.store.audit({ userId: user.id, event: 'site.created', ip, site: name, owner: `${owner.type}:${owner.name}` });
    });
    return site;
  }

  /** Which site this is, so a site that was deleted and made again with the same name is not mistaken for it. */
  identity(site) { return site.uid ?? String(site.createdAt); }

  /** Unpacked bytes held by every kept deploy of the owner's sites. */
  storageUsed(owner) {
    let n = 0;
    for (const s of Object.values(this.store.data.sites)) {
      if (s.owner.type === owner.type && s.owner.name === owner.name) for (const d of s.deploys) n += d.bytes ?? d.size ?? 0;
    }
    return n;
  }

  /**
   * Store a deploy from a gzipped tarball (a .tar.gz archive, files rooted at
   * package/). Steps: check the size limits (per site and per owner), read the
   * site config, unpack into a new deploy folder, save the record, make it
   * active if asked, then delete old deploys. With no user (a CI job), the
   * caller must have checked access already.
   */
  deploy(user, name, { tarball, activate = true, source = 'upload', jobId = null }, ip) {
    const site = user ? this.manageable(user, name) : this.get(name);
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No site tarball was sent.');
    const cap = this.config.hosting.maxSiteBytes;
    if (tarball.length > cap) throw new HttpError(413, 'too_large', 'Site is too large.');
    let files;
    // The cap is on what the site holds once unpacked, not on the compressed upload.
    try { files = unpackFiles(tarball, { maxBytes: cap }); } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE' || /too large|exceeds|expands to more than/i.test(err.message)) throw new HttpError(413, 'too_large', 'Site is too large once unpacked.');
      throw new HttpError(400, 'bad_tarball', `Invalid site tarball: ${err.message}`);
    }
    if (!files.length) throw new HttpError(400, 'empty_site', 'The site has no files.');
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > cap) throw new HttpError(413, 'too_large', 'Site is too large once unpacked.');
    const used = this.storageUsed(site.owner);
    if (used + total > (this.config.hosting.maxOwnerBytes ?? cap * OWNER_BYTES_FACTOR)) {
      throw new HttpError(413, 'storage_full', `${site.owner.name} already holds ${used} bytes of sites; delete a site or old deploys first.`);
    }
    this.billing?.check(`${site.owner.type}:${site.owner.name}`, 'site_bytes', used + total);
    const config = parseSiteConfig(files.find((f) => f.path === SITE_CONFIG)?.data);
    const id = `${new Date(this.clock()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(this.root, site.name, id);
    const record = {
      id, createdAt: this.clock(), by: user?.username ?? `ci:${jobId}`, source, jobId,
      files: files.length, size: tarball.length, bytes: total, integrity: `sha256-${sha256(tarball)}`, config,
    };
    try {
      extractTo(files.filter((f) => f.path !== SITE_CONFIG), dir);
    } catch (err) {
      // A deploy that fails leaves nothing behind: no folder and no record.
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(400, 'bad_tarball', `The site cannot be unpacked (${err.code ?? 'conflicting paths'}).`);
    }
    try {
      this.store.tx((d) => {
        const s = d.sites[site.name];
        s.deploys.push(record);
        if (activate) { s.activeDeploy = id; s.config = config; }
        this.store.audit({ userId: user?.id, event: 'site.deployed', ip, site: site.name, deploy: id, source });
      });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    this.prune(site.name);
    return record;
  }

  // Make an older (or newer) kept deploy the live one. This is how rollback works.
  activate(user, name, deployId, ip) {
    const site = this.manageable(user, name);
    const dep = site.deploys.find((d) => d.id === deployId);
    if (!dep) throw new HttpError(404, 'deploy_not_found', `No deploy "${deployId}" for ${site.name}.`);
    this.store.tx((d) => {
      Object.assign(d.sites[site.name], { activeDeploy: dep.id, config: dep.config ?? {} });
      this.store.audit({ userId: user.id, event: 'site.rollback', ip, site: site.name, deploy: dep.id });
    });
    return dep;
  }

  // Delete old deploys from disk and from the record.
  prune(name) {
    const site = this.get(name);
    // Keep the active deploy plus the newest others, up to keepDeploys in total.
    const keep = Math.max(1, this.config.hosting.keepDeploys);
    const others = site.deploys.filter((d) => d.id !== site.activeDeploy).reverse();
    const old = others.slice(Math.max(0, keep - (site.activeDeploy ? 1 : 0)));
    if (!old.length) return;
    for (const d of old) fs.rmSync(path.join(this.root, site.name, d.id), { recursive: true, force: true });
    const gone = new Set(old.map((d) => d.id));
    this.store.tx((d) => { d.sites[name].deploys = d.sites[name].deploys.filter((x) => !gone.has(x.id)); });
  }

  // Delete a site, its domains and claims, and all its files on disk.
  remove(user, name, ip) {
    const site = this.manageable(user, name);
    this.store.tx((d) => {
      delete d.sites[site.name];
      for (const [h, dom] of Object.entries(d.domains)) if (dom.site === site.name) delete d.domains[h];
      for (const [h, claims] of Object.entries(d.domainClaims ?? {})) { delete claims[site.name]; if (!Object.keys(claims).length) delete d.domainClaims[h]; }
      this.store.audit({ userId: user.id, event: 'site.deleted', ip, site: site.name });
    });
    fs.rmSync(path.join(this.root, site.name), { recursive: true, force: true });
    return { deleted: site.name };
  }

  // ---- serving -----------------------------------------------------------------
  /** Which site (if any) does this Host header belong to? */
  siteForHost(host) {
    host = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    for (const d of this.config.hosting.domains) {
      if (host.endsWith(`.${d}`)) {
        const label = host.slice(0, -d.length - 1);
        return SITE_RE.test(label) ? this.store.data.sites[label] ?? null : null;
      }
    }
    const dom = this.store.data.domains[host];
    return dom?.verified ? this.store.data.sites[dom.site] ?? null : null;
  }

  // Does this Host header belong to hosting at all (even if no site answers it)?
  isHostingHost(host) {
    host = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    // Registered custom domains belong to hosting even before they verify, so they never reach the UI.
    return this.config.hosting.domains.some((d) => host === d || host.endsWith(`.${d}`)) || Boolean(this.store.data.domains[host] || this.store.data.domainClaims?.[host]);
  }

  /** Function route for this path, if the site maps one. */
  routeFor(site, pathname) {
    for (const [pattern, fn] of Object.entries(site.config?.routes ?? {})) {
      if (pattern.endsWith('*') ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern) return fn;
    }
    return null;
  }

  /**
   * Find the file in the active deploy for a URL path, or null. It tries the
   * path, then path.html, then path/index.html. Each candidate must stay
   * inside the deploy folder, so "../" tricks cannot read other files.
   * For an spa site, unknown paths get index.html.
   */
  resolveFile(site, pathname) {
    if (!site.activeDeploy) return null;
    const base = path.join(this.root, site.name, site.activeDeploy);
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return null; }
    if (rel.includes('\0')) return null;
    const candidates = rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
    for (const c of candidates) {
      const full = path.resolve(base, `.${path.posix.normalize(c)}`);
      if (!full.startsWith(base + path.sep)) return null;
      try { if (fs.statSync(full).isFile()) return full; } catch { /* try next */ }
    }
    const cfg = site.config ?? {};
    if (cfg.spa) {
      const idx = path.join(base, 'index.html');
      if (fs.existsSync(idx)) return idx;
    }
    return null;
  }

  // The site's own 404 page (notFound in the config, or 404.html), if it exists inside the deploy.
  notFoundFile(site) {
    if (!site.activeDeploy) return null;
    const base = path.join(this.root, site.name, site.activeDeploy);
    const f = path.resolve(base, site.config?.notFound ?? '404.html');
    return f.startsWith(base + path.sep) && fs.existsSync(f) ? f : null;
  }

  // Send a file with safe default headers. nosniff tells the browser to trust
  // our Content-Type and not guess. HTML is never cached; other files are
  // cached for 5 minutes. The site's own config headers are added last.
  sendFile(res, site, file, status = 200, method = 'GET') {
    const ext = path.extname(file).toLowerCase();
    const body = fs.readFileSync(file);
    res.writeHead(status, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Gitcha-Site': site.name,
      'X-Gitcha-Deploy': site.activeDeploy,
      ...(site.config?.headers ?? {}),
    });
    res.end(method === 'HEAD' ? undefined : body);
  }
}

/** The DNS name where the TXT proof for a custom domain must be. */
export const challengeName = (hostname) => `_gitcha-challenge.${hostname}`;
