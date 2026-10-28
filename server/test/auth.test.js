// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
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

test('registration: confirm password; optional email with confirmation, stored encrypted', async () => {
  const srv = await startServer();
  try {
    let n = 0;
    const reg = (o) => srv.auth.register({ password: 'a long passphrase', confirm: 'a long passphrase', ip: `10.0.0.${++n}`, ...o });
    assert.throws(() => reg({ username: 'dan', confirm: 'a long passphrasE' }), /passwords do not match/);
    assert.throws(() => reg({ username: 'dan', email: 'dan@example.org', emailConfirm: 'dan@example.com' }), /email addresses do not match/);
    assert.throws(() => reg({ username: 'dan', email: 'dan@example.org' }), /email addresses do not match/, 'the confirmation is required');
    assert.throws(() => reg({ username: 'dan', email: 'not-an-email', emailConfirm: 'not-an-email' }), /does not look right/);
    assert.equal(reg({ username: 'nomail' }).user.email, null, 'email is optional');
    const u = reg({ username: 'dan', email: ' Dan@Example.org', emailConfirm: 'dan@example.org ' }).user;
    assert.match(u.email, /^v1\./);
    assert.ok(!fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8').includes('Dan@Example.org'), 'email is encrypted at rest');
    assert.equal(srv.auth.emailOf(u), 'Dan@Example.org');
    srv.auth.updateEmail(u, { email: 'dan@new.example', emailConfirm: 'dan@new.example' }, 'x');
    assert.equal(srv.auth.emailOf(srv.store.userByName('dan')), 'dan@new.example');
    srv.auth.updateEmail(u, { email: '', emailConfirm: '' }, 'x');
    assert.equal(srv.auth.emailOf(srv.store.userByName('dan')), null, 'both empty removes it');
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
    const t = srv.auth.completeLogin({ ...(await srv.auth.beginLogin({ username: 'dave', password: 'another passphrase', ip: 'x' })), code: totp(reg.secret, { now: srv.clock() }), ip: 'x' });
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
    // A code typed for something else (a step-up) is not a code for this change (AUTH-4 / EXT-3).
    const noCode = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { checks: { interval: false, sensitive: false } } });
    assert.equal(noCode.status, 401, 'the change carries its own code');
    assert.equal(noCode.body.reason, 'sensitive_action');
    const code = u.nextCode();
    const off = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { code, checks: { interval: false, sensitive: false } } });
    assert.equal(off.status, 200);
    assert.equal(off.body.checks.interval, false);
    const replay = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { code, checks: { interval: true } } });
    assert.equal(replay.status, 401, 'a code works once');
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
    const r = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { code: u.nextCode(), checks: { interval: false } } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'check_locked');
    const ok = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { code: u.nextCode(), checks: { new_network: false } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.checks.locked, ['interval']);
  } finally { await srv.close(); }
});

test('new network triggers a step-up for device tokens', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const { token } = srv.auth.completeLogin({
      ...(await srv.auth.beginLogin({ username: u.username, password: u.password, ip: '10.0.0.5' })), code: u.nextCode(), ip: '10.0.0.5',
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

const HOUR_MS = 3600_000;

async function teamWithMember(srv, owner, member, token) {
  const t = await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
  assert.equal(t.status, 201);
  void owner; void member;
}

test('AUTH-4: the security change and an owner grant each consume a code sent with the request', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'alice');
    createUser(srv, 'bobby');
    const token = await deviceLogin(srv, u);
    await teamWithMember(srv, u, 'bobby', token);
    // The step-up window is open (we just signed in): ordinary sensitive work goes through ...
    const m = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'maintainer' } });
    assert.equal(m.status, 200, 'a maintainer grant keeps the 10-minute window');
    // ... but naming an owner needs a code in the request, and the window does not stand in for it.
    const noCode = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'owner' } });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.reason, 'sensitive_action');
    const code = u.nextCode();
    const ok = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'owner', code } });
    assert.equal(ok.status, 200);
    const back = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'owner', code } });
    assert.equal(back.status, 401, 'the same code is not accepted twice');
    const wrong = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'owner', code: '000000' } });
    assert.equal(wrong.status, 401);
  } finally { await srv.close(); }
});

test('AUTH-4 / EXT-3: a code spent on the change does not open the window for the next action', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'alice');
    createUser(srv, 'bobby');
    const token = await deviceLogin(srv, u);
    await teamWithMember(srv, u, 'bobby', token);
    srv.clock.advance(11 * 60_000); // the sign-in window has lapsed
    const stale = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'maintainer' } });
    assert.equal(stale.status, 401);
    const off = await api(srv.url, 'PUT', '/api/v1/security', { token, body: { code: u.nextCode(), checks: { new_network: false } } });
    assert.equal(off.status, 200, 'the change itself needs only its own code');
    const after = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bobby', { token, body: { role: 'maintainer' } });
    assert.equal(after.status, 401, 'that code opened no window for other work');
    assert.equal(after.body.reason, 'sensitive_action');
  } finally { await srv.close(); }
});

test('AUTH-4: the security route runs the new-network check like every other route', async () => {
  const srv = await startServer({ overrides: { trustProxy: true } });
  try {
    const u = createUser(srv, 'alice');
    const { token } = srv.auth.completeLogin({ ...(await srv.auth.beginLogin({ username: 'alice', password: u.password, ip: '10.0.0.5' })), code: u.nextCode(), ip: '10.0.0.5' });
    const from = (ip, body) => fetch(`${srv.url}/api/v1/security`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const elsewhere = await from('198.51.100.9', { code: u.nextCode(), checks: { interval: false } });
    assert.equal(elsewhere.status, 401);
    assert.equal(elsewhere.body.reason, 'new_network');
    const home = await from('10.0.0.77', { code: u.nextCode(), checks: { interval: false } });
    assert.equal(home.status, 200);
  } finally { await srv.close(); }
});
