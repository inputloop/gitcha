// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The store: the audit log's per-user caps (AUTH-5 / STORE-3 / AUTH-11) and, below, its files (STORE-1, 4, 5, 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpDir } from './helpers.js';

const open = (dir = tmpDir()) => ({ dir, store: new Store(dir) });

test('AUTH-5 / STORE-3: another user flooding the log cannot push a victim\'s rows out', () => {
  const { store } = open();
  store.data.users.v = { id: 'v', username: 'victim' };
  store.data.users.m = { id: 'm', username: 'mallory' };
  for (const event of ['account.activated', 'device.created', 'login.bad_password', 'login.bad_password']) store.audit({ userId: 'v', event, ip: '198.51.100.1' });
  // Ten thousand and some downloads by one user (the W4 probe), and thousands of role changes written into the victim's log.
  for (let i = 0; i < 10_100; i++) store.audit({ userId: 'm', event: 'package.downloaded', package: 'p', ip: '203.0.113.7' });
  for (let i = 0; i < 5_100; i++) store.audit({ userId: 'v', event: 'team.role_changed', by: 'mallory', ip: '203.0.113.7' });
  const mine = store.auditFor('v', 100, { kind: 'security' }).map((e) => e.event); // the page's own list, not buried under the flood
  assert.ok(mine.includes('account.activated') && mine.includes('device.created'), `the victim's own trail survived: ${mine.slice(-6)}`);
  assert.equal(mine.filter((e) => e === 'login.bad_password').length, 2);
  assert.equal(store.auditCount('m', 'traffic'), 200, 'downloads are capped per user');
  assert.equal(store.auditCount('v', 'others'), 200, 'rows written by someone else have their own cap and their own list');
  assert.equal(store.auditFor('v', 10, { kind: 'others' }).length, 10);
});

test('AUTH-5: a user\'s own security rows are capped per user, oldest first, and kept apart from downloads', () => {
  const { store } = open();
  for (let i = 0; i < 1_050; i++) store.audit({ userId: 'u', event: 'mfa.step_up', n: i });
  for (let i = 0; i < 300; i++) store.audit({ userId: 'u', event: 'package.downloaded', n: i });
  const sec = store.auditFor('u', 5000, { kind: 'security' });
  assert.equal(sec.length, 1000);
  assert.equal(sec[0].n, 1049, 'newest first');
  assert.equal(sec[999].n, 50, 'oldest fifty dropped');
  assert.ok(sec.every((e) => e.event === 'mfa.step_up'), 'no download in the security view');
  const traffic = store.auditFor('u', 5000, { kind: 'traffic' });
  assert.equal(traffic.length, 200);
  assert.deepEqual(store.auditFor('u', 3, { kind: 'security', skip: 2 }).map((e) => e.n), [1047, 1046, 1045], 'paging by skip');
});

test('AUTH-5: a log written by the old code (one array for everyone) is read on, split per user', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 1, users: {}, audit: [
      { at: 1, userId: 'a', event: 'account.activated' }, { at: 2, userId: 'b', event: 'device.created' },
      { at: 3, userId: 'a', event: 'package.downloaded', package: 'x' }, { at: 4, event: 'billing.updated' },
    ],
  }));
  const { store } = open(dir);
  assert.deepEqual(store.auditFor('a', 10).map((e) => e.event), ['package.downloaded', 'account.activated']);
  assert.deepEqual(store.auditFor('b', 10).map((e) => e.event), ['device.created']);
  store.audit({ userId: 'a', event: 'login.web' });
  store.flush();
  assert.ok(!Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).audit), 'saved in the new shape');
});

test('AUTH-11: the address of the person who acted never lands in another user\'s row', () => {
  const { store } = open();
  store.data.users.a = { id: 'a', username: 'alice' };
  store.data.users.b = { id: 'b', username: 'bobby' };
  const entry = { event: 'team.member_added', ip: '203.0.113.77', team: 'acme', member: 'bobby', by: 'alice' };
  store.audit({ userId: 'a', ...entry });
  store.audit({ userId: 'b', ...entry });
  assert.equal(store.auditFor('a', 1)[0].ip, '203.0.113.77', 'the actor keeps their own address');
  assert.equal(store.auditFor('b', 1)[0].ip, undefined, 'the person added does not get it');
  assert.equal(store.auditFor('b', 1)[0].by, 'alice', 'but still sees who did it');
});

test('AUTH-5: at the ceiling the biggest holder pays, so a user with little in the log keeps all of it', () => {
  const store = new Store(tmpDir(), { auditCeiling: 300 });
  for (let i = 0; i < 5; i++) store.audit({ userId: 'small', event: 'login.web' });
  for (let i = 0; i < 250; i++) { store.audit({ userId: 'big1', event: 'mfa.step_up' }); store.audit({ userId: 'big2', event: 'mfa.step_up' }); }
  assert.equal(store.auditCount('small'), 5);
  assert.ok(store.auditCount('big1') + store.auditCount('big2') + 5 <= 300);
  assert.ok(Math.abs(store.auditCount('big1') - store.auditCount('big2')) <= 1, 'the two big holders share the loss');
});
