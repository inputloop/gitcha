// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Custom domains for hosted sites (for example, serving a site at www.example.com).
// You prove you own a domain with a DNS TXT record (a short text note you can
// publish in your domain's settings) at _gitcha-challenge.<hostname>.
// Until it verifies, nothing is served for the name, and no TLS certificate
// (what makes https work) may be requested for it.
// A claim is only a claim. It is held pending, one per site, so nobody's claim
// blocks the real owner's. It expires, and it becomes the domain's record only
// when the server sees its TXT proof. The server checks a verified domain again
// on a schedule and drops it when the proof is gone.
// Store: data.domains holds verified records by hostname. data.domainClaims
// holds pending claims by hostname, then by site name.
import crypto from 'node:crypto';
import dns from 'node:dns';
import { HttpError } from '../errors.js';
import { challengeName } from './sites.js';

// A valid DNS name: 4 to 253 characters, labels of up to 63, at least one dot.
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// Careful defaults the keepers can change (config.hosting.*). A pending claim
// lives one day. An account may hold 10 pending and 25 in all. A verified domain
// is dropped after 3 failed re-checks in a row. Re-checks run every 6 hours.
const PENDING_TTL = 24 * 3600_000;
const MAX_PENDING = 10;
const MAX_DOMAINS = 25;
const RECHECK_FAILURES = 3;
const CERT_BUDGET = 10; // new site-subdomain certificates one owner may have ordered in a week
export const RECHECK_EVERY = 6 * 3600_000;
const GONE = new Set(['ENOTFOUND', 'ENODATA']); // DNS said the record is not there (a timeout or SERVFAIL says nothing)

/**
 * Adds, verifies, re-checks and removes custom domains, and answers the TLS
 * proxy's "may I get a certificate?" question.
 */
export class DomainService {
  constructor({ store, config, sites, clock = Date.now, resolver = dns.promises }) {
    Object.assign(this, { store, config, sites, clock, resolver });
    store.data.domainClaims ??= {};
    this.certOrders = new Map();
    // Old data from before claims existed: turn each unverified record into a pending claim.
    for (const [h, dom] of Object.entries(store.data.domains)) {
      if (dom.verified) continue;
      (store.data.domainClaims[h] ??= {})[dom.site] = { token: dom.token, addedAt: dom.addedAt, addedBy: dom.addedBy, owner: this.ownerOf(dom.site), expiresAt: dom.addedAt + PENDING_TTL };
      delete store.data.domains[h];
    }
  }

  // "user:name" or "team:name" for the account that owns a site, or null.
  ownerOf(siteName) {
    const s = this.store.data.sites[siteName];
    return s ? `${s.owner.type}:${s.owner.name}` : null;
  }

