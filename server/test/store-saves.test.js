// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A change is saved whole or not at all, and nothing the server counts or marks waits in memory
// where a crash would lose it. Each test reads the saved database itself (db.json, or the Cassandra rows): memory is not the proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, unsavedPaths, persisted } from './helpers.js';
import { createApp } from '../src/app.js';

const disk = (srv) => persisted(srv.store);
const ciJob = (id, extra = {}) => ({
  id, kind: 'ci', status: 'queued', createdAt: 1, labels: [], owner: { type: 'user', name: 'alice' }, createdBy: 'alice',
  timeoutMs: 60_000, trigger: 'manual', reservedMinutes: 1, ...extra,
});

test('a change that throws halfway is undone, so a later save cannot write half of it', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice', 'first long pass!'); // the first account is the administrator
    createUser(srv, 'bob', 'second long pass');
    const id = srv.store.userByName('bob').id;
    assert.throws(() => srv.store.tx((d) => {
      d.users[id].role = 'admin';
      d.users[id].username = 'mallory';
      throw new Error('a check failed after the first two writes');
    }), /check failed/);
    assert.equal(srv.store.userById(id).role, 'user', 'memory is back to the saved state');
    assert.equal(srv.store.userById(id).username, 'bob');
    srv.store.tx(() => {}); // any later save
    assert.equal(disk(srv).users[id].role, 'user', 'and the half-made change never reaches the disk');
  } finally { await srv.close(); }
});

test('a failed write also undoes the change, however the write fails', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice', 'first long pass!');
    createUser(srv, 'bob', 'second long pass');
    const id = srv.store.userByName('bob').id;
    const real = srv.store.flush.bind(srv.store);
    srv.store.flush = () => { throw new Error('disk full'); }; // a write that fails without undoing anything itself
    assert.throws(() => srv.store.tx((d) => { d.users[id].role = 'admin'; }), /disk full/);
    srv.store.flush = real;
    assert.equal(srv.store.userById(id).role, 'user');
  } finally { await srv.close(); }
});

test('every collection is on disk from the start, so an undo never drops one', async () => {
  const srv = await startServer();
  try {
    const d = disk(srv);
    for (const k of ['users', 'sessions', 'jobs', 'runners', 'keys', 'ops', 'billing', 'budgets', 'agents', 'tasks', 'projects']) {
      assert.ok(d[k] !== undefined, `db.json holds ${k}`);
    }
    assert.throws(() => srv.store.tx(() => { throw new Error('nothing changed, but it threw'); }));
    assert.ok(srv.store.data.ops?.tickets && srv.store.data.keys?.ssh, 'the collections are all still there');
  } finally { await srv.close(); }
});

test('a build that was running when the server stopped is marked failed on disk at the next start', async () => {
  const srv = await startServer();
  const config = srv.config;
  srv.store.tx((d) => { d.jobs.job_running1 = ciJob('job_running1', { status: 'running', startedAt: 2, runnerId: 'run_x' }); });
  await srv.close();
  const again = createApp(config, { clock: srv.clock });
  try {
    const j = disk(again).jobs.job_running1;
    assert.equal(j.status, 'failed', 'saved at once, not only in memory');
    assert.match(j.error, /restarted/);
  } finally { await new Promise((r) => again.server.close(r)); }
});

test('a job given back by a runner that went away is saved as queued, with no runner left on it', async () => {
  const srv = await startServer();
  try {
    srv.store.tx((d) => { d.jobs.job_back1 = ciJob('job_back1', { status: 'running', startedAt: 2, runnerId: 'run_x', runnerName: 'gone', tokenHash: 'h', deadline: 99 }); });
    srv.jobs.requeue(srv.jobs.get('job_back1'));
    const j = disk(srv).jobs.job_back1;
    assert.equal(j.status, 'queued');
    for (const k of ['startedAt', 'runnerId', 'runnerName', 'tokenHash', 'deadline']) assert.equal(j[k], null, `${k} is cleared`);
    assert.equal(srv.jobs.queue[0], 'job_back1', 'and it is first in line');
  } finally { await srv.close(); }
});

test('a CI log is capped by the size of its file, and writing it changes nothing in the database', async () => {
  const srv = await startServer();
  try {
    srv.store.tx((d) => { d.jobs.job_log1 = ciJob('job_log1', { status: 'running' }); });
    const before = JSON.stringify(disk(srv));
    const job = srv.jobs.get('job_log1');
    srv.jobs.appendLog(job, 'x'.repeat(3 * 1024 * 1024));
    srv.jobs.appendLog(job, 'y'.repeat(3 * 1024 * 1024));
    srv.jobs.appendLog(job, 'never written');
    const log = srv.jobs.readLog(job);
    assert.ok(log.length <= 5 * 1024 * 1024 + 100, 'the log stops at 5 MB');
    assert.match(log, /log truncated at 5 MB/);
    assert.doesNotMatch(log, /never written/);
    assert.equal(JSON.stringify(disk(srv)), before, 'nothing about the log is written to the database');
    assert.deepEqual(unsavedPaths(srv.store), [], 'and nothing is left in memory that the disk does not have');
  } finally { await srv.close(); }
});

test('ticket and change numbers are saved with the ticket and the change', async () => {
  const srv = await startServer();
  try {
    createUser(srv, 'alice', 'first long pass!');
    const alice = srv.store.userByName('alice');
    const t1 = srv.ops.file(alice, { title: 'The first ticket', body: 'One.' });
    const t2 = srv.ops.file(alice, { title: 'The second ticket', body: 'Two.' });
    assert.deepEqual([t1.id, t2.id], ['T-0001', 'T-0002']);
    const d = disk(srv);
    assert.equal(d.ops.seq.ticket, 2, 'the counter on disk matches the tickets on disk');
    assert.ok(d.ops.tickets['T-0002']);
  } finally { await srv.close(); }
});

test('a refused spend leaves no empty budget record behind', async () => {
  const srv = await startServer();
  try {
    assert.throws(() => srv.budgets.entry('user:nobody', -5, 'sandbox_minutes'), /credits/);
    assert.equal(srv.store.data.budgets['user:nobody'], undefined);
    srv.budgets.entry('user:somebody', 3, 'participate', 'ref-1');
    assert.equal(disk(srv).budgets['user:somebody'].balance, 3);
  } finally { await srv.close(); }
});

test('usage counts waiting for the timer survive a failed write, and reach the disk once', async () => {
  const srv = await startServer();
  try {
    const b = srv.billing;
    const real = srv.store.flush.bind(srv.store);
    // A real failed write: the store puts memory back to the file, then the error goes up.
    let fail = true;
    srv.store.flush = () => { if (fail) { srv.store.restore(); throw new Error('disk full'); } return real(); };
    b.record('user:alice', 'fn_invocations', 3);
    assert.throws(() => b.flushNow(), /disk full/);
    assert.throws(() => b.flushNow(), /disk full/);
    assert.equal(b.usage('user:alice').fn_invocations, 3, 'the counts were not lost with the undo');
    fail = false;
    b.flushNow();
    srv.store.flush = real;
    const saved = Object.values(disk(srv).billing.usage['user:alice'])[0];
    assert.equal(saved.fn_invocations, 3, 'written once, not once per try');
    assert.equal(b.usage('user:alice').fn_invocations, 3, 'and not counted twice in memory either');
  } finally { await srv.close(); }
});
