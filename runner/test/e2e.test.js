// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// End to end: a Gitcha server, a runner on the (development) process backend,
// CI pipelines in every authoring format, and functions in every runtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, api, deviceLogin, hostGet } from '../../server/test/helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { RunnerClient, loop } from '../lib/runner.js';

const tgz = (files) => packFiles(Object.entries(files).map(([path, data]) => ({ path, data })));
const b64 = (files) => tgz(files).toString('base64');

let srv, token, client, config;

/** Let the runner take exactly the jobs that are queued now (or arrive within the wait). */
async function drain(rounds = 1) {
  for (let i = 0; i < rounds; i++) await loop(client, config, { once: true });
}

/** Invoke through a site route while a runner is serving. */
async function viaSite(host, path, opts) {
  const pending = hostGet(srv.url, host, path, opts);
  await drain();
  return pending;
}

async function waitRun(id) {
  for (let i = 0; i < 50; i++) {
    const r = await api(srv.url, 'GET', `/api/v1/ci/runs/${id}`, { token });
    if (!['queued', 'running'].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('run did not finish');
}

before(async () => {
  srv = await startServer({
    env: { GITCHA_HOSTING_DOMAINS: 'pages.test' },
    overrides: { compute: { queueWaitMs: 4000, defaultImage: 'local', maxJobMs: 60_000, orgvm: false } },
  });
  const alice = createUser(srv, 'alice', 'first long pass!');
  token = await deviceLogin(srv, alice);
  const reg = await api(srv.url, 'POST', '/api/v1/runners/registrations', { token, body: {} });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const r = await new RunnerClient({ server: srv.url, version: 'test' }).register({ token: reg.body.token, name: 'test-runner', backend: 'process' });
  client = new RunnerClient({ server: srv.url, token: r.token, version: 'test' });
  config = { backend: 'process', unsafeProcess: true, concurrency: 1, defaultImage: 'local' };
});
after(() => srv.close());

test('the process backend refuses to run unless unlocked', async () => {
  await assert.rejects(loop(client, { ...config, unsafeProcess: false }, { once: true }), /no isolation/);
});

test('CI: a JSON pipeline builds, uploads artifacts and deploys a site', async () => {
  await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'docs' } });
  const run = await api(srv.url, 'POST', '/api/v1/ci/runs', {
    token,
    body: {
      tarball: b64({
        'gitcha-ci.json': JSON.stringify({
          image: 'local', env: { GREETING: "it's built" },
          steps: [{ name: 'build', run: 'mkdir -p dist && printf "<p>%s</p>" "$GREETING" > dist/index.html' }, { name: 'check', run: 'test -f dist/index.html' }],
          artifacts: 'dist', deploy: { site: 'docs' },
        }),
      }),
    },
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  await drain();
  const done = await waitRun(run.body.id);
  assert.equal(done.status, 'succeeded', done.log);
  assert.match(done.log, /== build ==/);
  assert.match(done.log, /deployed to site docs/);
  assert.equal((await hostGet(srv.url, 'docs.pages.test', '/')).body, "<p>it's built</p>");
});

test('CI: org-mode and TopoForge pipelines compile to steps in the right order', async () => {
  const org = [
    '#+TITLE: build', '#+GITCHA_IMAGE: local', '',
    '* Steps', '#+NAME: step-one', '#+begin_src sh', '  echo one >> order.txt', '#+end_src', '',
    'Not a step:', '#+begin_src sh', 'echo ignored', '#+end_src', '',
    '#+NAME: step-two', '#+begin_src sh', '  echo two >> order.txt; cat order.txt', '#+end_src',
  ].join('\n');
  const r1 = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: b64({ 'gitcha-ci.org': org }) } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  await drain();
  const d1 = await waitRun(r1.body.id);
  assert.equal(d1.status, 'succeeded', d1.log);
  assert.match(d1.log, /one\ntwo/);

  // Drawn in TopoForge: c is drawn first but the arrows say a -> b -> c.
  const drawing = {
    format: 'topoforge', version: 1, name: 'pipeline',
    pages: [{
      id: 'p1', nodes: [
        { id: 'c', type: 'server', text: 'third', data: { run: 'echo C >> o.txt; cat o.txt' } },
        { id: 'a', type: 'server', text: 'first', data: { run: 'echo A >> o.txt', gitcha_image: 'local' } },
        { id: 'b', type: 'server', text: 'second', data: { run: 'echo B >> o.txt' } },
        { id: 'note', type: 'cloud', text: 'just a label' },
      ],
      links: [{ id: 'l1', a: { id: 'a' }, b: { id: 'b' }, arrows: 'end' }, { id: 'l2', a: { id: 'c' }, b: { id: 'b' }, arrows: 'start' }],
    }],
  };
  const r2 = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: b64({ 'gitcha-ci.topoforge.json': JSON.stringify(drawing) }) } });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  await drain();
  const d2 = await waitRun(r2.body.id);
  assert.equal(d2.status, 'succeeded', d2.log);
  assert.match(d2.log, /A\nB\nC/);
  assert.match(d2.log, /== first ==[\s\S]*== second ==[\s\S]*== third ==/);

  drawing.pages[0].links.push({ id: 'l3', a: { id: 'b' }, b: { id: 'a' }, arrows: 'end' });
  const loopRun = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: b64({ 'gitcha-ci.topoforge.json': JSON.stringify(drawing) }) } });
  assert.equal(loopRun.status, 400);
  assert.match(loopRun.body.message, /loop/);
});

