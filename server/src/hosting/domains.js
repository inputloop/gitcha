// Custom domains for hosted sites. Ownership is proven with a DNS TXT record
// at _gitcha-challenge.<hostname>; until it verifies, nothing is served for it
// and no TLS certificate may be requested for it.
import crypto from 'node:crypto';
import dns from 'node:dns';
import { HttpError } from '../errors.js';
import { challengeName } from './sites.js';

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export class DomainService {
  constructor({ store, config, sites, clock = Date.now, resolver = dns.promises }) {
    Object.assign(this, { store, config, sites, clock, resolver });
  }

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

  instructions(dom) {
    const target = this.config.hosting.cnameTarget ?? (this.config.hosting.domains[0] ? `${dom.site}.${this.config.hosting.domains[0]}` : null);
    return {
      txt: { name: challengeName(dom.hostname), value: dom.token },
      cname: target ? { name: dom.hostname, value: target } : null,
      note: 'Add the TXT record, point the name at this instance (CNAME, or A/AAAA for an apex domain), then verify.',
    };
  }

  view(dom) {
    return { hostname: dom.hostname, site: dom.site, verified: dom.verified, verifiedAt: dom.verifiedAt ?? null, addedAt: dom.addedAt, dns: this.instructions(dom) };
  }

  forSite(site) {
    return Object.values(this.store.data.domains).filter((d) => d.site === site.name).map((d) => this.view(d));
  }

  add(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    const existing = this.store.data.domains[h];
    if (existing && existing.site !== site.name) throw new HttpError(409, 'domain_taken', `${h} is attached to another site.`);
    if (existing) return this.view(existing);
    const dom = { hostname: h, site: site.name, token: `gitcha-verify=${crypto.randomBytes(16).toString('hex')}`, verified: false, addedAt: this.clock(), addedBy: user.username };
    this.store.tx((d) => {
      d.domains[h] = dom;
      this.store.audit({ userId: user.id, event: 'domain.added', ip, site: site.name, domain: h });
    });
    return this.view(dom);
  }

  async verify(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    const dom = this.store.data.domains[h];
    if (!dom || dom.site !== site.name) throw new HttpError(404, 'domain_not_found', `${h} is not attached to ${site.name}.`);
    let records = [];
    try {
      records = (await this.resolver.resolveTxt(challengeName(h))).map((parts) => parts.join(''));
    } catch (err) {
      throw new HttpError(409, 'dns_not_ready', `No TXT record found at ${challengeName(h)} yet (${err.code ?? err.message}). DNS changes can take a while.`);
    }
    if (!records.includes(dom.token)) {
      throw new HttpError(409, 'dns_mismatch', `The TXT record at ${challengeName(h)} does not contain ${dom.token}.`);
    }
    this.store.tx((d) => {
      Object.assign(d.domains[h], { verified: true, verifiedAt: this.clock() });
      this.store.audit({ userId: user.id, event: 'domain.verified', ip, site: site.name, domain: h });
    });
    return this.view(this.store.data.domains[h]);
  }

  remove(user, siteName, hostname, ip) {
    const site = this.sites.manageable(user, siteName);
    const h = this.normalize(hostname);
    if (this.store.data.domains[h]?.site !== site.name) throw new HttpError(404, 'domain_not_found', `${h} is not attached to ${site.name}.`);
    this.store.tx((d) => {
      delete d.domains[h];
      this.store.audit({ userId: user.id, event: 'domain.removed', ip, site: site.name, domain: h });
    });
    return { removed: h };
  }

  /** For a TLS proxy's on-demand "ask" hook: may a certificate be issued for this name? */
  tlsAllowed(hostname) {
    const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
    if (h === new URL(this.config.publicUrl).hostname) return true;
    return Boolean(this.sites.siteForHost(h));
  }
}
