// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Builds and functions under load: caps, quotas, cancelling, what is kept (the second review's compute findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { HttpError } from '../src/errors.js';

const pipeline = (extra = {}) => packFiles([{ path: 'gitcha-ci.json', data: JSON.stringify({ image: 'local', steps: [{ name: 'step-one', run: 'true' }], timeout: '1m', ...extra }) }]);
const queue = (srv, token, tar) => api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: tar.toString('base64') } });

/** alice (the first account, so the administrator), bob, and a runner that serves everyone. */
async function setup(opts = {}) {
  const srv = await startServer(opts);
  const alice = createUser(srv, 'alice', 'first long pass!');
  const bob = createUser(srv, 'bob', 'second long pass');
  const ta = await deviceLogin(srv, alice);
  const tb = await deviceLogin(srv, bob);
  const reg = srv.jobs.createRegistration(srv.store.userByName('alice'), {}, '127.0.0.1');
  const reg2 = srv.jobs.register({ token: reg.token, name: 'test' }, '127.0.0.1');
  const runner = srv.jobs.authRunner(reg2.token);
  return { srv, ta, tb, runner, runnerToken: reg2.token, bobRec: srv.store.userByName('bob') };
}

test('LIM-2: one owner cannot queue builds without limit, and the pipeline is not copied into every record', async () => {
  const { srv, ta, tb, runner } = await setup({ overrides: { compute: { maxActiveJobs: 3 } } });
  try {
    const first = await queue(srv, tb, pipeline());
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.spec, undefined, 'the run view does not carry the pipeline');
    for (let i = 0; i < 2; i++) assert.equal((await queue(srv, tb, pipeline())).status, 201);
    const over = await queue(srv, tb, pipeline());
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.equal(over.body.error, 'too_many_jobs');
    assert.equal((await queue(srv, ta, pipeline())).status, 201, 'another tenant is not held up by bob\'s pile');

    assert.equal(srv.store.data.jobs[first.body.id].spec, undefined, 'the record holds a pointer, not the whole pipeline');
    assert.equal((await api(srv.url, 'GET', '/api/v1/ci/runs', { token: tb })).body.runs[0].spec, undefined);
    const one = await api(srv.url, 'GET', `/api/v1/ci/runs/${first.body.id}`, { token: tb });
    assert.equal(one.body.spec.pipeline.steps[0].name, 'step-one', 'the single run still shows it');
    const got = await srv.jobs.claim(runner, 50);
    assert.equal(got.job.spec.pipeline.steps[0].name, 'step-one', 'and so does the runner that claims it');
  } finally { await srv.close(); }
});

test('LIM-1b: a build\'s source is removed from the blob directory when the build ends', async () => {
  const { srv, tb } = await setup();
  try {
    const r = await queue(srv, tb, pipeline());
    const blob = path.join(srv.store.blobDir, srv.store.data.jobs[r.body.id].sourceSha);
    assert.ok(fs.existsSync(blob), 'kept while the build waits');
    const c = await api(srv.url, 'POST', `/api/v1/ci/runs/${r.body.id}/cancel`, { token: tb });
    assert.equal(c.body.status, 'cancelled');
    assert.equal(fs.existsSync(blob), false, 'gone once it is cancelled');
  } finally { await srv.close(); }
});

test('TRIG-1: cancelling a running build meters the minutes it used', async () => {
  const { srv, tb, runner, runnerToken } = await setup();
  try {
    const r = await queue(srv, tb, pipeline());
    const got = await srv.jobs.claim(runner, 50);
    assert.equal(got.job.id, r.body.id);
    srv.clock.advance(90_000);
    const c = await api(srv.url, 'POST', `/api/v1/ci/runs/${r.body.id}/cancel`, { token: tb });
    assert.equal(c.body.status, 'cancelled');
    assert.equal(srv.billing.usage('user:bob').build_minutes, 2, 'ninety seconds is two started minutes');
    // What the runner sees on its next log call: this job is over, stop.
    const late = await fetch(`${srv.url}/api/v1/runner/jobs/${r.body.id}/log`, { method: 'POST', headers: { Authorization: `Bearer ${runnerToken}`, 'X-Gitcha-Job-Token': got.jobToken, 'Content-Type': 'text/plain' }, body: 'more\n' });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).error, 'job_finished');
  } finally { await srv.close(); }
});

