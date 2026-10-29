// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Usage: counted at admission, settled at the end, flushed even when the disk is unwell or the process is told to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup, DAY } from './billing-fixtures.js';
import { tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => path.join(here, '..', 'src', f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => { const lines = []; return { lines, info: (m) => lines.push(m), error: (m) => lines.push(m) }; };

test('BIL-7a/7c: a reservation counts at admission, so concurrent work cannot all pass the check', async () => {
  const { srv } = await setup();
  try {
    const b = srv.billing;
    const taken = [];
    for (let i = 0; i < 30; i++) taken.push(b.reserve('user:alice', 'build_minutes', 10)); // Free: 300 minutes
    assert.deepEqual(b.usage('user:alice'), { build_minutes: 300 });
    assert.throws(() => b.reserve('user:alice', 'build_minutes', 10), (e) => e.status === 402 && e.code === 'quota_exceeded');
    assert.equal(b.usage('user:alice').build_minutes, 300, 'a refused reservation counts nothing');

    // Nothing was run by most of them: the unused part comes back, and a job that never started costs nothing.
    b.settle(taken[0], 3);
    b.release(taken[1]);
    assert.equal(b.usage('user:alice').build_minutes, 300 - 7 - 10);
    b.settle(taken[0], 3);
    b.release(taken[1]);
    assert.equal(b.usage('user:alice').build_minutes, 283, 'settling twice changes nothing');
    assert.doesNotThrow(() => b.reserve('user:alice', 'build_minutes', 10), 'the returned minutes are available again');
  } finally { await srv.close(); }
});

test('BIL-7b: a cancelled build is metered for the time it ran', async () => {
  const { srv } = await setup();
  try {
    const b = srv.billing;
    const res = b.reserve('team:acme', 'build_minutes', 30);
    srv.clock.advance(40 * DAY); // settled in a later month: the month it was admitted in is corrected
    const month = new Date(res.at).toISOString().slice(0, 7);
    b.settle(res, 2);
    assert.equal(b.usage('team:acme', res.at).build_minutes, 2, `${month} shows the two minutes it ran`);
    assert.equal(b.usage('team:acme').build_minutes ?? 0, 0, 'and the new month is untouched');
    const over = b.reserve('team:acme', 'fn_invocations', 1);
    b.settle(over, 4);
    assert.equal(b.usage('team:acme').fn_invocations, 4, 'running longer than reserved is counted, not refused');
  } finally { await srv.close(); }
});

test('BIL-7: with billing off a reservation never refuses', async () => {
  const off = await (await import('./helpers.js')).startServer();
  try {
    for (let i = 0; i < 400; i++) off.billing.reserve('user:x', 'build_minutes', 10);
    assert.equal(off.billing.usage('user:x').build_minutes, 4000);
  } finally { await off.close(); }
});

test('BIL-7d: a failed write in the usage timer is logged and retried, and the process lives', async () => {
  const { srv } = await setup();
  try {
    const b = srv.billing;
    const log = quiet();
    b.log = log;
    b.flushMs = 20;
    const real = srv.store.flush.bind(srv.store);
    let calls = 0;
    srv.store.flush = () => { calls++; if (calls <= 2) throw new Error('disk full'); real(); };
    b.record('user:alice', 'fn_invocations', 3);
    for (let i = 0; i < 100 && calls < 3; i++) await sleep(20);
    assert.ok(calls >= 3, `the timer tried again (${calls} attempts)`);
    assert.ok(log.lines.some((l) => /disk full/.test(l)), 'the failure is logged');
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8'));
    assert.equal(Object.values(onDisk.billing.usage['user:alice'])[0].fn_invocations, 3, 'and the count reached the disk in the end');
  } finally { await srv.close(); }
});

test('BIL-7e: usage not yet written is written when the process stops', () => {
  const dir = tmpDir();
  const script = `
    import { Store } from ${JSON.stringify(src('store.js'))};
    import { BillingService } from ${JSON.stringify(src('billing/billing.js'))};
    const store = new Store(process.argv[1]);
    const config = { publicUrl: 'http://x', billing: { enabled: true, stripe: {}, paypal: {}, priceIds: { stripe: {}, paypal: {} } } };
    const b = new BillingService({ store, config, teams: {}, log: { info() {}, error() {} } });
    b.record('user:alice', 'fn_invocations', 7);
    // what index.js does on a stop signal
    process.on('SIGTERM', () => process.exit(0));
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => {}, 5000);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(Object.values(db.billing.usage['user:alice'])[0].fn_invocations, 7, 'the seven counted calls were not lost to the stop');
});
