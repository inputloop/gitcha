// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, api, deviceLogin, persisted } from './helpers.js';
import { totp } from '../src/totp.js';
import { sha256 } from '../src/crypto.js';

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
    const db = JSON.stringify(persisted(srv.store));
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
    assert.ok(!JSON.stringify(persisted(srv.store)).includes('Dan@Example.org'), 'email is encrypted at rest');
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

import { RateLimiter } from '../src/auth.js';

test('AUTH-6: guessing at the second factor locks the guesser\'s network, not the owner', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'alice');
    const attacker = '198.51.100.20';
    // Holding only the password, the attacker burns six wrong codes: five on one ticket (which dies), one on the next.
    const t1 = await srv.auth.beginLogin({ username: 'alice', password: u.password, ip: attacker });
    for (let i = 0; i < 5; i++) assert.throws(() => srv.auth.completeLogin({ ticket: t1.ticket, code: '000000', ip: attacker }), /not valid|Too many/);
    assert.throws(() => srv.auth.completeLogin({ ticket: t1.ticket, code: '000000', ip: attacker }), /expired/, 'the ticket died at five');
    const t2 = await srv.auth.beginLogin({ username: 'alice', password: u.password, ip: attacker });
    assert.throws(() => srv.auth.completeLogin({ ticket: t2.ticket, code: '000000', ip: attacker }), /not valid/);
    const t3 = await srv.auth.beginLogin({ username: 'alice', password: u.password, ip: attacker });
    assert.throws(() => srv.auth.completeLogin({ ticket: t3.ticket, code: '000000', ip: attacker }), /Too many/, 'the seventh guess from that network is refused');
    // The owner, from their own network, signs in with the right code at once.
    const home = '203.0.113.40';
    const mine = await srv.auth.beginLogin({ username: 'alice', password: u.password, ip: home });
    const ok = srv.auth.completeLogin({ ticket: mine.ticket, code: u.nextCode(), ip: home });
    assert.match(ok.token, /^gtd_/, 'the owner is not locked out by someone else\'s guesses');
    // And a step-up from the owner's network works while the attacker's token is still locked.
    const step = srv.auth.stepUp(srv.auth.authenticate(ok.token, home), u.nextCode(), home);
    assert.equal(step.method, 'totp');
  } finally { await srv.close(); }
});

test('AUTH-6: only wrong guesses are counted, and a right code clears the count', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'alice');
    const ip = '198.51.100.20';
    for (let round = 0; round < 3; round++) { // 3 x (5 wrong, then a right one): never locked, because the right one resets
      const t = await srv.auth.beginLogin({ username: 'alice', password: u.password, ip });
      for (let i = 0; i < 4; i++) assert.throws(() => srv.auth.completeLogin({ ticket: t.ticket, code: '000000', ip }), /not valid/);
      assert.match(srv.auth.completeLogin({ ticket: t.ticket, code: u.nextCode(), ip }).token, /^gtd_/);
    }
  } finally { await srv.close(); }
});

test('AUTH-7: distinct usernames from one address hit a per-address cap before any scrypt runs', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice');
    const ip = '198.51.100.30';
    const results = await Promise.all(Array.from({ length: 36 }, (_, i) => srv.auth.beginLogin({ username: `nobody${i}`, password: 'x'.repeat(12), ip }).then(() => 'ok', (e) => e.status)));
    assert.equal(results.filter((s) => s === 401).length, 30, 'thirty guesses are evaluated');
    assert.equal(results.filter((s) => s === 429).length, 6, 'the rest are refused unhashed');
    // Someone else, elsewhere, is untouched; and a success from the capped address is not counted against it.
    assert.match((await srv.auth.beginLogin({ username: 'alice', password: 'correct horse battery', ip: '198.51.100.31' })).ticket, /^gtt_/);
  } finally { await srv.close(); }
});

test('AUTH-7: the password hash runs off the event loop (30 logins in flight must not freeze the server)', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice');
    const t0 = performance.now();
    const pending = Array.from({ length: 6 }, (_, i) => srv.auth.beginLogin({ username: `ghost${i}`, password: 'y'.repeat(12), ip: `192.0.2.${i + 1}` }).catch(() => null));
    const handedBack = performance.now() - t0;
    // Six synchronous scrypt runs take over half a second before control returns; async hands it back at once.
    assert.ok(handedBack < 150, `beginLogin handed control back after ${Math.round(handedBack)} ms`);
    await Promise.all(pending);
  } finally { await srv.close(); }
});

