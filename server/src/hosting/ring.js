// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Gitcha ring: a webring (a loop of sites that link to each other) of
// independent Gitcha instances. Each instance publishes
// /.well-known/gitcha-ring.json. That file describes the instance (including
// any paid features it offers) and lists the peers it links to. Peers come from
// configuration, or from announcements an admin has approved. Nothing a peer
// says is trusted. It is only shown, escaped, as a link.
// Store: data.ring.announcements (join requests by origin) and data.ring.peers
// (what the last refresh learned about each member).
import dns from 'node:dns';
import net from 'node:net';
import { HttpError } from '../errors.js';

export const RING_PATH = '/.well-known/gitcha-ring.json';
// A peer's manifest may be at most 64 KB.
const MAX_MANIFEST = 64 * 1024;

/**
 * Turn a peer URL into its origin (scheme, host and port, like
 * "https://example.com"). Only plain http(s) is allowed, with no username or
 * password in the URL.
 */
export function normalizePeerUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new HttpError(400, 'bad_url', `"${url}" is not a URL.`); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new HttpError(400, 'bad_url', 'Ring members must be plain http(s) URLs.');
  return u.origin;
}

/**
 * Is this an address nobody on the public internet can be at? That covers
 * loopback (this machine), private networks, link-local, shared, multicast and
 * reserved ranges, for IPv4 and IPv6. Anything that is not a valid IP counts
 * as private, to be safe. IPv4 addresses written inside IPv6 are checked as IPv4.
 */
export function privateAddress(ip) {
  const v4 = (a) => {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && (y === 168 || (y === 0 && a.startsWith('192.0.0.')))) || (x === 198 && (y === 18 || y === 19));
  };
  if (net.isIPv4(ip)) return v4(ip);
  if (!net.isIPv6(ip)) return true;
  const low = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return v4(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low); // how URL prints a mapped IPv4 address
  if (hex) { const hi = parseInt(hex[1], 16); const lo = parseInt(hex[2], 16); return v4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  return low === '::' || low === '::1' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || low.startsWith('ff');
}

// Keep a value only if it is a string, cut to n characters.
function clean(s, n) { return typeof s === 'string' ? s.slice(0, n) : ''; }

/** Keep only the fields we show, with sane types and lengths. The url is always the origin we asked, never what the peer claims. */
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

/**
 * Builds this instance's manifest, keeps the member list, handles join
 * requests, and refreshes what is known about members.
 */
export class RingService {
  // `lookup` turns a peer's name into IP addresses before we call it. It is off
  // when a test supplies its own fetch.
  constructor({ store, config, version, features, clock = Date.now, fetchImpl = globalThis.fetch, lookup = fetchImpl === globalThis.fetch ? dns.promises.lookup : null }) {
    Object.assign(this, { store, config, version, features, clock, fetchImpl, lookup });
    this.self = new URL(config.publicUrl).origin;
  }

  // The manifest this instance publishes at RING_PATH.
  manifest() {
    return {
      format: 'gitcha-ring', formatVersion: 1,
      name: this.config.ring.name, description: this.config.ring.description, operator: this.config.ring.operator,
      url: this.self, version: this.version, features: this.features(),
      ring: { members: this.memberUrls() },
    };
  }

  // Configured peers plus approved announcements, without ourselves, sorted.
  memberUrls() {
    const approved = Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'approved').map((a) => a.url);
    return [...new Set([...this.config.ring.peers.map((p) => { try { return normalizePeerUrl(p); } catch { return null; } }).filter(Boolean), ...approved])]
      .filter((u) => u !== this.self).sort();
  }

  /** The ring in a stable order with ourselves placed in it, for prev/next. */
  order() {
    return [...new Set([this.self, ...this.memberUrls()])].sort();
  }

  // The member `step` places away from us in the loop (1 is next, -1 is previous).
  neighbour(step) {
    const o = this.order();
    if (o.length < 2) return this.self;
    const i = o.indexOf(this.self);
    return o[(i + step + o.length) % o.length];
  }

  // A random member, or ourselves when the ring is empty.
  random(rand = Math.random) {
    const others = this.memberUrls();
    return others.length ? others[Math.floor(rand() * others.length)] : this.self;
  }

  // Each member's URL with what the last refresh learned about it.
  members() {
    return this.memberUrls().map((url) => ({ url, ...(this.store.data.ring.peers[url] ?? {}), url }));
  }

  // Fetch and clean a peer's manifest. It gives up after 8 seconds, refuses
  // redirects (so a peer cannot send us somewhere else), and refuses manifests
  // over MAX_MANIFEST.
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

  /** Look at the members again on a schedule (config.ring.refresh): once soon after start (within 10 seconds), then every interval. */
  startRefresh(every = this.config.ring.refresh) {
    if (this.timer || !(every > 0)) return;
    const go = () => this.refresh().catch((err) => console.error('ring refresh failed', err.message));
    this.timer = setInterval(go, every);
    this.timer.unref();
    this.first = setTimeout(go, Math.min(every, 10_000));
    this.first.unref();
  }

  stop() { clearInterval(this.timer); clearTimeout(this.first); this.timer = this.first = null; }

  /**
   * A stranger asked us to call this address, so we only call public ones
   * (RING-2). Otherwise someone could use the server to reach machines on its
   * own private network. Names like "localhost" or ".local" are refused, and so
   * is a name if any of its IP addresses is private.
   */
  async assertPublic(origin) {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) { if (privateAddress(host)) throw new Error('not public'); return; }
    if (host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) throw new Error('not public');
    if (!this.lookup) return;
    const found = await this.lookup(host, { all: true });
    if (!found.length || found.some((a) => privateAddress(a.address))) throw new Error('not public');
  }

  /** Refresh what we know about each member. Failures are recorded, not thrown. If a refresh is already running, this returns that one. */
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshAll().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // Fetch every member in turn and replace data.ring.peers with the results.
  // A failed member keeps its old details, marked ok: false with the error.
  async refreshAll() {
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

  /**
   * Another instance asks to be listed. An admin approves it before it appears.
   * At most 200 requests may wait at once. The server must be able to fetch
   * the instance's manifest from a public address.
   */
  async announce(url, ip) {
    const origin = normalizePeerUrl(url);
    if (origin === this.self) throw new HttpError(400, 'self', 'That is this instance.');
    const existing = this.store.data.ring.announcements[origin];
    if (existing) return { url: origin, status: existing.status };
    if (Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'pending').length >= 200) {
      throw new HttpError(429, 'ring_busy', 'Too many pending ring requests; try later.');
    }
    // The same answer for every way this can fail, so nobody learns what is
    // behind an address by asking.
    const refused = new HttpError(400, 'ring_unreachable', `${origin} did not answer with a Gitcha ring manifest.`);
    let info;
    try { await this.assertPublic(origin); info = await this.fetchPeer(origin); } catch { throw refused; }
    this.store.tx((d) => {
      d.ring.announcements[origin] = { url: origin, name: info.name, status: 'pending', at: this.clock(), ip };
    });
    return { url: origin, status: 'pending' };
  }

  // An admin approves or declines a join request.
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

  // Join requests that still wait for an admin.
  pending() {
    return Object.values(this.store.data.ring.announcements).filter((a) => a.status === 'pending');
  }
}
