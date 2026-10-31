// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The TopoForge routes: a build, a function and the instance as drawings, and a drawing checked as a pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { pipelineToDrawing } from '../../extension/lib/topoforge.js';
import { pipelineFromDrawing } from '../../extension/lib/formats.js';

const pipe = { image: 'local', timeout: '1m', steps: [{ name: 'install', run: 'true' }, { name: 'test', run: 'false' }, { name: 'ship', run: 'true' }] };
const tarOf = (files) => packFiles(Object.entries(files).map(([path, data]) => ({ path, data: typeof data === 'string' ? data : JSON.stringify(data) })));

async function setup() {
  const srv = await startServer();
  const alice = createUser(srv, 'alice', 'first long pass!'); // the administrator
  const bob = createUser(srv, 'bob', 'second long pass');
  const carol = createUser(srv, 'carol', 'third long passw');
  const reg = srv.jobs.createRegistration(srv.store.userByName('alice'), {}, '127.0.0.1');
  const runnerToken = srv.jobs.register({ token: reg.token, name: 'r1' }, '127.0.0.1').token;
  return { srv, ta: await deviceLogin(srv, alice), tb: await deviceLogin(srv, bob), tc: await deviceLogin(srv, carol), runner: srv.jobs.authRunner(runnerToken) };
}

test('a build is drawn with each step coloured by its result, and only for people who may see the build', async () => {
  const { srv, tb, tc, runner } = await setup();
  try {
    const run = await api(srv.url, 'POST', '/api/v1/ci/runs', { token: tb, body: { tarball: tarOf({ 'gitcha-ci.json': pipe }).toString('base64') } });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const got = await srv.jobs.claim(runner, 50);
    const job = srv.jobs.get(got.job.id);
    srv.jobs.appendLog(job, '\n@@GITCHA-STEP@@ install\nfine\n@@GITCHA-STEP@@ test\n@@GITCHA-FAILED@@ test 1\n');
    await srv.jobs.complete(job, { status: 'failed', exitCode: 1 });

    const r = await fetch(`${srv.url}/api/v1/ci/runs/${run.body.id}/topoforge`, { headers: { Authorization: `Bearer ${tb}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="build-job_[\w-]+\.topoforge\.json"$/, 'a download, never a page');
    const doc = await r.json();
    assert.equal(doc.format, 'topoforge');
    const steps = Object.fromEntries(doc.pages[0].nodes.filter((n) => n.data.step).map((n) => [n.data.step, n.data.result]));
    assert.deepEqual(steps, { install: 'passed', test: 'failed', ship: 'not run' });
    assert.deepEqual(pipelineFromDrawing(doc).steps.map((s) => s.name), ['install', 'test', 'ship'], 'and it reads back as the same pipeline');

    const other = await api(srv.url, 'GET', `/api/v1/ci/runs/${run.body.id}/topoforge`, { token: tc });
    assert.equal(other.status, 404, 'carol may not see bob\'s build, so she may not draw it');
  } finally { await srv.close(); }
});

test('a function is drawn as a box, and a chain as its steps', async () => {
  const { srv, tb } = await setup();
  try {
    srv.functions.deploy(srv.store.userByName('bob'), { tarball: tarOf({ 'gitcha.fn.json': { name: 'hello', runtime: 'node', entry: 'index.mjs' }, 'index.mjs': 'export default () => "hi"' }) }, '127.0.0.1');
    srv.functions.deploy(srv.store.userByName('bob'), { tarball: tarOf({
      'gitcha.fn.json': { name: 'flow', entry: 'flow.topoforge.json' },
      'flow.topoforge.json': { format: 'topoforge', version: 1, pages: [{ nodes: [{ id: 'a', data: { function: 'hello' } }, { id: 'b', data: { function: 'hello' } }], links: [{ a: { id: 'a' }, b: { id: 'b' }, arrows: 'end' }] }] },
    }) }, '127.0.0.1');
    const one = await api(srv.url, 'GET', '/api/v1/functions/bob/hello/topoforge', { token: tb });
    assert.equal(one.status, 200);
    const flow = await api(srv.url, 'GET', '/api/v1/functions/bob/flow/topoforge', { token: tb });
    assert.equal(flow.status, 200);
    const doc = flow.body;
    assert.deepEqual(doc.pages[0].nodes.filter((n) => n.data.function).map((n) => n.data.function), ['hello', 'hello']);
  } finally { await srv.close(); }
});

test('the instance map is for administrators and staff only', async () => {
  const { srv, ta, tb } = await setup();
  try {
    const no = await api(srv.url, 'GET', '/api/v1/topoforge/system', { token: tb });
    assert.equal(no.status, 403);
    const yes = await fetch(`${srv.url}/api/v1/topoforge/system`, { headers: { Authorization: `Bearer ${ta}` } });
    assert.equal(yes.status, 200);
    const doc = await yes.json();
    const texts = doc.pages[0].nodes.map((n) => n.text);
    assert.ok(texts.includes('gitcha-server') && texts.includes('r1') && texts.includes('db.json (file store)'));
  } finally { await srv.close(); }
});

test('a drawing can be checked as a pipeline or a chain without running anything', async () => {
  const { srv, tb } = await setup();
  try {
    const drawing = pipelineToDrawing(pipe);
    const r = await api(srv.url, 'POST', '/api/v1/topoforge/import', { token: tb, body: { drawing } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.pipeline.steps.map((s) => s.name), ['install', 'test', 'ship']);
    assert.equal(r.body.pipeline.timeoutMs, 60_000);
    assert.equal(Object.keys(srv.store.data.jobs).length, 0, 'nothing was queued');

    drawing.pages[0].links.push({ id: 'back', a: { id: drawing.pages[0].links[1].b.id }, b: { id: drawing.pages[0].links[0].a.id }, arrows: 'end' });
    const loop = await api(srv.url, 'POST', '/api/v1/topoforge/import', { token: tb, body: { drawing } });
    assert.equal(loop.status, 400);
    assert.match(loop.body.message, /loop/);
    const chain = await api(srv.url, 'POST', '/api/v1/topoforge/import', { token: tb, body: { drawing: pipelineToDrawing(pipe), as: 'chain' } });
    assert.equal(chain.status, 400, 'a pipeline drawing names no functions');
    assert.equal((await api(srv.url, 'POST', '/api/v1/topoforge/import', { body: { drawing } })).status, 401, 'signed-in only');
  } finally { await srv.close(); }
});
