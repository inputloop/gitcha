// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Small HTTP helpers used by every part of the server: a router that matches URLs to handlers,
// readers for request bodies, cookie helpers, reply helpers that add security headers, and code
// that works out the real client address (IPv4 and IPv6, with or without a proxy in front).
import net from 'node:net';
import { HttpError } from './errors.js';

/**
 * Matches a request's method and path to a handler. A pattern like '/api/v1/packages/:name' turns
 * ':name' into a parameter. Routes are tried in the order they were added; the first match wins.
 */
export class Router {
  constructor() { this.routes = []; }
  /** Add a route. Each ':key' matches one path part (no '/'). A trailing '/' is allowed. */
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  /**
   * Find the route for a request. Returns { handler, params } or null. A HEAD request also matches a
   * GET route. A bad % escape in a parameter is a 400 error, not a crash.
   */
  match(method, pathname) {
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        throw new HttpError(400, 'bad_request', 'The address has a malformed % escape.');
      }
      return { handler: r.handler, params };
    }
    return null;
  }
}

/** Read the whole request body as bytes. Stops with a 413 error as soon as it grows past `limit` bytes. */
export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read the body as JSON (up to 1 MB by default). An empty body is {}. Bad JSON is a 400 error. */
export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

/** Read a web form body (name=value&...) into an object, up to 64 KB by default. */
export async function readForm(req, limit = 64 * 1024) {
  return Object.fromEntries(new URLSearchParams((await readBody(req, limit)).toString('utf8')));
}

/**
 * Read the Cookie header into { name: value }. A cookie we cannot decode keeps its raw text instead of
 * failing the request. Another app on a sibling subdomain can plant `a=%`, and that must not turn every
 * page into an error for that browser.
 */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep the raw text */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

/**
 * The request target as a URL on a fixed base (http://localhost). `//x/y` stays a path and is never read
 * as another host. Anything that is not a path is a 400 error.
 */
export function requestUrl(req) {
  const target = req.url ?? '';
  if (!target.startsWith('/')) throw new HttpError(400, 'bad_request', 'The request target must be a path.');
  try {
    return new URL('http://localhost' + target);
  } catch {
    throw new HttpError(400, 'bad_request', 'The request target is not a valid address.');
  }
}

/**
 * The last safety net for any error that escapes a handler: log it and keep serving. The request handler
 * catches its own errors. This is for errors no handler owns, such as a socket error with no listener or a
 * promise rejection nobody waited for. So one stranger's request can never take the site down for everyone.
 */
export function installLastResort(proc = process, log = console.error) {
  const keep = (kind) => (err) => log(`gitcha: ${kind} (kept serving): ${err?.stack ?? err}`);
  proc.on('unhandledRejection', keep('unhandled rejection'));
  proc.on('uncaughtException', keep('uncaught exception'));
}

/**
 * Build a Set-Cookie value. Every cookie is for the whole site (Path=/) and SameSite=Lax, so other sites
 * cannot send it along with most cross-site requests. HttpOnly (on by default) hides it from page scripts.
 * `secure` sends it over HTTPS only. `maxAge` is in milliseconds.
 */
