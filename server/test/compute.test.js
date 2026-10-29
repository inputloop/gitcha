// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Builds and functions under load: caps, quotas, cancelling, what is kept (the second review's compute findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { HttpError } from '../src/errors.js';
import { JobService } from '../src/compute/jobs.js';
import { CiService } from '../src/compute/ci.js';

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

test('LIM-1b: a build\'s source is kept in a file of its own, not among the hash-named blobs, and goes when the build ends', async () => {
  const { srv, tb, runner, runnerToken } = await setup();
  try {
    const tar = pipeline();
    const r = await queue(srv, tb, tar);
    // Blobs are named by the hash of their bytes and are checked against it on their first read after a start:
    // a source under a random name among them would read as damaged after a restart.
    for (const name of fs.readdirSync(srv.store.blobDir)) {
      if (name.includes('.tmp')) continue;
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(srv.store.blobDir, name))).digest('hex'), name, `blob ${name} is named by its hash`);
    }
    const file = path.join(srv.jobs.sourceDir, srv.store.data.jobs[r.body.id].sourceSha);
    assert.ok(fs.existsSync(file), 'kept while the build waits');
    // The runner still gets the source from the server.
    const got = await srv.jobs.claim(runner, 50);
    const src = await fetch(`${srv.url}/api/v1/runner/jobs/${r.body.id}/source`, { headers: { Authorization: `Bearer ${runnerToken}`, 'X-Gitcha-Job-Token': got.jobToken } });
    assert.equal(src.status, 200);
    assert.deepEqual(Buffer.from(await src.arrayBuffer()), tar);
    const c = await api(srv.url, 'POST', `/api/v1/ci/runs/${r.body.id}/cancel`, { token: tb });
    assert.equal(c.body.status, 'cancelled');
    assert.equal(fs.existsSync(file), false, 'gone once it is cancelled');
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

// ---- who may register a runner, and what a runner may touch (RUN-1, RUN-2, FMT-2) ----------------------------
test('RUN-1: a registration token works once, for an hour, and can be listed and revoked', async () => {
  const { srv, ta } = await setup();
  try {
    const mint = (body = {}) => api(srv.url, 'POST', '/api/v1/runners/registrations', { token: ta, body });
    const one = (await mint()).body;
    assert.ok(srv.jobs.register({ token: one.token, name: 'first' }, '127.0.0.1').token);
    assert.throws(() => srv.jobs.register({ token: one.token, name: 'second' }, '127.0.0.1'), (e) => e.status === 401, 'the same token a second time');

    const two = (await mint({ uses: 2 })).body;
    srv.jobs.register({ token: two.token, name: 'a' }, '127.0.0.1');
    srv.jobs.register({ token: two.token, name: 'b' }, '127.0.0.1');
    assert.throws(() => srv.jobs.register({ token: two.token, name: 'c' }, '127.0.0.1'), (e) => e.status === 401);
    assert.equal((await mint({ uses: 500 })).status, 400);

    const open = (await mint()).body;
    const listed = await api(srv.url, 'GET', '/api/v1/runners/registrations', { token: ta });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.registrations.length, 1, 'only the unused one is open');
    assert.equal(JSON.stringify(listed.body).includes(open.token), false, 'the token itself is never listed');
    const revoked = await api(srv.url, 'DELETE', `/api/v1/runners/registrations/${listed.body.registrations[0].id}`, { token: ta });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.throws(() => srv.jobs.register({ token: open.token, name: 'late' }, '127.0.0.1'), (e) => e.status === 401, 'revoked');

    const old = (await mint()).body;
    srv.clock.advance(61 * 60_000);
    assert.throws(() => srv.jobs.register({ token: old.token, name: 'late' }, '127.0.0.1'), (e) => e.status === 401, 'an hour is up');
  } finally { await srv.close(); }
});

