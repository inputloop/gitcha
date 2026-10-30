// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { totp } from '../src/totp.js';
import { CassandraBackend, fromRows } from '../src/store-cassandra.js';

/** A controllable clock so tests can fast-forward past 2FA intervals. */
export function fakeClock(start = Date.now()) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

export function tmpDir(prefix = 'gitcha-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * GITCHA_TEST_STORE=cassandra (with GITCHA_TEST_CASSANDRA=host:port) runs a test's servers on that Cassandra
 * cluster, each in an instance of its own. Tests that read db.json themselves only make sense on the file store.
 */
function testStoreEnv() {
  if (process.env.GITCHA_TEST_STORE !== 'cassandra') return {};
  return {
    GITCHA_STORE: 'cassandra', GITCHA_CASSANDRA_CONTACT_POINTS: process.env.GITCHA_TEST_CASSANDRA ?? '127.0.0.1',
    GITCHA_CASSANDRA_KEYSPACE: 'gitcha_test', GITCHA_CASSANDRA_INSTANCE: `t${crypto.randomBytes(6).toString('hex')}`,
  };
}

export async function startServer({ env = {}, overrides = {}, clock = fakeClock(), appOpts = {} } = {}) {
  const config = loadConfig({ GITCHA_PORT: '0', ...testStoreEnv(), ...env }, { dataDir: tmpDir(), ...overrides });
  const app = createApp(config, { clock, ...appOpts });
  const watch = process.env.GITCHA_UNSAVED_LOG || process.env.GITCHA_STRICT_STORE ? watchUnsavedWrites(app.store, process.env.GITCHA_UNSAVED_LOG) : null;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => {
    await new Promise((r) => app.server.close(r));
    reportUnsaved(app.store);
    // npm run test:strict: a write the server made outside a save fails the test that caused it.
    if (process.env.GITCHA_STRICT_STORE && watch?.writes.length) {
      throw new Error(`the server changed data without saving it:\n  ${[...new Set(watch.writes)].join('\n  ')}`);
    }
  };
  return { ...app, url, clock, close };
}

/** What the store's backend holds now, read back from db.json or, on Cassandra, from the cluster: memory is not the proof. */
export function persisted(store) {
  if (store.backend instanceof CassandraBackend) return fromRows(new Map(store.backend.call('load', {}).rows));
  return JSON.parse(fs.readFileSync(store.file, 'utf8'));
}

/** Paths where memory and the saved database disagree: a change that was made but never saved. */
export function unsavedPaths(store) {
  const disk = persisted(store);
  const mem = JSON.parse(JSON.stringify(store.data));
  const out = [];
  const walk = (a, b, at) => {
    if (out.length > 20) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${at}.${k}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at);
  };
  walk(mem, disk, 'data');
  return out;
}

/**
 * For finding bugs, not for normal runs: wrap the store's data so that every write made outside
 * store.tx (or the store's own restore) is logged with the line of code that made it. Such a write
 * stays in memory only until some later save, and is lost if the server stops first.
 */
export function watchUnsavedWrites(store, logFile) {
  let saving = 0;
  const writes = [];
  for (const m of ['tx', 'flush', 'restore']) {
    const orig = store[m].bind(store);
    store[m] = (...a) => { saving++; try { return orig(...a); } finally { saving--; } };
  }
  const proxies = new WeakMap(), targets = new WeakMap();
  const note = (at) => {
    if (saving) return;
    const stack = new Error().stack.split('\n');
    const where = (stack.find((l) => l.includes('/server/src/') && !l.includes('/store.js')) ?? '?').trim();
    // Writes from a test itself (setting up a scene) are not the server's. Billing's atomically() puts its
    // state back after a failed save; that undo is meant to stay out of the file.
    if (where !== '?' && !stack.some((l) => l.includes('atomically'))) writes.push(`${at} (${where})`);
    if (logFile) fs.appendFileSync(logFile, `${process.argv[1]}\t${at}\t${where}\n`);
  };
  const wrap = (obj, at) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (targets.has(obj)) return obj;
    if (proxies.has(obj)) return proxies.get(obj);
    const p = new Proxy(obj, {
      get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof k === 'string' ? wrap(v, `${at}.${k}`) : v; },
      set: (t, k, v) => { note(`${at}.${String(k)}`); return Reflect.set(t, k, targets.get(v) ?? v); },
      deleteProperty: (t, k) => { note(`${at}.${String(k)} (delete)`); return Reflect.deleteProperty(t, k); },
    });
    proxies.set(obj, p); targets.set(p, obj);
    return p;
  };
  store.data = wrap(store.data, 'data');
  // structuredClone cannot copy a Proxy; copy through JSON instead (the store holds JSON data only).
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (v, o) => { try { return clone(v, o); } catch { return v === undefined ? v : JSON.parse(JSON.stringify(v)); } };
  return { writes };
}

function reportUnsaved(store) {
  if (!process.env.GITCHA_UNSAVED_LOG || !fs.existsSync(store.file)) return;
  const paths = unsavedPaths(store);
  if (paths.length) fs.appendFileSync(process.env.GITCHA_UNSAVED_LOG, `${process.argv[1]}\t${paths.join(' ')}\n`);
}

/** Register + enroll a user via the service layer; returns a code generator. */
export function createUser(app, username = 'alice', password = 'correct horse battery') {
  const reg = app.auth.register({ username, password, ip: '127.0.0.1' });
  app.auth.confirmEnrollment({ enrollToken: reg.enrollToken, code: totp(reg.secret, { now: app.clock() }), ip: '127.0.0.1' });
  // Each time step can only be used once, so move the clock on before each new code.
  const nextCode = () => { app.clock.advance(31_000); return totp(reg.secret, { now: app.clock() }); };
  return { username, password, secret: reg.secret, nextCode };
}

export async function api(url, method, p, { token, body } = {}) {
  const res = await fetch(url + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

export async function deviceLogin(srv, user) {
  const r1 = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: user.username, password: user.password } });
  const r2 = await api(srv.url, 'POST', '/api/v1/auth/login/mfa', { body: { ticket: r1.body.mfa_ticket, code: user.nextCode(), device_name: 'test' } });
  return r2.body.token;
}

/** Raw HTTP request with an explicit Host header (fetch cannot set Host). */
export function hostGet(url, host, path = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
