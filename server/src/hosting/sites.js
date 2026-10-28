// Static site hosting. A site is owned by a user or a team, gets a subdomain
// on every configured hosting domain, can add DNS-verified custom domains, and
// serves the files of its active deploy. Deploys are immutable directories on
// disk; activating one is an atomic pointer switch, so rollback is instant.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { unpackFiles, extractTo } from '../../../extension/lib/tar.js';

export const SITE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1', 'ns2', 'gitcha', 'ring', 'ops', 'status', 'billing', 'static', 'cdn', 'login', 'auth', 'kiosk']);
export const SITE_CONFIG = 'gitcha.site.json';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.org': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary',
};

/** Parse and sanity-check the optional gitcha.site.json. */
export function parseSiteConfig(buf) {
  if (!buf) return {};
  let c;
  try { c = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad_site_config', `${SITE_CONFIG} is not valid JSON.`); }
  const out = {};
  if (c.spa !== undefined) out.spa = Boolean(c.spa);
  if (typeof c.notFound === 'string') out.notFound = c.notFound;
  if (c.routes && typeof c.routes === 'object') {
    // "/api/*": "function-name": requests under that prefix go to a lambda function.
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

export class SiteService {
  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
    this.root = path.join(config.dataDir, 'sites');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  // ---- ownership -----------------------------------------------------------
  ownerFor(user, teamName) {
    if (!teamName) return { type: 'user', name: user.username };
    const team = this.teams.get(teamName);
    this.teams.require(team, user, 'maintainer');
    return { type: 'team', name: team.name };
  }

  canManage(user, site) {
    if (!user) return false;
    if (site.owner.type === 'user') return site.owner.name === user.username;
    const team = this.store.team(site.owner.name);
    return Boolean(team && this.teams.has(team, user, 'maintainer'));
  }

  canSee(user, site) {
    if (!user) return false;
    if (site.owner.type === 'user') return site.owner.name === user.username || user.role === 'admin';
    const team = this.store.team(site.owner.name);
    return Boolean(team && this.teams.has(team, user, 'member')) || user.role === 'admin';
  }

  get(name) {
    const site = this.store.data.sites[String(name).toLowerCase()];
    if (!site) throw new HttpError(404, 'site_not_found', `No site named "${name}".`);
    return site;
  }

  manageable(user, name) {
    const site = this.get(name);
    if (!this.canManage(user, site)) {
      throw new HttpError(site && this.canSee(user, site) ? 403 : 404, site && this.canSee(user, site) ? 'site_forbidden' : 'site_not_found',
        this.canSee(user, site) ? `You need to own "${site.name}" (or maintain its team) to change it.` : `No site named "${name}".`);
    }
    return site;
  }

  hostnames(site) {
    const sub = this.config.hosting.domains.map((d) => `${site.name}.${d}`);
    const custom = Object.values(this.store.data.domains).filter((d) => d.site === site.name && d.verified).map((d) => d.hostname);
    return [...sub, ...custom];
  }

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

  listFor(user) {
    return Object.values(this.store.data.sites).filter((s) => this.canSee(user, s)).sort((a, b) => a.name.localeCompare(b.name)).map((s) => this.view(s, user));
  }

  // ---- lifecycle -------------------------------------------------------------
  create(user, { name, team, description = '' }, ip) {
    name = String(name ?? '').trim().toLowerCase();
    if (!SITE_RE.test(name)) throw new HttpError(400, 'bad_site_name', 'Site names are DNS labels: lowercase letters, digits and "-", 1-63 characters.');
    if (RESERVED.has(name)) throw new HttpError(409, 'site_reserved', `"${name}" is reserved.`);
    if (this.store.data.sites[name]) throw new HttpError(409, 'site_exists', `The site name "${name}" is taken.`);
    const owner = this.ownerFor(user, team);
    const count = Object.values(this.store.data.sites).filter((s) => s.owner.type === owner.type && s.owner.name === owner.name).length;
    this.billing?.check(`${owner.type}:${owner.name}`, 'sites', count);
    const site = { name, owner, description: String(description).slice(0, 300), createdAt: this.clock(), createdBy: user.username, deploys: [], activeDeploy: null, config: {} };
    this.store.tx((d) => {
      d.sites[name] = site;
      this.store.audit({ userId: user.id, event: 'site.created', ip, site: name, owner: `${owner.type}:${owner.name}` });
    });
    return site;
  }

  /** Store a deploy from a gzipped tarball (files rooted at package/). */
  deploy(user, name, { tarball, activate = true, source = 'upload', jobId = null }, ip) {
    const site = user ? this.manageable(user, name) : this.get(name);
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No site tarball was sent.');
    if (tarball.length > this.config.hosting.maxSiteBytes) throw new HttpError(413, 'too_large', 'Site is too large.');
    let files;
    try { files = unpackFiles(tarball, { maxBytes: this.config.hosting.maxSiteBytes * 4 }); } catch (err) {
      throw new HttpError(400, 'bad_tarball', `Invalid site tarball: ${err.message}`);
    }
    if (!files.length) throw new HttpError(400, 'empty_site', 'The site has no files.');
    const config = parseSiteConfig(files.find((f) => f.path === SITE_CONFIG)?.data);
    const id = `${new Date(this.clock()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(this.root, site.name, id);
    extractTo(files.filter((f) => f.path !== SITE_CONFIG), dir);
    const record = {
      id, createdAt: this.clock(), by: user?.username ?? `ci:${jobId}`, source, jobId,
      files: files.length, size: tarball.length, integrity: `sha256-${sha256(tarball)}`, config,
    };
    this.store.tx((d) => {
      const s = d.sites[site.name];
      s.deploys.push(record);
      if (activate) { s.activeDeploy = id; s.config = config; }
      this.store.audit({ userId: user?.id, event: 'site.deployed', ip, site: site.name, deploy: id, source });
    });
    this.prune(site.name);
    return record;
  }

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

  remove(user, name, ip) {
    const site = this.manageable(user, name);
    this.store.tx((d) => {
      delete d.sites[site.name];
      for (const [h, dom] of Object.entries(d.domains)) if (dom.site === site.name) delete d.domains[h];
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

  isHostingHost(host) {
    host = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    // Registered custom domains belong to hosting even before they verify, so they never reach the UI.
    return this.config.hosting.domains.some((d) => host === d || host.endsWith(`.${d}`)) || Boolean(this.store.data.domains[host]);
  }

  /** Function route for this path, if the site maps one. */
  routeFor(site, pathname) {
    for (const [pattern, fn] of Object.entries(site.config?.routes ?? {})) {
      if (pattern.endsWith('*') ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern) return fn;
    }
    return null;
  }

  /** Resolve a URL path to a file in the active deploy, or null. */
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

  notFoundFile(site) {
    if (!site.activeDeploy) return null;
    const base = path.join(this.root, site.name, site.activeDeploy);
    const f = path.resolve(base, site.config?.notFound ?? '404.html');
    return f.startsWith(base + path.sep) && fs.existsSync(f) ? f : null;
  }

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

/** Where a request for a custom-domain challenge should look. */
export const challengeName = (hostname) => `_gitcha-challenge.${hostname}`;
