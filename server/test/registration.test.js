// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A sign-up that never finishes (AUTH-15 / OPS-8 / PROD-3 / PROD-7): it cannot be taken over, it does not strand a
// closed server, and it is removed once its enrolment window has passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser } from './helpers.js';
import { totp } from '../src/totp.js';

const MIN = 60_000;
const reg = (srv, username, password = 'a long passphrase here') => srv.auth.register({ username, password, ip: `10.0.0.${Math.floor(Math.random() * 250) + 1}` });

test('AUTH-15: a name with an unfinished sign-up cannot be taken over, and its enrolment link stays its own', async () => {
  const srv = await startServer();
  try {
    const mine = reg(srv, 'dave');
    assert.throws(() => reg(srv, 'dave', 'someone elses passphrase'), (e) => e.status === 409 && /not finished/.test(e.message));
    // The person who started it still finishes with their own link and their own authenticator.
    const done = srv.auth.confirmEnrollment({ enrollToken: mine.enrollToken, code: totp(mine.secret, { now: srv.clock() }), ip: 'x' });
    assert.equal(done.user.status, 'active');
    assert.equal(srv.store.userCount(), 1);
  } finally { await srv.close(); }
});

test('AUTH-15: after the window the record is gone; a new sign-up gets a new id, the old link is dead, and no role is inherited', async () => {
  const srv = await startServer();
  try {
    const first = reg(srv, 'first'); // the first person on the server is its admin, once they finish
    assert.equal(first.user.role, 'admin');
    const second = createUser(srv, 'second'); // someone else finishes meanwhile: a plain user
    assert.equal(srv.store.userByName(second.username).role, 'user');
    srv.clock.advance(31 * MIN);
    const stranger = reg(srv, 'first', 'a stranger passphrase');
    assert.notEqual(stranger.user.id, first.user.id, 'a new record, not the old one reused');
    assert.equal(stranger.user.role, 'user', 'the first user\'s admin role does not ride along');
    assert.throws(() => srv.auth.confirmEnrollment({ enrollToken: first.enrollToken, code: totp(first.secret, { now: srv.clock() }), ip: 'x' }), /expired/, 'the first enrolment link no longer works');
    assert.equal(srv.auth.enrollmentFor(first.enrollToken), null);
  } finally { await srv.close(); }
});

test('PROD-3: on a closed server an abandoned first sign-up frees the name after its window, instead of stranding the server', async () => {
  const srv = await startServer({ overrides: { openRegistration: false } });
  try {
    reg(srv, 'owner'); // the first sign-up is allowed on an empty server, and is then abandoned
    assert.throws(() => reg(srv, 'other'), (e) => e.status === 403, 'closed while the first one is live');
    srv.clock.advance(31 * MIN);
    const again = reg(srv, 'owner'); // used to be 403 forever: the pending record counted as a user
    assert.equal(again.user.role, 'admin');
  } finally { await srv.close(); }
});

test('OPS-8 / PROD-7: the sweeper removes expired sign-ups and dead sessions and leaves finished accounts alone', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice');
    reg(srv, 'drifter');
    const before = JSON.stringify(srv.store.data.sessions);
    assert.equal(srv.auth.sweep(), 0, 'nothing is due yet');
    assert.equal(JSON.stringify(srv.store.data.sessions), before);
    srv.clock.advance(31 * MIN);
    assert.ok(srv.auth.sweep() >= 2);
    assert.equal(srv.store.userByName('drifter'), null);
    assert.equal(Object.values(srv.store.data.sessions).filter((s) => s.kind === 'enroll').length, 0);
    assert.ok(srv.store.userByName('alice'), 'finished accounts are untouched');
    // A device token nobody has used for longer than the idle limit is deleted, not just refused.
    const { token } = srv.auth.createSession(srv.store.userByName('alice'), { kind: 'device', name: 'old laptop', ip: '10.0.0.9' });
    srv.clock.advance(srv.config.policy.sessionIdle + MIN);
    assert.equal(Object.keys(srv.store.data.sessions).length, 1);
    srv.auth.sweep();
    assert.equal(Object.keys(srv.store.data.sessions).length, 0);
    assert.equal(srv.auth.authenticate(token, '10.0.0.9'), null);
  } finally { await srv.close(); }
});
