// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The runner under a noisy build and a cancelled one (LOG-1, TRIG-1), with a real server and the process backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, api, deviceLogin } from '../../server/test/helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { RunnerClient, loop, executeJob, BACKENDS } from '../lib/runner.js';
import { command } from '../lib/backends/bcontain.js';

const b64 = (steps) => packFiles([{ path: 'gitcha-ci.json', data: JSON.stringify({ image: 'local', steps, timeout: '1m' }) }]).toString('base64');
let srv, token, client, config;

before(async () => {
  srv = await startServer({ overrides: { compute: { defaultImage: 'local', maxJobMs: 60_000, orgvm: false } } });
  token = await deviceLogin(srv, createUser(srv, 'alice', 'first long pass!'));
  const reg = await api(srv.url, 'POST', '/api/v1/runners/registrations', { token, body: {} });
  const r = await new RunnerClient({ server: srv.url, version: 'test' }).register({ token: reg.body.token, name: 'fix-runner', backend: 'process' });
  client = new RunnerClient({ server: srv.url, token: r.token, version: 'test' });
  config = { backend: 'process', unsafeProcess: true, concurrency: 1, defaultImage: 'local' };
});
after(() => srv.close());

const status = async (id) => (await api(srv.url, 'GET', `/api/v1/ci/runs/${id}`, { token })).body;

test('LOG-1: a build that prints 400 KB in one burst succeeds and its log is kept', async () => {
  const run = await api(srv.url, 'POST', '/api/v1/ci/runs', {
    token, body: { tarball: b64([{ name: 'noisy', run: "yes 'a line of ordinary build output' | head -c 400000; echo; echo END-OF-OUTPUT" }]) },
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  await loop(client, config, { once: true });
  const done = await status(run.body.id);
  assert.equal(done.status, 'succeeded', `${done.error} ${done.log.slice(0, 200)}`);
  assert.match(done.log, /END-OF-OUTPUT/, 'the end of the output arrived');
  assert.ok(done.log.length > 400_000, `${done.log.length} characters kept`);
});

test('TRIG-1: a cancelled build is stopped on the runner, not left to run out its time', async () => {
  const run = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: b64([{ name: 'long', run: 'sleep 40' }]) } });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const working = loop(client, config, { once: true });
  for (let i = 0; i < 50 && (await status(run.body.id)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await status(run.body.id)).status, 'running');
  const t0 = Date.now();
  assert.equal((await api(srv.url, 'POST', `/api/v1/ci/runs/${run.body.id}/cancel`, { token })).body.status, 'cancelled');
  await working;
  const took = Date.now() - t0;
  assert.ok(took < 15_000, `the runner stopped ${took} ms after the cancel`);
  assert.equal((await status(run.body.id)).status, 'cancelled');
});

test('FMT-2: the launcher is never handed an image that starts with a dash', () => {
  for (const image of ['--help', '-e', '--privileged']) assert.throws(() => command({ image, port: 1, token: 't' }), /image/, image);
  assert.ok(command({ image: 'docker.io/library/node:22-alpine', port: 1, token: 't' }).includes('docker.io/library/node:22-alpine'));
});

test('FMT-2: a function never gets more memory than the runner\'s own cap', async () => {
  let asked = null;
  BACKENDS.fake = { assertAllowed() {}, run: async (o) => { asked = o; return { code: 0, output: '', timedOut: false }; } };
  const calls = [];
  const stub = { log: async () => {}, source: async () => null, complete: async (...a) => { calls.push(a); } };
  const job = { id: 'inv_x', kind: 'fn', timeoutMs: 1000, hasSource: false, owner: { type: 'user', name: 'alice' },
    spec: { fn: { name: 'f', runtime: 'sh', entry: 'f.sh', image: 'local', memoryMb: 4096, timeoutMs: 1000 }, request: { method: 'GET', path: '/', query: {}, headers: {}, body: '' } } };
  await executeJob(stub, { backend: 'fake', memoryMb: 512, defaultImage: 'local' }, { job, job_token: 'j' });
  assert.ok(asked, `the backend was reached (${JSON.stringify(calls)})`);
  assert.equal(asked.memoryMb, 512, 'asked for 4096, the operator allows 512');
  delete BACKENDS.fake;
});

test('SITE-1 class: the runner unpacks a source only as far as the server says it may grow', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { prepare } = await import('../lib/script.js');
  // 3 MiB of zeros is a few KB packed. The server hands the runner the cap with the job.
  const source = packFiles([{ path: 'big.bin', data: Buffer.alloc(3 * 1024 * 1024) }]);
  const job = (limits) => ({ kind: 'ci', spec: { pipeline: { steps: [{ name: 'a', run: 'true' }] } }, ...(limits ? { limits } : {}) });
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-prep-'));
  const small = dir();
  assert.throws(() => prepare(small, job({ maxUnpackedBytes: 1024 * 1024 }), source), /./, 'over the cap the source is refused');
  assert.equal(fs.existsSync(path.join(small, 'src', 'big.bin')), false, 'and nothing of it is written');
  const roomy = dir();
  prepare(roomy, job({ maxUnpackedBytes: 8 * 1024 * 1024 }), source);
  assert.equal(fs.statSync(path.join(roomy, 'src', 'big.bin')).size, 3 * 1024 * 1024, 'within the cap it unpacks');
  for (const d of [small, roomy]) fs.rmSync(d, { recursive: true, force: true });
});
