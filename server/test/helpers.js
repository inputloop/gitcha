import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { totp } from '../src/totp.js';

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

export async function startServer({ env = {}, overrides = {}, clock = fakeClock() } = {}) {
  const config = loadConfig({ GITCHA_PORT: '0', ...env }, { dataDir: tmpDir(), ...overrides });
  const app = createApp(config, { clock });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, url, clock, close: () => new Promise((r) => app.server.close(r)) };
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
