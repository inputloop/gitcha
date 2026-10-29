// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Cassandra backend (GITCHA_STORE=cassandra). Every scenario runs against a stand-in driver
// (fake-cassandra-driver.js), and again against a real cluster when GITCHA_TEST_CASSANDRA names one
// (for example GITCHA_TEST_CASSANDRA=127.0.0.1:9042; CI's cassandra job does this).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parseStore, StartupError } from '../src/config.js';
import { toRows, fromRows } from '../src/store-cassandra.js';
import { tmpDir, startServer, createUser } from './helpers.js';
import { totp } from '../src/totp.js';

const FAKE = fileURLToPath(new URL('./fake-cassandra-driver.js', import.meta.url));
const KEY = crypto.randomBytes(32).toString('base64');
const fakeState = () => JSON.parse(fs.readFileSync(process.env.GITCHA_FAKE_CASSANDRA, 'utf8'));
const editFake = (fn) => { const s = fakeState(); fn(s); fs.writeFileSync(process.env.GITCHA_FAKE_CASSANDRA, JSON.stringify(s)); };
process.env.GITCHA_FAKE_CASSANDRA = path.join(tmpDir('gitcha-fake-cassandra-'), 'cluster.json');

const CLUSTERS = [['fake', { driverModule: FAKE }]];
if (process.env.GITCHA_TEST_CASSANDRA) CLUSTERS.push(['real', { contactPoints: process.env.GITCHA_TEST_CASSANDRA.split(',') }]);

/** A store setting for a fresh instance of its own, so tests never see one another's rows. */
function backendFor(extra, env = {}) {
  const store = parseStore({ GITCHA_STORE: 'cassandra', GITCHA_CASSANDRA_KEYSPACE: 'gitcha_test', GITCHA_CASSANDRA_INSTANCE: `t${crypto.randomBytes(6).toString('hex')}`, ...env });
  return { ...store, cassandra: { ...store.cassandra, leaseWaitMs: 1500, ...extra } };
}

for (const [kind, extra] of CLUSTERS) {
  test(`${kind}: a save survives a restart, collections, odd keys and deletions included`, () => {
    const dir = tmpDir();
    const backend = backendFor(extra);
    const a = new Store(dir, { backend, secretKey: KEY });
    a.tx((d) => {
      d.users.u1 = { id: 'u1', username: 'alice', nested: { list: [1, 2, { x: null }] } };
      d.users.u2 = { id: 'u2', username: 'bob' };
      d.sessions.s1 = { userId: 'u1' };
      d.version = 1;
      d.counter = 7; // a collection that is not an object of entries
      d.ring.peers['https://peer.example'] = { name: 'peer' };
    });
    a.audit({ event: 'billing.updated' }); // the '' (no user) audit slot
    a.flush();
    a.tx((d) => { delete d.users.u2; delete d.sessions.s1; d.counter = 8; });
    a.close();
    const b = new Store(dir, { backend, secretKey: KEY });
    try {
      assert.deepEqual(Object.keys(b.data.users), ['u1']);
      assert.deepEqual(b.data.users.u1.nested, { list: [1, 2, { x: null }] });
      assert.deepEqual(b.data.sessions, {});
      assert.equal(b.data.counter, 8);
      assert.equal(b.data.ring.peers['https://peer.example'].name, 'peer');
      assert.deepEqual(b.auditFor('', 5).map((r) => r.event), ['billing.updated']);
    } finally { b.close(); }
  });

  test(`${kind}: a second server on the same instance takes over only from its own process, and the first can no longer write`, () => {
    const backend = backendFor(extra);
    const first = new Store(tmpDir(), { backend, secretKey: KEY });
    first.tx((d) => { d.users.u1 = { id: 'u1', username: 'alice' }; });
    // The same pid is an earlier store in this process (as with db.lock), so the lease is taken over at once.
    const second = new Store(tmpDir(), { backend, secretKey: KEY });
    try {
      assert.throws(() => first.tx((d) => { d.users.u9 = { id: 'u9', username: 'mallory' }; }), /lease|may not write/);
      assert.equal(first.data.users.u9, undefined, 'the refused change is undone in memory');
      second.tx((d) => { d.users.u2 = { id: 'u2', username: 'bob' }; });
      assert.deepEqual(Object.keys(second.data.users).sort(), ['u1', 'u2']);
    } finally { second.close(); first.close(); }
  });

  test(`${kind}: the wrong secret key stops the start instead of locking every account out`, () => {
    const backend = backendFor(extra);
    const a = new Store(tmpDir(), { backend, secretKey: KEY });
    a.tx((d) => { d.users.u1 = { id: 'u1', username: 'alice' }; });
    a.close();
    assert.throws(() => new Store(tmpDir(), { backend, secretKey: crypto.randomBytes(32).toString('base64') }), (err) => err instanceof StartupError && /different secret key/.test(err.message));
    const again = new Store(tmpDir(), { backend, secretKey: KEY }); // and the refused start left the instance usable
    assert.ok(again.data.users.u1);
    again.close();
  });

  test(`${kind}: entries come back in the order they were added, as a JavaScript object (and db.json) keeps them`, () => {
    const dir = tmpDir();
    const backend = backendFor(extra);
    const a = new Store(dir, { backend, secretKey: KEY });
    a.tx((d) => { d.users.zed = { n: 1 }; d.users.amy = { n: 2 }; d.users.max = { n: 3 }; });
    a.close();
    const b = new Store(dir, { backend, secretKey: KEY });
    assert.deepEqual(Object.keys(b.data.users), ['zed', 'amy', 'max'], 'not sorted by key');
    b.tx((d) => { d.users.amy.n = 20; delete d.users.zed; });
    b.tx((d) => { d.users.zed = { n: 4 }; }); // deleted and added again: now last, as in memory
    const want = Object.keys(b.data.users);
    b.close();
    const c = new Store(dir, { backend, secretKey: KEY });
    assert.deepEqual(Object.keys(c.data.users), want);
    assert.deepEqual(want, ['amy', 'max', 'zed']);
    c.close();
  });

  test(`${kind}: an existing db.json is imported once into an empty instance, then renamed`, () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, users: { u1: { id: 'u1', username: 'alice' } }, audit: { u1: { security: [{ at: 1, event: 'account.activated' }], others: [], traffic: [] } } }));
    const backend = backendFor(extra);
    const a = new Store(dir, { backend, secretKey: KEY });
    assert.equal(a.data.users.u1.username, 'alice');
    assert.ok(!fs.existsSync(path.join(dir, 'db.json')) && fs.existsSync(path.join(dir, 'db.json.imported-to-cassandra')));
    a.close();
    const b = new Store(dir, { backend, secretKey: KEY });
    assert.deepEqual(b.auditFor('u1', 5).map((r) => r.event), ['account.activated']);
    b.close();
  });
}