export function cookie(name, value, { maxAge, secure, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return c;
}

/**
 * Headers sent with every reply. The Content-Security-Policy lets pages load scripts, styles and images
 * only from this site (images may also be inline data: URLs), and forms may post only to this site. No
 * other site may show our pages in a frame (this blocks clickjacking, where a site hides our page under
 * its own buttons). The rest stop content-type guessing, hide the referring
 * address, and turn off the camera, microphone and location.
 */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Send a reply with the security headers. Replies are not cached unless `headers` says otherwise. */
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Send an object as a JSON reply. */
export function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

/** Send an HTML page. */
export function html(res, status, body, headers) {
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

/** Send the browser to another address with a 303 (the browser follows it with a GET). */
export function redirect(res, location, headers = {}) {
  send(res, 303, '', { Location: location, ...headers });
}

// ---- addresses --------------------------------------------------------------------

/**
 * Read an IPv4 or IPv6 address into 16 bytes. It may have a port (`[v6]:port`, `v4:port`) or a `%zone`,
 * which are dropped. An IPv4 address is stored in its IPv4-mapped form (::ffff:a.b.c.d), so both kinds
 * can be compared the same way. Returns { bytes, v4, text } (text is one standard spelling), or null
 * when the input is not an address.
 */
export function parseIp(input) {
  let t = String(input ?? '').trim();
  if (!t || t.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(t);
  if (bracket) t = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(t)) t = t.slice(0, t.lastIndexOf(':'));
  t = t.replace(/%.*$/, '');
  const bytes = new Uint8Array(16);
  if (net.isIPv4(t)) {
    bytes[10] = 0xff; bytes[11] = 0xff;
    t.split('.').forEach((o, i) => { bytes[12 + i] = Number(o); });
    return { bytes, v4: true, text: t.split('.').map(Number).join('.') };
  }
  if (!net.isIPv6(t)) return null;
  const all = v6Groups(t);
  all.forEach((g, i) => { bytes[i * 2] = g >> 8; bytes[i * 2 + 1] = g & 0xff; });
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return { bytes, v4: true, text: Array.from(bytes.slice(12)).join('.') };
  return { bytes, v4: false, text: v6Text(all) };
}

/** The eight 16-bit groups of an IPv6 address that net.isIPv6 has already accepted. */
function v6Groups(t) {
  let tail = [];
  if (t.includes('.')) { // an IPv4 tail, as in ::ffff:1.2.3.4
    const cut = t.lastIndexOf(':');
    const o = t.slice(cut + 1).split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    t = t.slice(0, cut + 1);
    if (!t.endsWith('::')) t = t.slice(0, -1);
  }
  const part = (h) => (h ? h.split(':').map((g) => parseInt(g, 16)) : []);
  const halves = t.split('::');
  if (halves.length === 1) return part(halves[0]).concat(tail);
  const left = part(halves[0]);
  const right = part(halves[1]).concat(tail);
  return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/** IPv6 text in the RFC 5952 standard form: lowercase, no leading zeros, the longest run of two or more zero groups as "::". */
function v6Text(all) {
  const hex = (g) => g.toString(16);
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (all[i]) { i++; continue; }
    let j = i;
    while (j < 8 && !all[j]) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  if (best.len < 2) return all.map(hex).join(':');
  return `${all.slice(0, best.at).map(hex).join(':')}::${all.slice(best.at + best.len).map(hex).join(':')}`;
}

/**
 * Does `ip` (a parsed address) fall inside `net`? `net` is { bytes, bits }: the first `bits` bits of the
 * 128-bit address must match. Each byte is compared under a mask that keeps only the bits that count.
 */
function inNet(ip, { bytes, bits }) {
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip.bytes[i] & mask) !== (bytes[i] & mask)) return false;
  }
  return true;
}

/**
 * Read GITCHA_TRUSTED_PROXIES. Unset means one proxy in front (a hop count of 1). A whole number from 1 to 10 is
 * a hop count. Anything else is a comma list of addresses or CIDR ranges (like 10.0.0.0/8, meaning every address
 * that starts with the same first 8 bits), which are the proxies we trust. A bad entry throws an error.
 */
export function parseTrustedProxies(value) {
  const v = String(value ?? '').trim();
  if (!v) return { hops: 1 };
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops < 1 || hops > 10) throw new Error(`GITCHA_TRUSTED_PROXIES: a hop count must be 1 to 10, got "${v}"`);
    return { hops };
  }
  const nets = v.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [addr, len] = entry.split('/');
    const ip = parseIp(addr);
    if (!ip || addr.includes('[') || (len !== undefined && !/^\d{1,3}$/.test(len))) throw new Error(`GITCHA_TRUSTED_PROXIES: "${entry}" is not an address or range (use 10.0.0.0/8, 2001:db8::/32 or a hop count)`);
    const max = ip.v4 ? 32 : 128;
    const n = len === undefined ? max : Number(len);
    if (n > max) throw new Error(`GITCHA_TRUSTED_PROXIES: "${entry}" has a prefix longer than ${max} bits`);
    return { bytes: ip.bytes, bits: ip.v4 ? n + 96 : n }; // a v4 range sits after the 96-bit ::ffff: prefix
  });
  return { nets };
}

/**
 * The client's address, used for rate limits, audit rows and network checks. Without a proxy it is the
 * socket's peer (the machine directly connected). With `trustProxy` on, the chain is the X-Forwarded-For
 * entries followed by the peer. A hop count takes the entry that many hops from the right (so with one
 * proxy: the entry it added). A list walks from the right past trusted proxies. Anything a client typed to
 * the left of that point is never used, because a client can write any text there. An entry that is not an
 * address falls back to the peer. Only the last 20 entries are read.
 */
export function clientIp(req, trustProxy, trusted = { hops: 1 }) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return peer;
  const header = req.headers['x-forwarded-for'];
  if (!header) return peer;
  const entries = String(header).split(',').map((s) => s.trim()).filter(Boolean).slice(-20);
  const chain = [...entries, peer];
  let pick;
  if (trusted.nets) {
    const isTrusted = (e) => { const ip = parseIp(e); return Boolean(ip) && trusted.nets.some((n) => inNet(ip, n)); };
    if (!isTrusted(peer)) return peer; // a direct client: its header is its own business
    let i = chain.length - 1;
    while (i > 0 && isTrusted(chain[i])) i--;
    pick = chain[i];
  } else {
    pick = chain[Math.max(0, chain.length - 1 - trusted.hops)];
  }
  return parseIp(pick)?.text ?? peer;
}