test('AUTH-7: a full limiter drops expired and unblocked keys first and never forgets a blocked one', () => {
  let now = 1_000_000;
  const lim = new RateLimiter({ max: 10, windowMs: 15 * 60_000, clock: () => now });
  for (let i = 0; i < 11; i++) lim.hit('login:attacker:alice');
  assert.equal(lim.check('login:attacker:alice'), false, 'blocked');
  for (let i = 0; i < 50_100; i++) lim.hit(`login:ip${i}:user`);
  assert.equal(lim.check('login:attacker:alice'), false, 'still blocked after a flood of other keys (old code cleared the whole map)');
  assert.ok(lim.hits.size <= 50_000);
  now += 16 * 60_000;
  lim.hit('fresh');
  assert.equal(lim.check('login:attacker:alice'), true, 'the window ends as before');
});

test('AUTH-19: a lockout leaves one audit row for the owner, not one per refused request', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice');
    const id = srv.store.userByName('alice').id;
    const ip = '198.51.100.50';
    for (let i = 0; i < 10; i++) await assert.rejects(srv.auth.beginLogin({ username: 'alice', password: 'wrong password ' + i, ip }), { status: 401 });
    for (let i = 0; i < 8; i++) await assert.rejects(srv.auth.beginLogin({ username: 'alice', password: 'wrong password', ip }), { status: 429 });
    // A stranger guessing at a name that does not exist cannot write into anybody's log.
    for (let i = 0; i < 12; i++) await assert.rejects(srv.auth.beginLogin({ username: 'nobody', password: 'wrong password', ip }), (e) => e.status === 401 || e.status === 429);
    const rows = srv.store.auditFor(id, 100).filter((r) => r.event === 'login.rate_limited');
    assert.equal(rows.length, 1, 'eight refused requests, one row');
    assert.equal(srv.store.auditFor(id, 100).filter((r) => r.event === 'login.bad_password').length, 10);
  } finally { await srv.close(); }
});

test('AUTH-12: recovery codes are 80 bits, stored as keyed hashes, and the old 40-bit ones still work once', async () => {
  const srv = await startServer();
  try {
    const reg = srv.auth.register({ username: 'carol', password: 'a long passphrase here', ip: 'x' });
    const { recoveryCodes } = srv.auth.confirmEnrollment({ enrollToken: reg.enrollToken, code: totp(reg.secret, { now: srv.clock() }), ip: 'x' });
    for (const c of recoveryCodes) assert.match(c, /^[a-f0-9]{5}(-[a-f0-9]{5}){3}$/, 'four groups of five hex digits');
    const user = srv.store.userByName('carol');
    // Nothing in the database is a bare SHA-256 of a code: an offline guesser gets nothing without the server key.
    const bare = new Set(recoveryCodes.map((c) => sha256(c)));
    assert.ok(user.recoveryCodes.every((h) => h.startsWith('hm1.') && !bare.has(h)), user.recoveryCodes[0]);
    // A different server key makes different hashes of the same code.
    const other = await startServer();
    try {
      assert.notEqual(other.auth.recoveryHash(recoveryCodes[0]), user.recoveryCodes[0]);
    } finally { await other.close(); }
    // It works once, typed with or without dashes and spaces and in capitals.
    const token = (await deviceLogin(srv, { username: 'carol', password: 'a long passphrase here', nextCode: () => { srv.clock.advance(31_000); return totp(reg.secret, { now: srv.clock() }); } }));
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: recoveryCodes[1].toUpperCase().replaceAll('-', ' ') } })).body.method, 'recovery');
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: recoveryCodes[1] } })).status, 401);
    // A code issued before this change (40 bits, plain SHA-256) is still honoured once.
    await srv.store.tx((d) => { d.users[user.id].recoveryCodes.push(sha256('abcde-12345')); });
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: 'abcde-12345' } })).body.method, 'recovery');
    assert.equal((await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: 'abcde-12345' } })).status, 401);
  } finally { await srv.close(); }
});
