// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Gitcha ring: a webring of independent Gitcha instances. Each instance
// publishes /.well-known/gitcha-ring.json describing itself (including any
// paid features it offers) and lists the peers it links to. Peers come from
// configuration or from announcements an admin has approved. Nothing a peer
// says is trusted beyond being shown, escaped, as a link.
import { HttpError } from '../errors.js';

export const RING_PATH = '/.well-known/gitcha-ring.json';
const MAX_MANIFEST = 64 * 1024;

export function normalizePeerUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new HttpError(400, 'bad_url', `"${url}" is not a URL.`); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new HttpError(400, 'bad_url', 'Ring members must be plain http(s) URLs.');
  return u.origin;
}

function clean(s, n) { return typeof s === 'string' ? s.slice(0, n) : ''; }

/** Keep only the fields we show, with sane types and lengths. */
export function sanitizeManifest(m, origin) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  const features = {};
  for (const k of ['packages', 'teams', 'hosting', 'ci', 'functions']) features[k] = Boolean(m.features?.[k]);
  const paid = Array.isArray(m.features?.paid) ? m.features.paid.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 60)) : [];
  return {
    url: origin, name: clean(m.name, 80) || origin, description: clean(m.description, 300), operator: clean(m.operator, 120),
    version: clean(m.version, 20), features, paid,
  };
}

export class RingService {
  constructor({ store, config, version, features, clock = Date.now, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { store, config, version, features, clock, fetchImpl });
    this.self = new URL(config.publicUrl).origin;
  }

  manifest() {
    return {
      format: 'gitcha-ring', formatVersion: 1,
      name: this.config.ring.name, description: this.config.ring.description, operator: this.config.ring.operator,
      url: this.self, version: this.version, features: this.features(),
      ring: { members: this.memberUrls() },
    };
  }

  memberUrls() {
    const approved = Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'approved').map((a) => a.url);
    return [...new Set([...this.config.ring.peers.map((p) => { try { return normalizePeerUrl(p); } catch { return null; } }).filter(Boolean), ...approved])]
      .filter((u) => u !== this.self).sort();
  }

  /** The ring in a stable order with ourselves placed in it, for prev/next. */
  order() {
    return [...new Set([this.self, ...this.memberUrls()])].sort();
  }

  neighbour(step) {
    const o = this.order();
    if (o.length < 2) return this.self;
    const i = o.indexOf(this.self);
    return o[(i + step + o.length) % o.length];
  }

  random(rand = Math.random) {
    const others = this.memberUrls();
    return others.length ? others[Math.floor(rand() * others.length)] : this.self;
  }

  members() {
    return this.memberUrls().map((url) => ({ url, ...(this.store.data.ring.peers[url] ?? {}), url }));
  }

  async fetchPeer(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetchImpl(url + RING_PATH, { signal: ctrl.signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': `gitcha-ring/${this.version}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_MANIFEST) throw new Error('manifest too large');
      return sanitizeManifest(JSON.parse(text), url);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Refresh what we know about each member. Failures are recorded, not thrown. */
  async refresh() {
    const results = {};
    for (const url of this.memberUrls()) {
      try {
        results[url] = { ...(await this.fetchPeer(url)), seenAt: this.clock(), ok: true };
      } catch (err) {
        results[url] = { ...(this.store.data.ring.peers[url] ?? { url, name: url }), ok: false, error: String(err.message).slice(0, 200), checkedAt: this.clock() };
      }
    }
    this.store.tx((d) => { d.ring.peers = results; });
    return results;
  }

  /** Another instance asks to be listed. An admin approves it before it appears. */
  async announce(url, ip) {
    const origin = normalizePeerUrl(url);
    if (origin === this.self) throw new HttpError(400, 'self', 'That is this instance.');
    const existing = this.store.data.ring.announcements[origin];
    if (existing) return { url: origin, status: existing.status };
    if (Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'pending').length >= 200) {
      throw new HttpError(429, 'ring_busy', 'Too many pending ring requests; try later.');
    }
    let info;
    try { info = await this.fetchPeer(origin); } catch (err) {
      throw new HttpError(400, 'ring_unreachable', `Could not read ${origin}${RING_PATH}: ${err.message}`);
    }
    this.store.tx((d) => {
      d.ring.announcements[origin] = { url: origin, name: info.name, status: 'pending', at: this.clock(), ip };
    });
    return { url: origin, status: 'pending' };
  }

  decide(admin, url, approve, ip) {
    if (admin.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only an administrator can manage the ring.');
    const origin = normalizePeerUrl(url);
    if (!this.store.data.ring.announcements[origin]) throw new HttpError(404, 'not_found', `No ring request from ${origin}.`);
    this.store.tx((d) => {
      d.ring.announcements[origin].status = approve ? 'approved' : 'declined';
      this.store.audit({ userId: admin.id, event: approve ? 'ring.approved' : 'ring.declined', ip, peer: origin });
    });
    return { url: origin, status: approve ? 'approved' : 'declined' };
  }

  pending() {
    return Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'pending');
  }
}