test('fake: a save sends only the rows it changed, at the configured consistency', () => {
  const backend = backendFor(CLUSTERS[0][1], { GITCHA_CASSANDRA_CONSISTENCY: 'quorum' });
  const s = new Store(tmpDir(), { backend, secretKey: KEY });
  try {
    for (let i = 0; i < 50; i++) s.tx((d) => { d.users[`u${i}`] = { id: `u${i}`, username: `user${i}` }; });
    const before = fakeState().batches.length;
    s.tx((d) => { d.users.u7.username = 'renamed'; });
    s.tx(() => {}); // nothing changed: nothing sent
    const after = fakeState();
    assert.deepEqual(after.batches.slice(before), [1], 'one row, in one batch');
    assert.deepEqual(after.clients.at(-1), { consistency: 4, serial: 8, dc: 'datacenter1' }, 'QUORUM, and SERIAL for the lease');
  } finally { s.close(); }
});

test('fake: a lease held by a server on another machine is waited out, then the start stops with a clear message', () => {
  const backend = backendFor(CLUSTERS[0][1]);
  editFake((st) => { st.rows[JSON.stringify([backend.cassandra.instance, '!lease', ''])] = { body: JSON.stringify({ host: 'elsewhere', pid: 1, since: 'then' }), until: Date.now() + 60_000 }; });
  assert.throws(() => new Store(tmpDir(), { backend, secretKey: KEY }), (err) => err instanceof StartupError && /another Gitcha server \(elsewhere/.test(err.message));
});

test('fake: a failed save changes nothing in memory, and the next save writes what is really new', () => {
  const backend = backendFor(CLUSTERS[0][1]);
  const dir = tmpDir();
  const s = new Store(dir, { backend, secretKey: KEY });
  s.tx((d) => { d.users.u1 = { id: 'u1', username: 'alice' }; });
  editFake((st) => { st.failNext = 'error'; });
  assert.throws(() => s.tx((d) => { d.users.u2 = { id: 'u2', username: 'lost' }; }), /batch failed/);
  assert.equal(s.data.users.u2, undefined);
  s.tx((d) => { d.users.u3 = { id: 'u3', username: 'carol' }; });
  s.close();
  const again = new Store(dir, { backend, secretKey: KEY });
  assert.deepEqual(Object.keys(again.data.users).sort(), ['u1', 'u3']);
  again.close();
});

test('fake: after a save whose answer was lost, memory and Cassandra agree, even when Cassandra could not be read at once', () => {
  const backend = backendFor(CLUSTERS[0][1]);
  const dir = tmpDir();
  const s = new Store(dir, { backend, secretKey: KEY });
  s.tx((d) => { d.users.u1 = { id: 'u1', username: 'alice' }; });
  // The batch landed but the answer was lost: memory goes back to what Cassandra holds, as with db.json.
  editFake((st) => { st.failNext = 'lost-answer'; });
  assert.throws(() => s.tx((d) => { d.users.u2 = { id: 'u2', username: 'bob' }; }), /write timeout/);
  assert.ok(s.data.users.u2, 'it landed, so memory has it too');
  // Again, and now Cassandra cannot be read back either: memory goes to the last confirmed rows, and the next
  // save reads Cassandra first, so the row that landed unannounced is removed instead of reappearing later.
  editFake((st) => { st.failNext = 'lost-answer'; st.failReads = 2; }); // two: flush and tx each restore
  assert.throws(() => s.tx((d) => { d.users.ghost = { id: 'ghost', username: 'ghost' }; }), /write timeout/);
  assert.equal(s.data.users.ghost, undefined);
  s.tx((d) => { d.users.u3 = { id: 'u3', username: 'carol' }; });
  s.close();
  const again = new Store(dir, { backend, secretKey: KEY });
  assert.deepEqual(Object.keys(again.data.users).sort(), ['u1', 'u2', 'u3']);
  again.close();
});

test('fake: unreachable nodes, or a build without the driver, stop the start in one line', () => {
  editFake((st) => { st.down = true; });
  try {
    assert.throws(() => new Store(tmpDir(), { backend: backendFor(CLUSTERS[0][1]), secretKey: KEY }), (err) => err instanceof StartupError && /cannot reach Cassandra at 127\.0\.0\.1/.test(err.message));
  } finally { editFake((st) => { delete st.down; }); }
  const missing = backendFor({ driverModule: path.join(os.tmpdir(), 'no-such-cassandra-driver.js') });
  assert.throws(() => new Store(tmpDir(), { backend: missing, secretKey: KEY }), (err) => err instanceof StartupError && /built without Cassandra support/.test(err.message));
});

test('fake: the whole server runs on Cassandra, and an account outlives a restart', async () => {
  const backend = backendFor(CLUSTERS[0][1]);
  const dataDir = tmpDir();
  const srv = await startServer({ overrides: { dataDir, store: backend } });
  const u = createUser(srv, 'alice');
  await srv.close();
  assert.ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'nothing written to db.json');
  const again = await startServer({ overrides: { dataDir, store: backend } });
  try {
    const alice = again.store.userByName('alice');
    assert.ok(alice, 'the account is there');
    // The sealed authenticator secret still opens with the same key: a fresh code is accepted.
    again.clock.advance(31_000); // past the time step enrollment used, which may not be used twice
    assert.equal(again.auth.verifySecondFactor(alice, totp(u.secret, { now: again.clock() }), '127.0.0.1'), 'totp');
  } finally { await again.close(); }
});

