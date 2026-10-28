// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Small HTTP helpers: routing, bodies, cookies, security headers.
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

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}