  // Clean up a hostname (lowercase, no trailing dot) and refuse names that are
  // not valid, or that belong to this instance or its hosting domains. Those
  // names are not anyone's to claim.
  normalize(hostname) {
    const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(h)) throw new HttpError(400, 'bad_hostname', `"${hostname}" is not a valid domain name.`);
    const ui = new URL(this.config.publicUrl).hostname;
    if (h === ui || h.endsWith(`.${ui}`)) throw new HttpError(400, 'bad_hostname', 'That name belongs to this Gitcha instance.');
    for (const d of this.config.hosting.domains) {
      if (h === d || h.endsWith(`.${d}`)) throw new HttpError(400, 'bad_hostname', `Names under ${d} are assigned automatically from the site name.`);
    }
    return h;
  }

  // The DNS records the owner must add: the TXT proof, and a CNAME (a DNS alias) to point the name here.
  instructions(dom, siteName = dom.site) {
    const target = this.config.hosting.cnameTarget ?? (this.config.hosting.domains[0] ? `${siteName}.${this.config.hosting.domains[0]}` : null);
    return {
      txt: { name: challengeName(dom.hostname), value: dom.token },
      cname: target ? { name: dom.hostname, value: target } : null,
      note: 'Add the TXT record, point the name at this instance (CNAME, or A/AAAA for an apex domain), then verify.',
    };
  }

  // The API shape of a domain record or claim.
  view(dom, siteName = dom.site) {
    return {
      hostname: dom.hostname, site: siteName, verified: Boolean(dom.verified), verifiedAt: dom.verifiedAt ?? null, addedAt: dom.addedAt,
      ...(dom.verified ? {} : { expiresAt: dom.expiresAt }), dns: this.instructions(dom, siteName),
    };
  }

  /** Pending claims for a name. It deletes expired claims, and claims for deleted sites, as it goes. */
  claimsFor(h) {
    const all = this.store.data.domainClaims[h];
    if (!all) return {};
    const now = this.clock();
    let changed = false;
    for (const [site, c] of Object.entries(all)) if (c.expiresAt < now || !this.store.data.sites[site]) { delete all[site]; changed = true; }
    if (!Object.keys(all).length) { delete this.store.data.domainClaims[h]; changed = true; }
    if (changed) this.store.flush();
    return this.store.data.domainClaims[h] ?? {};
  }

  // Every domain and claim for one site.
  forSite(site) {
    const out = Object.values(this.store.data.domains).filter((d) => d.site === site.name).map((d) => this.view(d));
    for (const h of Object.keys(this.store.data.domainClaims)) {
      const c = this.claimsFor(h)[site.name];
      if (c) out.push(this.view({ hostname: h, site: site.name, ...c }));
    }
    return out;
  }

  /** Count the names (verified or pending) an account holds, and how many are still only claims. */
  holdings(owner) {
    let all = 0;
    let pending = 0;
    for (const d of Object.values(this.store.data.domains)) if (this.ownerOf(d.site) === owner) all++;
    for (const h of Object.keys(this.store.data.domainClaims)) {
      for (const c of Object.values(this.claimsFor(h))) if (c.owner === owner) { all++; pending++; }
    }
    return { all, pending };
  }

  // Start a claim for a hostname: make a random token for the TXT record and
  // save a pending claim. Adding the same name twice returns the one already there.
  add(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    const held = this.store.data.domains[h];
    if (held?.site === site.name) return this.view(held);
    const mine = this.claimsFor(h)[site.name];
    if (mine) return this.view({ hostname: h, site: site.name, ...mine });
    // A verified record keeps its name until a newer proof (control of DNS)
    // replaces it. A pending claim never blocks anyone.
    const owner = `${site.owner.type}:${site.owner.name}`;
    const have = this.holdings(owner);
    if (have.pending >= (this.config.hosting.maxPendingDomains ?? MAX_PENDING)) throw new HttpError(429, 'too_many_pending', 'Too many domains are waiting for verification; verify or remove some first.');
    if (have.all >= (this.config.hosting.maxDomains ?? MAX_DOMAINS)) throw new HttpError(429, 'too_many_domains', 'This account holds as many custom domains as it may.');
    const claim = { token: `gitcha-verify=${crypto.randomBytes(16).toString('hex')}`, addedAt: this.clock(), addedBy: user.username, owner, expiresAt: this.clock() + (this.config.hosting.pendingTtl ?? PENDING_TTL) };
    this.store.tx((d) => {
      (d.domainClaims[h] ??= {})[site.name] = claim;
      this.store.audit({ userId: user.id, event: 'domain.added', ip, site: site.name, domain: h });
    });
    return this.view({ hostname: h, site: site.name, ...claim });
  }

  // Look up the TXT records at the challenge name and check for the token.
  // A long TXT record can come in parts, so the parts are joined first.
  async txtHas(h, token) {
    const records = (await this.resolver.resolveTxt(challengeName(h))).map((parts) => parts.join(''));
    return records.includes(token);
  }

  // Check the DNS proof for a claim. If the token is there, the claim becomes
  // the domain's verified record.
  async verify(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    const held = this.store.data.domains[h];
    if (held?.site === site.name) return this.view(held);
    const claim = this.claimsFor(h)[site.name];
    if (!claim) throw new HttpError(404, 'domain_not_found', `${h} is not attached to ${site.name}.`);
    let seen;
    try {
      seen = await this.txtHas(h, claim.token);
    } catch (err) {
      throw new HttpError(409, 'dns_not_ready', `No TXT record found at ${challengeName(h)} yet (${err.code ?? err.message}). DNS changes can take a while.`);
    }
    if (!seen) throw new HttpError(409, 'dns_mismatch', `The TXT record at ${challengeName(h)} does not contain ${claim.token}.`);
    // The first to prove control of the name holds it. A proof that arrives
    // later, while the name still points at someone else's site, means the name
    // changed hands. The new proof wins and the takeover is written to the audit log.
    this.store.tx((d) => {
      const prior = d.domains[h];
      d.domains[h] = { hostname: h, site: site.name, token: claim.token, verified: true, verifiedAt: this.clock(), addedAt: claim.addedAt, addedBy: claim.addedBy, checkedAt: this.clock(), failures: 0 };
      delete d.domainClaims[h];
      this.store.audit({ userId: user.id, event: 'domain.verified', ip, site: site.name, domain: h });
      if (prior) this.store.audit({ userId: user.id, event: 'domain.taken_over', ip, site: prior.site, domain: h, by: site.name });
    });
    return this.view(this.store.data.domains[h]);
  }

  // Remove a site's verified record and/or pending claim for a name.
  remove(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    const hasRecord = this.store.data.domains[h]?.site === site.name;
    const hasClaim = Boolean(this.claimsFor(h)[site.name]);
    if (!hasRecord && !hasClaim) throw new HttpError(404, 'domain_not_found', `${h} is not attached to ${site.name}.`);
    this.store.tx((d) => {
      if (hasRecord) delete d.domains[h];
      if (hasClaim) { delete d.domainClaims[h][site.name]; if (!Object.keys(d.domainClaims[h]).length) delete d.domainClaims[h]; }
      this.store.audit({ userId: user.id, event: 'domain.removed', ip, site: site.name, domain: h });
    });
    return { removed: h };
  }

  /**
   * Look at every verified domain again. When a name's proof is gone for
   * several checks in a row, the server stops serving it and it may no longer
   * get a certificate. A DNS error that does not say "not there" (like a
   * timeout) counts for nothing either way.
   */
  async recheck() {
    const limit = this.config.hosting.recheckFailures ?? RECHECK_FAILURES;
    for (const dom of Object.values(this.store.data.domains)) {
      if (!dom.verified) continue;
      let outcome;
      try { outcome = (await this.txtHas(dom.hostname, dom.token)) ? 'ok' : 'gone'; } catch (err) { outcome = GONE.has(err.code) ? 'gone' : 'unknown'; }
      if (outcome === 'unknown' || !this.store.data.domains[dom.hostname]) continue;
      this.store.tx((d) => {
        const rec = d.domains[dom.hostname];
        rec.checkedAt = this.clock();
        rec.failures = outcome === 'ok' ? 0 : (rec.failures ?? 0) + 1;
        if (rec.failures >= limit) {
          delete d.domains[dom.hostname];
          this.store.audit({ event: 'domain.lapsed', site: rec.site, domain: rec.hostname });
        }
      });
    }
  }

  /** Run recheck() on a schedule. Calling it twice starts only one timer. stop() ends it. The timer never keeps the process alive. */
  startRecheck(every = this.config.hosting.recheckEvery ?? RECHECK_EVERY) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.recheck().catch((err) => console.error('domain recheck failed', err.message)); }, every);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /**
   * For a TLS proxy's on-demand "ask" hook: may a certificate be issued for
   * this name? Always yes for this instance's own names and for custom domains
   * whose proof is still good. For a site's subdomain, which anyone can make,
   * yes only while its owner is inside a weekly budget of new names. That is
   * because a public CA (the company that issues certificates) limits how many
   * one registered domain may order. The real answer to that limit is one
   * wildcard certificate per hosting domain (DEPLOY.md); then Caddy never asks for these.
   */
  tlsAllowed(hostname) {
    const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
    if (h === new URL(this.config.publicUrl).hostname) return true;
    const cname = this.config.hosting.cnameTarget;
    if (cname && h === String(cname).toLowerCase()) return true;
    if (this.store.data.domains[h]?.verified) return true;
    const site = this.sites.siteForHost(h);
    return site ? this.withinCertBudget(site, h) : false;
  }

  // Allow at most certBudget (default 10) new subdomain certificates per owner per week.
  // The count lives in memory on purpose: nobody who can order certificates can
  // restart the server to clear it.
  withinCertBudget(site, h) {
    const week = 7 * 24 * 3600_000;
    const limit = this.config.hosting.certBudget ?? CERT_BUDGET;
    const owner = `${site.owner.type}:${site.owner.name}`;
    const now = this.clock();
    const prior = this.certOrders.get(h);
    if (prior && now - prior.at < week) return true; // asked about already; not a new order
    let used = 0;
    for (const [name, o] of this.certOrders) {
      if (now - o.at >= week) this.certOrders.delete(name);
      else if (o.owner === owner) used++;
    }
    if (used >= limit) return false;
    this.certOrders.set(h, { owner, at: now });
    return true;
  }
}
