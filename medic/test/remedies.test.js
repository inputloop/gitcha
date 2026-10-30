// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The consent gate: which remedies run unasked, which wait for a person, and that the data-moving one checks again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, REMEDIES } from '../lib/remedies.js';
import { tableRunner } from '../lib/run.js';

test('every remedy has a class, a title and plain words; only safe and confirm ones can run', () => {
  for (const [name, r] of Object.entries(REMEDIES)) {
    assert.ok(['safe', 'confirm', 'manual'].includes(r.class), `${name} class`);
    assert.ok(r.title && r.how, `${name} says what it is`);
    assert.equal(typeof r.run === 'function', r.class !== 'manual', `${name}: run exactly when not manual`);
  }
});

test('a safe remedy runs under allow=safe; a confirm one is parked with the command a person types', async () => {
  const run = tableRunner({ 'systemctl restart gitcha.service': 'ok' });
  const a = await apply('restart-gitcha', { run, io: {} }, { allow: 'safe' });
  assert.deepEqual([a.ran, a.ok], [true, true]);
  const b = await apply('reset-empty-cassandra', { run, io: {} }, { allow: 'safe' });
  assert.equal(b.ran, false);
  assert.match(b.parked, /sudo gitcha-medic --yes reset-empty-cassandra/);
  const c = await apply('manual-secret-key', { run, io: {} }, { allow: 'confirm' });
  assert.equal(c.ran, false);
  assert.equal(c.parked, 'for hands only');
  assert.deepEqual(run.calls, ['systemctl restart gitcha.service'], 'the parked ones ran nothing');
});

test('reset-empty-cassandra: refuses when a keyspace of ours is on disk, even with a yes', async () => {
  const run = tableRunner({});
  const io = { exists: () => true, readdir: () => ['system', 'gitcha'], mkdir: () => {}, rename: () => { throw new Error('must not move'); } };
  const a = await apply('reset-empty-cassandra', { run, io }, { allow: 'confirm' });
  assert.equal(a.ran, true);
  assert.equal(a.ok, false);
  assert.match(a.err, /refused.*gitcha/);
  assert.deepEqual(run.calls, [], 'Cassandra was not even stopped');
});

test('reset-empty-cassandra: with only system keyspaces it stops, moves aside (never deletes) and starts', async () => {
  const run = tableRunner({ 'systemctl stop cassandra.service': '', 'systemctl start cassandra.service': '' });
  const moved = [];
  const present = new Set(['/var/lib/cassandra/data', '/var/lib/cassandra/commitlog', '/var/lib/cassandra/saved_caches']);
  const io = { exists: (p) => present.has(p), readdir: () => ['system', 'system_schema'], mkdir: (p) => moved.push(`mkdir ${p}`), rename: (a, b) => moved.push(`${a} -> ${b}`) };
  const a = await apply('reset-empty-cassandra', { run, io }, { allow: 'confirm' });
  assert.equal(a.ok, true, a.err);
  assert.deepEqual(run.calls, ['systemctl stop cassandra.service', 'systemctl start cassandra.service']);
  assert.equal(moved.length, 4, moved.join('\n'));
  assert.ok(moved.every((m) => m.startsWith('mkdir') || /-> \/var\/lib\/cassandra\/medic-aside-/.test(m)));
  assert.ok(!moved.some((m) => /hints/.test(m)), 'a part that is not there is not moved');
});

test('start-nginx refuses to start a configuration nginx -t rejects', async () => {
  const run = tableRunner({ 'nginx -t': { code: 1, err: 'nginx: [emerg] unknown directive' } });
  const a = await apply('start-nginx', { run, io: {} }, { allow: 'safe' });
  assert.equal(a.ok, false);
  assert.match(a.err, /not started/);
  assert.deepEqual(run.calls, ['nginx -t']);
});
