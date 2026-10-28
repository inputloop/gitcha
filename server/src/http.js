// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Small HTTP helpers: routing, bodies, cookies, security headers.
import net from 'node:net';
import { HttpError } from './errors.js';

export class Router {
  constructor() { this.routes = []; }
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

export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

export async function readForm(req, limit = 64 * 1024) {
  return Object.fromEntries(new URLSearchParams((await readBody(req, limit)).toString('utf8')));
}

/**
 * A cookie we cannot decode keeps its raw text rather than failing the request: another app on a sibling
 * subdomain can plant `a=%`, and that must not turn every page for the browser into an error.
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

/** The request target as a URL on a fixed base. `//x/y` stays a path; anything that is not a path is a 400. */
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
 * Last resort for anything that escapes a handler: log it and keep serving. The request handler catches its own
 * errors; this is for what no handler owns (a socket error with no listener, a rejection nobody awaited), so one
 * stranger's request can never become an outage for everyone.
 */
export function installLastResort(proc = process, log = console.error) {
  const keep = (kind) => (err) => log(`gitcha: ${kind} (kept serving): ${err?.stack ?? err}`);
  proc.on('unhandledRejection', keep('unhandled rejection'));
  proc.on('uncaughtException', keep('uncaught exception'));
}

export function cookie(name, value, { maxAge, secure, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return c;
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

export function html(res, status, body, headers) {
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

export function redirect(res, location, headers = {}) {
  send(res, 303, '', { Location: location, ...headers });
}

// ---- addresses --------------------------------------------------------------------

/**
 * Parse an IPv4 or IPv6 address (optionally `[v6]:port`, `v4:port` or with a `%zone`) to 16 bytes, v4 as its
 * IPv4-mapped form. Returns { bytes, v4, text } or null when it is not an address.
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

/** RFC 5952 text: lowercase, no leading zeros, the longest run of zero groups (two or more) as "::". */
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

/** Does `ip` (a parsed address) fall inside `net` ({ bytes, bits } over the 128-bit space)? */
function inNet(ip, { bytes, bits }) {
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip.bytes[i] & mask) !== (bytes[i] & mask)) return false;
  }
  return true;
}

/**
 * Read GITCHA_TRUSTED_PROXIES: unset means one proxy in front (a hop count of 1); a whole number is a hop count;
 * anything else is a comma list of addresses or CIDR ranges, which are the proxies we trust.
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
    return { bytes: ip.bytes, bits: ip.v4 ? n + 96 : n };
  });
  return { nets };
}

/**
 * The client's address. Without a proxy it is the socket's peer. With `trustProxy` on, the chain is the
 * X-Forwarded-For entries followed by the peer; a hop count takes the entry that many hops from the right (so
 * one proxy: the entry it appended), and a list walks from the right past trusted proxies. Anything a client
 * typed to the left of that point is never used, and an entry that is not an address falls back to the peer.
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