test('RUN-2: a job token is good only for the runner that claimed the job', async () => {
  const { srv, tb, runner, runnerToken } = await setup();
  try {
    const other = srv.jobs.register({ token: srv.jobs.createRegistration(srv.store.userByName('alice'), {}, '127.0.0.1').token, name: 'other' }, '127.0.0.1');
    const r = await queue(srv, tb, pipeline());
    const got = await srv.jobs.claim(runner, 50);
    const post = (bearer) => fetch(`${srv.url}/api/v1/runner/jobs/${r.body.id}/log`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'X-Gitcha-Job-Token': got.jobToken, 'Content-Type': 'text/plain' }, body: 'x\n' });
    assert.equal((await post(other.token)).status, 401, 'another runner holding the job token');
    assert.equal((await post(runnerToken)).status, 204, 'the runner that claimed it is accepted')
  } finally { await srv.close(); }
});

test('FMT-2: an image that could be read as an option is refused in pipelines and functions', async () => {
  const { normalizePipeline, normalizeFunction } = await import('../src/compute/formats.js');
  for (const image of ['--help', '-e', '--privileged']) {
    assert.throws(() => normalizePipeline({ image, steps: [{ name: 's', run: 'true' }] }), /image/, `pipeline image ${image}`);
    assert.throws(() => normalizeFunction({ name: 'f', runtime: 'sh', entry: 'f.sh', image }, new Map([['f.sh', Buffer.from('true')]])), /image/, `function image ${image}`);
  }
  assert.equal(normalizePipeline({ image: 'docker.io/library/node:22-alpine', steps: [{ name: 's', run: 'true' }] }).image, 'docker.io/library/node:22-alpine');
});