test('FN-1: a call nobody served leaves nothing behind, bills nothing, and waiting calls are capped per owner', async () => {
  const { srv } = await setup({ overrides: { compute: { queueWaitMs: 20, maxQueuedCalls: 2 } } });
  try {
    const owner = { type: 'user', name: 'bob' };
    const fn = { name: 'f', owner, versions: [{ version: 1, runtime: 'sh', entry: 'f.sh', image: 'local', memoryMb: 64, timeoutMs: 10, sourceSha: null, public: true }], active: 1, invocations: 0 };
    srv.store.data.functions[srv.functions.key(owner, 'f')] = fn;
    const out = await srv.functions.invoke(fn, { method: 'POST', path: '/', query: {}, headers: {}, body: Buffer.alloc(100_000, 1) });
    assert.equal(out.status, 503);
    assert.equal(srv.jobs.live.size, 0, 'the unserved call and its body are not kept');
    assert.equal(srv.billing.usage('user:bob').fn_invocations ?? 0, 0, 'a call no runner ran costs the owner nothing');

    const call = () => srv.jobs.enqueue({ kind: 'fn', owner, timeoutMs: 1000, spec: { fn: {}, request: { body: '' } } });
    call(); call();
    assert.throws(call, (err) => err instanceof HttpError && err.status === 429, 'a third waiting call is refused');
    assert.doesNotThrow(() => srv.jobs.enqueue({ kind: 'fn', owner: { type: 'user', name: 'alice' }, timeoutMs: 1000, spec: { fn: {}, request: { body: '' } } }));
  } finally { await srv.close(); }
});

test('QUOTA-1: builds still waiting count against the plan\'s minutes, and a sandbox agent\'s budget is reserved when queueing', async () => {
  const { srv, tb, runner, bobRec } = await setup({ env: { GITCHA_BILLING: 'yes' } });
  try {
    srv.billing.record('user:bob', 'build_minutes', 299); // the free plan has 300; one is left
    assert.equal((await queue(srv, tb, pipeline())).status, 201);
    const second = await queue(srv, tb, pipeline());
    assert.equal(second.status, 402, `the queued build already holds the last minute: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.error, 'quota_exceeded');

    // An agent with 5 credits queues a build that may run 5 minutes: all 5 are held, and the unused 4 come back.
    srv.budgets.entry('agent:ada', 5, 'seed');
    const queued = srv.ci.run(bobRec, { tarball: pipeline({ timeout: '5m' }), sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1');
    assert.equal(srv.budgets.balance('agent:ada'), 0, 'reserved at queue time');
    assert.throws(() => srv.ci.run(bobRec, { tarball: pipeline(), sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1'), (e) => e.status === 402, 'nothing left to reserve for a second build');
    await srv.jobs.cancel(bobRec, (await srv.jobs.claim(runner, 50)).job.id, () => true).catch(() => {}); // the plan-paid one waits first
    const next = await srv.jobs.claim(runner, 50);
    assert.equal(next.job.id, queued.id);
    srv.clock.advance(20_000);
    await srv.jobs.complete(srv.jobs.get(queued.id), { status: 'succeeded', exitCode: 0 });
    assert.equal(srv.budgets.balance('agent:ada'), 4, 'one started minute used, four given back');
  } finally { await srv.close(); }
});

test('LOG-1: a log piece over the cap keeps its first part and gets a plain 413 on a connection that still works', async () => {
  const { srv, tb, runner, runnerToken } = await setup();
  try {
    const r = await queue(srv, tb, pipeline());
    const got = await srv.jobs.claim(runner, 50);
    const post = (text) => fetch(`${srv.url}/api/v1/runner/jobs/${r.body.id}/log`, {
      method: 'POST', headers: { Authorization: `Bearer ${runnerToken}`, 'X-Gitcha-Job-Token': got.jobToken, 'Content-Type': 'text/plain' }, body: text,
    });
    const big = await post('x'.repeat(300 * 1024));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error, 'log_piece_too_large');
    assert.equal(srv.jobs.readLog(srv.jobs.get(r.body.id)).length, 256 * 1024, 'the first 256 KiB were kept');
    assert.equal((await post('after\n')).status, 204, 'the next call is fine');
  } finally { await srv.close(); }
});