test('CI: a failing step fails the run and names the step', async () => {
  const run = await api(srv.url, 'POST', '/api/v1/ci/runs', {
    token, body: { tarball: b64({ 'gitcha-ci.json': JSON.stringify({ image: 'local', steps: [{ name: 'lint', run: 'echo bad; exit 7' }, { name: 'never', run: 'echo nope' }] }) }) },
  });
  await drain();
  const done = await waitRun(run.body.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 7);
  assert.match(done.log, /step "lint" failed with exit code 7/);
  assert.doesNotMatch(done.log, /nope/);
});

test('functions: node, python, sh (CGI) and org blocks, through site routes and the API', async () => {
  const deploy = (files, team) => api(srv.url, 'PUT', '/api/v1/functions', { token, body: { tarball: b64(files), team } });
  let r = await deploy({
    'gitcha.fn.json': JSON.stringify({ name: 'hello', runtime: 'node', entry: 'index.mjs' }),
    'index.mjs': 'export default async (req) => ({ status: 201, headers: { "x-hi": "yes" }, body: { you: req.query.name ?? "anon", method: req.method, sent: req.body } });',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await deploy({ 'gitcha.fn.json': JSON.stringify({ name: 'py', runtime: 'python', entry: 'fn.py' }), 'fn.py': 'def handler(req):\n    return {"status": 200, "body": {"upper": req["body"].upper()}}\n' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await deploy({ 'gitcha.fn.json': JSON.stringify({ name: 'cgi', runtime: 'sh', entry: 'fn.sh' }), 'fn.sh': 'printf "Status: 202\\nContent-Type: text/plain\\n\\n%s %s" "$REQUEST_METHOD" "$(cat)"\n' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await deploy({
    'gitcha.fn.json': JSON.stringify({ name: 'orgfn', entry: 'handlers.org#greet' }),
    'handlers.org': '* Handlers\n#+NAME: greet\n#+begin_src js\nexport default (req) => "hello from org, " + req.path;\n#+end_src\n',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.runtime, 'node', 'the org block language picks the runtime');

  await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'app' } });
  await api(srv.url, 'PUT', '/api/v1/sites/app/deploys', {
    token, body: { tarball: b64({ 'index.html': 'home', 'gitcha.site.json': JSON.stringify({ routes: { '/api/hello': 'hello', '/api/py': 'py', '/cgi/*': 'cgi', '/org': 'orgfn', '/missing': 'nope' } }) }) },
  });

  const h = await viaSite('app.pages.test', '/api/hello?name=bryant', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } });
  assert.equal(h.status, 201, h.body);
  assert.equal(h.headers['x-hi'], 'yes');
  assert.deepEqual(JSON.parse(h.body), { you: 'bryant', method: 'POST', sent: 'payload' });

  const p = await viaSite('app.pages.test', '/api/py', { method: 'POST', body: 'quiet' });
  assert.deepEqual(JSON.parse(p.body), { upper: 'QUIET' });

  const c = await viaSite('app.pages.test', '/cgi/x', { method: 'PUT', body: 'data' });
  assert.equal(c.status, 202);
  assert.equal(c.body, 'PUT data');

  const o = await viaSite('app.pages.test', '/org');
  assert.equal(o.body, 'hello from org, /org');

  assert.equal((await hostGet(srv.url, 'app.pages.test', '/missing')).status, 502);
  assert.equal((await hostGet(srv.url, 'app.pages.test', '/')).body, 'home', 'static files still served');

  // API invocation returns JSON, never a rendered page on the Gitcha origin.
  const inv = api(srv.url, 'POST', '/api/v1/functions/alice/hello/invoke', { token, body: { method: 'GET', query: { name: 'api' } } });
  await drain();
  const res = await inv;
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 201);
  assert.equal(JSON.parse(Buffer.from(res.body.body, 'base64').toString()).you, 'api');
});

test('functions: a chain drawn in TopoForge feeds each step the last response', async () => {
  await api(srv.url, 'PUT', '/api/v1/functions', {
    token, body: { tarball: b64({ 'gitcha.fn.json': JSON.stringify({ name: 'double', runtime: 'node', entry: 'f.mjs' }), 'f.mjs': 'export default (r) => String(Number(r.body || 1) * 2);' }) },
  });
  await api(srv.url, 'PUT', '/api/v1/functions', {
    token, body: { tarball: b64({ 'gitcha.fn.json': JSON.stringify({ name: 'plus-one', runtime: 'node', entry: 'f.mjs' }), 'f.mjs': 'export default (r) => String(Number(r.body) + 1);' }) },
  });
  const drawing = { format: 'topoforge', version: 1, pages: [{ id: 'p', nodes: [
    { id: 'x', type: 'server', text: 'double', data: { function: 'double' } },
    { id: 'y', type: 'server', text: 'plus one', data: { function: 'plus-one' } },
    { id: 'z', type: 'server', text: 'double again', data: { function: 'double' } },
  ], links: [{ a: { id: 'x' }, b: { id: 'y' }, arrows: 'end' }, { a: { id: 'y' }, b: { id: 'z' }, arrows: 'end' }] }] };
  const d = await api(srv.url, 'PUT', '/api/v1/functions', {
    token, body: { tarball: b64({ 'gitcha.fn.json': JSON.stringify({ name: 'pipeline', entry: 'flow.topoforge.json' }), 'flow.topoforge.json': JSON.stringify(drawing) }) },
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual(d.body.chain, ['double', 'plus-one', 'double']);
  const inv = api(srv.url, 'POST', '/api/v1/functions/alice/pipeline/invoke', { token, body: { body: '5' } });
  await drain(3);
  const res = await inv;
  assert.equal(Buffer.from(res.body.body, 'base64').toString(), '22', '((5*2)+1)*2');
});

test('functions: a thrown error is a 500 with the trace in the log; no runner means 503', async () => {
  await api(srv.url, 'PUT', '/api/v1/functions', {
    token, body: { tarball: b64({ 'gitcha.fn.json': JSON.stringify({ name: 'boom', runtime: 'node', entry: 'f.mjs' }), 'f.mjs': 'export default () => { throw new Error("kaboom"); };' }) },
  });
  const inv = api(srv.url, 'POST', '/api/v1/functions/alice/boom/invoke', { token, body: {} });
  await drain();
  const res = await inv;
  assert.equal(res.body.status, 500);
  assert.match(res.body.log, /kaboom/, 'owners see the log');

  const t0 = Date.now();
  const none = await api(srv.url, 'POST', '/api/v1/functions/alice/boom/invoke', { token, body: {} });
  assert.equal(none.body.status, 503);
  assert.ok(Date.now() - t0 < 30_000);
});

test('runner scope: a team runner only receives that team\'s jobs', async () => {
  await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
  const reg = await api(srv.url, 'POST', '/api/v1/runners/registrations', { token, body: { team: 'acme' } });
  const tr = await new RunnerClient({ server: srv.url, version: 'test' }).register({ token: reg.body.token, name: 'acme-runner', backend: 'process' });
  const teamClient = new RunnerClient({ server: srv.url, token: tr.token, version: 'test' });
  const pipe = b64({ 'gitcha-ci.json': JSON.stringify({ image: 'local', steps: ['echo personal'] }) });
  const personal = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: pipe } });
  assert.equal(await teamClient.claim(300), null, 'team runner ignores a personal job');
  const teamRun = await api(srv.url, 'POST', '/api/v1/ci/runs', { token, body: { tarball: pipe, team: 'acme' } });
  const got = await teamClient.claim(1000);
  assert.equal(got.job.id, teamRun.body.id);
  await teamClient.complete(got.job.id, got.job_token, { status: 'succeeded', exit_code: 0 });
  await drain(); // the instance runner takes the personal one
  assert.equal((await waitRun(personal.body.id)).status, 'succeeded');
  // A job token is good once, for its own job.
  await assert.rejects(teamClient.complete(got.job.id, got.job_token, { status: 'succeeded' }), /already succeeded/);
});

test('publishing a package with "on": ["publish"] builds it', async () => {
  const pkg = tgz({
    'gitcha.json': JSON.stringify({ name: 'auto-built', version: '1.0.0' }),
    'gitcha-ci.json': JSON.stringify({ image: 'local', on: ['publish'], steps: ['echo built on publish'] }),
  });
  const crypto = await import('node:crypto');
  const pub = await api(srv.url, 'PUT', '/api/v1/packages', { token, body: { tarball: pkg.toString('base64'), integrity: `sha256-${crypto.createHash('sha256').update(pkg).digest('hex')}` } });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.ok(pub.body.build?.id, 'a build was queued');
  await drain();
  const done = await waitRun(pub.body.build.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.trigger, 'publish:auto-built@1.0.0');
  assert.match(done.log, /built on publish/);
});