test('KEY-1: the CI door names its purpose, so an agent key opens it (and only it) once keys are door-strict', async () => {
  const { srv, bobRec } = await setup();
  try {
    srv.agents.register(bobRec, { handle: 'ada', name: 'Ada', model: 'claude-opus-5-5' }, '127.0.0.1');
    srv.budgets.entry('agent:ada', 5, 'seed');
    const key = srv.keys.createAgentKey(bobRec, srv.store.data.agents.ada, { purpose: 'sandbox' }, '127.0.0.1').token;
    // What keys.js does after KEY-1: a gak_ key resolves for a door that names the purpose it was issued for, and for no other.
    const real = srv.principals.fromToken.bind(srv.principals);
    const asked = [];
    srv.principals.fromToken = (token, ip, opts = {}) => { asked.push(opts.purpose); return token.startsWith('gak_') && opts.purpose !== 'sandbox' ? null : real(token, ip, opts); };
    const r = await api(srv.url, 'POST', '/api/v1/ci/runs', { token: key, body: { tarball: pipeline().toString('base64') } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(asked, ['sandbox'], 'the door says what it is for');
    assert.equal(srv.jobs.get(r.body.id).sandboxAgent, 'ada');
  } finally { await srv.close(); }
});

test('SITE-1 class: a function, a pipeline and a handed-out job each have a cap on what they unpack to', async () => {
  const { srv, tb, runner, bobRec } = await setup({ env: { GITCHA_MAX_PACKAGE_BYTES: String(100_000) } });
  try {
    // 3 MiB of zeros packs to a few KB, far under the upload limit, and is over four times it.
    const bomb = (name) => packFiles([{ path: name, data: Buffer.alloc(3 * 1024 * 1024) }]);
    assert.ok(bomb('gitcha.fn.json').length < 100_000);
    assert.throws(() => srv.functions.deploy(bobRec, { tarball: bomb('gitcha.fn.json') }, '127.0.0.1'), (e) => e.status === 400 && e.code === 'bad_tarball', 'a function is cut off at four times the package limit');
    assert.equal((await queue(srv, tb, bomb('gitcha-ci.json'))).body.error, 'bad_tarball', 'a pipeline source too');

    // The runner is told the same cap with the job.
    assert.equal((await queue(srv, tb, pipeline())).status, 201);
    const got = await srv.jobs.claim(runner, 50);
    assert.equal(got.job.limits.maxUnpackedBytes, 400_000);

    // And a caller that names no cap gets a bounded one, not 200 MiB.
    const { pipelineFromTarball } = await import('../src/compute/ci.js');
    assert.throws(() => pipelineFromTarball(packFiles([{ path: 'big.bin', data: Buffer.alloc(101 * 1024 * 1024) }])), /./);
  } finally { await srv.close(); }
});

test('AGENT-1: every build an agent queues holds credits of its own, and only the unused part of each comes back', async () => {
  const { srv, runner, bobRec } = await setup();
  try {
    srv.budgets.entry('agent:ada', 10, 'seed');
    const run = (tarball) => srv.ci.run(bobRec, { tarball, sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1');
    const first = run(pipeline({ timeout: '5m' }));
    const second = run(pipeline({ timeout: '5m' }));
    assert.equal(srv.budgets.balance('agent:ada'), 0, 'two builds, two holds of five');
    assert.throws(() => run(pipeline()), (e) => e.status === 402, 'and nothing is left for a third');
    for (const id of [first.id, second.id]) {
      const got = await srv.jobs.claim(runner, 50);
      assert.equal(got.job.id, id);
      srv.clock.advance(20_000);
      await srv.jobs.complete(srv.jobs.get(id), { status: 'succeeded', exitCode: 0 });
    }
    assert.equal(srv.budgets.balance('agent:ada'), 8, 'a started minute each: 10 - 1 - 1');
    // A build cancelled before it starts gives all of its hold back.
    const third = run(pipeline({ timeout: '3m' }));
    assert.equal(srv.budgets.balance('agent:ada'), 5);
    await srv.jobs.cancel(bobRec, third.id, () => true);
    assert.equal(srv.budgets.balance('agent:ada'), 8);
  } finally { await srv.close(); }
});

test('AGENT-1: a build that asks for more minutes than the agent has is cut to the credits it can hold', async () => {
  const { srv, tb, bobRec } = await setup();
  try {
    srv.budgets.entry('agent:ada', 3, 'seed');
    const job = srv.ci.run(bobRec, { tarball: pipeline({ timeout: '10m' }), sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1');
    assert.equal(job.timeoutMs, 3 * 60_000, 'a three-minute limit, one credit a minute');
    assert.equal(srv.budgets.balance('agent:ada'), 0);
    const shown = (await api(srv.url, 'GET', `/api/v1/ci/runs/${job.id}`, { token: tb })).body;
    assert.match(shown.log, /time limit cut to 3 minutes/, 'the build log says why');
    assert.throws(() => srv.ci.run(bobRec, { tarball: pipeline(), sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1'), (e) => e.status === 402, 'no credits, no build');
  } finally { await srv.close(); }
});

test('AGENT-1: a build running when the server stopped is metered once at the next start, for at most its own time limit', async () => {
  const { srv, runner, bobRec } = await setup();
  try {
    const restart = () => {
      const jobs = new JobService({ store: srv.store, config: srv.config, teams: srv.teams, clock: srv.clock });
      return new CiService({ ...srv, jobs });
    };
    // An old build the sweep failed at some earlier start, never metered: a later start leaves it alone.
    srv.store.tx((d) => { d.jobs.job_old = { id: 'job_old', kind: 'ci', owner: { type: 'user', name: 'bob' }, status: 'failed', error: 'The server restarted while this job ran.', startedAt: 1, finishedAt: 1 + 3_600_000, timeoutMs: 60_000 }; });

    srv.budgets.entry('agent:ada', 5, 'seed');
    const agent = srv.ci.run(bobRec, { tarball: pipeline({ timeout: '5m' }), sandboxAgent: 'ada', paidByPlan: false }, '127.0.0.1');
    assert.equal((await srv.jobs.claim(runner, 50)).job.id, agent.id);
    srv.clock.advance(20_000);
    restart();
    assert.equal(srv.jobs.get(agent.id).status, 'failed');
    assert.equal(srv.budgets.balance('agent:ada'), 4, 'one started minute used, four given back');
    restart();
    assert.equal(srv.budgets.balance('agent:ada'), 4, 'a second start gives nothing back again');

    const plan = srv.ci.run(bobRec, { tarball: pipeline() }, '127.0.0.1'); // a one-minute limit
    assert.equal((await srv.jobs.claim(runner, 50)).job.id, plan.id);
    srv.clock.advance(40 * 60_000); // the server was down for forty minutes
    restart();
    assert.equal(srv.billing.usage('user:bob').build_minutes, 1, 'the downtime is not build time, and the old build is not charged now');
  } finally { await srv.close(); }
});