test('rows: every database shape round-trips through toRows and fromRows', () => {
  const data = { version: 1, users: { '': { a: 1 }, 'with.dot': [1, 'two'], x: null }, list: [1, 2], empty: {}, s: 'text', gone: undefined, ring: { peers: {}, announcements: { a: { b: true } } } };
  const back = fromRows(toRows(data));
  assert.deepEqual(back, JSON.parse(JSON.stringify(data)));
});

test('config: GITCHA_STORE and the Cassandra settings are checked at start', () => {
  assert.equal(parseStore({}).kind, 'file');
  const c = parseStore({ GITCHA_STORE: 'Cassandra', GITCHA_CASSANDRA_CONTACT_POINTS: 'a:9042, b', GITCHA_CASSANDRA_CONSISTENCY: 'local_one' }).cassandra;
  assert.deepEqual(c.contactPoints, ['a:9042', 'b']);
  assert.equal(c.consistency, 'LOCAL_ONE');
  assert.equal(c.serialConsistency, 'LOCAL_SERIAL');
  assert.equal(parseStore({ GITCHA_CASSANDRA_REPLICATION: 'NetworkTopologyStrategy:dc1=3,dc-2=2' }).cassandra.replication, 'NetworkTopologyStrategy:dc1=3,dc-2=2');
  for (const env of [{ GITCHA_STORE: 'postgres' }, { GITCHA_CASSANDRA_KEYSPACE: 'drop table' }, { GITCHA_CASSANDRA_INSTANCE: '1abc' }, { GITCHA_CASSANDRA_REPLICATION: "SimpleStrategy:1'}" }, { GITCHA_CASSANDRA_CONSISTENCY: 'SOME' }, { GITCHA_STORE: 'cassandra', GITCHA_CASSANDRA_CONTACT_POINTS: ' , ' }]) {
    assert.throws(() => parseStore(env), StartupError, JSON.stringify(env));
  }
});
