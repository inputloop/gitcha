import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { totp } from '../src/totp.js';

const HOUR = 3600_000;

test('registration requires completing 2FA enrollment before login', async () => {
  const srv = await startServer();
  try {
    const reg = srv.auth.register({ username: 'bob', password: 'a long passphrase', ip: '1.2.3.4' });
    assert.equal(reg.user.role, 'admin', 'first user is admin');
    const r = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'bob', password: 'a long passphrase' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'mfa_not_enrolled');
    assert.throws(() => srv.auth.confirmEnrollment({ enrollToken: reg.enrollToken, code: '000000', ip: 'x' }), /not valid/);
    const { recoveryCodes } = srv.auth.confirmEnrollment({ enrollToken: reg.enrollToken, code: totp(reg.secret, { now: srv.clock() }), ip: 'x' });
    assert.equal(recoveryCodes.length, 10);
  } finally { await srv.close(); }
});

test('passwords and TOTP secrets are never stored in plaintext', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'carol', 'super secret passphrase');
    const db = fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8');
    assert.ok(!db.includes('super secret passphrase'));
    assert.ok(!db.includes(u.secret), 'TOTP secret is encrypted');
    assert.ok(!db.includes('scrypt$'), 'password hash is itself encrypted at rest');
    const stored = srv.store.userByName('carol');
    assert.match(stored.passwordHash, /^v1\./);
    assert.match(stored.totpSecret, /^v1\./);
  } finally { await srv.close(); }
});

test('login needs password then TOTP; codes cannot be replayed', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const bad = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'alice', password: 'wrong password' } });
    assert.equal(bad.status, 401);
    const r1 = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'alice', password: u.password } });
    assert.ok(r1.body.mfa_ticket);
    const wrong = await api(srv.url, 'POST', '/api/v1/auth/login/mfa', { body: { ticket: r1.body.mfa_ticket, code: '123456' } });
    assert.equal(wrong.status, 401);
    const code = u.nextCode();
    const ok = await api(srv.url, 'POST', '/api/v1/auth/login/mfa', { body: { ticket: r1.body.mfa_ticket, code } });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^gtd_/);
    // Same code again on a new ticket: rejected as a replay.
    const r2 = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'alice', password: u.password } });
    const replay = await api(srv.url, 'POST', '/api/v1/auth/login/mfa', { body: { ticket: r2.body.mfa_ticket, code } });
    assert.equal(replay.status, 401);
  } finally { await srv.close(); }
});

test('reading packages requires login + 2FA', async () => {
  const srv = await startServer();
  try {
    const r = await api(srv.url, 'GET', '/api/v1/packages');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthenticated');
  } finally { await srv.close(); }
});

test('intermittent check: token must re-verify after the interval', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages', { token })).status, 200);
    srv.clock.advance(13 * HOUR);
    const due = await api(srv.url, 'GET', '/api/v1/packages', { token });
    assert.equal(due.status, 401);
    assert.equal(due.body.error, 'mfa_required');
    assert.equal(due.body.reason, 'interval');
    const who = await api(srv.url, 'GET', '/api/v1/auth/whoami', { token });
    assert.equal(who.body.mfa.ok, false, 'whoami still works and reports the check');
    const step = await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: u.nextCode() } });
    assert.equal(step.status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages', { token })).status, 200);
  } finally { await srv.close(); }
});

test('recovery codes work once for step-up', async () => {
  const srv = await startServer();
  try {
    const reg = srv.auth.register({ username: 'dave', password: 'another passphrase', ip: 'x' });
    const { recoveryCodes } = srv.auth.confirmEnrollment({ enrollToken: reg.enrollToken, code: totp(reg.secret, { now: srv.clock() }), ip: 'x' });
    srv.clock.advance(31_000);
    const t = srv.auth.completeLogin({ ...srv.auth.beginLogin({ username: 'dave', password: 'another passphrase', ip: 'x' }), code: totp(reg.secret, { now: srv.clock() }), ip: 'x' });
    srv.clock.advance(13 * HOUR);
    const token = t.token;
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: recoveryCodes[0] } })).body.method, 'recovery');
    srv.clock.advance(13 * HOUR);
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: recoveryCodes[0] } })).status, 401);
  } finally { await srv.close(); }
});

test('2FA follow-up checks can be toggled (with a fresh code), but sign-in always needs 2FA', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    srv.clock.advance(HOUR);
    const stale = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { interval: false } } });
    assert.equal(stale.status, 401, 'toggling needs a fresh code');
    assert.equal(stale.body.reason, 'sensitive_action');
    await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: u.nextCode() } });
    const off = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { interval: false, sensitive: false } } });
    assert.equal(off.status, 200);
    assert.equal(off.body.checks.interval, false);
    srv.clock.advance(48 * HOUR);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages', { token })).status, 200, 'no periodic check when off');
    // Sign-in still requires a TOTP code.
    const r1 = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'alice', password: u.password } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/login/mfa', { body: { ticket: r1.body.mfa_ticket, code: '' } })).status, 401);
    const bad = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { bogus: true } } });
    assert.equal(bad.status, 401, 'still needs a fresh code even for bad input');
  } finally { await srv.close(); }
});

test('admins can lock checks so users cannot turn them off', async () => {
  const srv = await startServer({ overrides: { policy: { lockedChecks: ['interval'] } } });
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const r = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { interval: false } } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'check_locked');
    const ok = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { new_network: false } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.checks.locked, ['interval']);
  } finally { await srv.close(); }
});

test('new network triggers a step-up for device tokens', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const { token } = srv.auth.completeLogin({
      ...srv.auth.beginLogin({ username: u.username, password: u.password, ip: '10.0.0.5' }), code: u.nextCode(), ip: '10.0.0.5',
    });
    const a = srv.auth.authenticate(token, '10.0.0.9');
    assert.equal(srv.auth.mfaState(a).ok, true, 'same /24 is the same network');
    const b = srv.auth.authenticate(token, '192.168.7.1');
    assert.deepEqual(srv.auth.mfaState(b), { ok: false, reason: 'new_network' });
    srv.auth.stepUp(b, u.nextCode(), '192.168.7.1');
    assert.equal(srv.auth.mfaState(srv.auth.authenticate(token, '192.168.7.1')).ok, true);
  } finally { await srv.close(); }
});

test('password brute force is rate limited', async () => {
  const srv = await startServer();
  try {
    createUser(srv);
    let last;
    for (let i = 0; i < 12; i++) last = await api(srv.url, 'POST', '/api/v1/auth/login', { body: { username: 'alice', password: `guess-${i}-xxxx` } });
    assert.equal(last.status, 429);
  } finally { await srv.close(); }
});

test('logout revokes the device token', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/logout', { token })).status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/v1/auth/whoami', { token })).status, 401);
  } finally { await srv.close(); }
});
