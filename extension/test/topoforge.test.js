// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Gitcha to TopoForge and back: what is drawn is read back as the same thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineToDrawing, chainToDrawing, systemToDrawing, stepResults, durationText } from '../lib/topoforge.js';
import { pipelineFromDrawing, pipelineFromOrg, chainFromDrawing, FormatError } from '../lib/formats.js';

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function wellFormed(doc) {
  assert.equal(doc.format, 'topoforge');
  assert.equal(doc.version, 1);
  for (const p of doc.pages) {
    const refs = [...p.nodes, ...p.links].map((x) => x.data.tf_ref);
    for (const r of refs) assert.match(r, HANDLE);
    assert.equal(new Set(refs).size, refs.length, 'handles are unique on a page');
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const l of p.links) assert.ok(ids.has(l.a.id) && ids.has(l.b.id), `link ${l.id} joins two shapes`);
    for (const n of p.nodes) if (n.parent) assert.ok(ids.has(n.parent));
  }
}

const full = {
  image: 'node:22-alpine', timeout: '15m', artifacts: 'dist', deploy: { site: 'docs' }, on: ['publish', 'manual'],
  env: { NODE_ENV: 'production', GREETING: 'hello = world', PADDED: '  two spaces each side  ', EMPTY: '' },
  steps: [{ name: 'install', run: 'npm ci\n' }, { name: 'test', run: 'npm test\nnpm run lint\n' }, { name: 'build docs', run: 'npm run build' }],
};

test('a pipeline drawn and read back is the same pipeline, every setting included', () => {
  const doc = pipelineToDrawing(full, { name: 'docs' });
  wellFormed(doc);
  assert.deepEqual(pipelineFromDrawing(doc), full);
});

test('an org pipeline survives the trip too, and a server-side (canonical) pipeline keeps its time limit', () => {
  const org = '#+GITCHA_IMAGE: alpine:3\n#+GITCHA_TIMEOUT: 90s\n#+NAME: step-hello\n#+begin_src sh\n  echo hi\n#+end_src\n';
  const raw = pipelineFromOrg(org);
  const back = pipelineFromDrawing(pipelineToDrawing(raw));
  assert.deepEqual(back.steps, raw.steps);
  assert.equal(back.image, 'alpine:3');
  assert.equal(back.timeout, '90s');
  const canonical = { image: 'alpine:3', timeoutMs: 600_000, env: {}, steps: [{ name: 'a', run: 'true' }], artifacts: null, deploy: null, on: ['manual'] };
  const c = pipelineFromDrawing(pipelineToDrawing(canonical));
  assert.equal(c.timeout, '10m');
  assert.deepEqual(c.on, ['manual']);
  assert.equal(c.env, undefined, 'an empty env is not written');
});

test('the drawn steps run in the order of their arrows, so moving shapes around changes nothing', () => {
  const doc = pipelineToDrawing(full);
  const nodes = doc.pages[0].nodes;
  nodes.reverse(); // drawn in another order; the arrows still say install -> test -> build
  assert.deepEqual(pipelineFromDrawing(doc).steps.map((s) => s.name), ['install', 'test', 'build docs']);
});

test('a step named by its first line of text still reads, for drawings made by hand in TopoForge', () => {
  const doc = { format: 'topoforge', version: 1, pages: [{ nodes: [
    { id: 'a', text: 'compile\nmake all', data: { run: 'make all' } },
    { id: 'b', text: 'check', data: { run: 'make check', gitcha_image: 'gcc:14' } },
  ], links: [{ a: { id: 'a' }, b: { id: 'b' }, arrows: 'end' }] }] };
  const p = pipelineFromDrawing(doc);
  assert.deepEqual(p.steps, [{ name: 'compile', run: 'make all' }, { name: 'check', run: 'make check' }]);
  assert.equal(p.image, 'gcc:14');
});

test('a build\'s steps are coloured by their results, read from the runner\'s log markers', () => {
  const log = 'x\n@@GITCHA-STEP@@ install\nok\n@@GITCHA-STEP@@ test\nboom\n@@GITCHA-FAILED@@ test 1\n';
  const results = stepResults(full.steps, log, 'failed');
  assert.deepEqual(results, { install: 'passed', test: 'failed', 'build docs': 'not run' });
  const doc = pipelineToDrawing(full, { results, job: { id: 'job_1', status: 'failed' } });
  const byStep = Object.fromEntries(doc.pages[0].nodes.filter((n) => n.data.step).map((n) => [n.data.step, n]));
  assert.equal(byStep.test.data.result, 'failed');
  assert.ok(byStep.test.style.fill && byStep.install.style.fill !== byStep.test.style.fill);
  assert.deepEqual(stepResults(full.steps, '@@GITCHA-STEP@@ install\n@@GITCHA-STEP@@ test\n@@GITCHA-STEP@@ build docs\n', 'succeeded'),
    { install: 'passed', test: 'passed', 'build docs': 'passed' });
});

test('a chain drawn and read back is the same chain', () => {
  const doc = chainToDrawing('pipeline', ['fetch', 'clean-up', 'store']);
  wellFormed(doc);
  assert.deepEqual(chainFromDrawing(doc), ['fetch', 'clean-up', 'store']);
});

test('what cannot be drawn faithfully is refused, not bent', () => {
  assert.throws(() => pipelineToDrawing({ steps: [] }), FormatError);
  assert.throws(() => pipelineToDrawing({ steps: [{ name: 'a', run: 'x' }], env: { KEY: 'two\nlines' } }), /line break/);
  assert.throws(() => pipelineFromDrawing({ pages: [{ nodes: [{ id: 'a', data: { run: 'x', gitcha_env: 'lower=1' } }], links: [] }] }), /not an environment variable name/);
});

test('the instance map draws what it is given, cut to a readable size', () => {
  const snap = { name: 'gw', url: 'https://gitcha.example', version: '0.2.0', host: 'gitcha.example', at: '2026-10-31T00:00:00Z', store: 'cassandra',
    counts: { users: 3, projects: 2, packages: 1 },
    runners: Array.from({ length: 45 }, (_, i) => ({ name: `r${i}`, online: i % 2 === 0, backend: 'bcontain', labels: [], capabilities: ['ci'], scope: 'instance' })),
    sites: [{ name: 'docs', owner: 'user:alice', hostnames: ['docs.pages.example'], deploys: 2 }], ring: [] };
  const doc = systemToDrawing(snap);
  wellFormed(doc);
  const texts = doc.pages[0].nodes.map((n) => n.text);
  assert.ok(texts.includes('Apache Cassandra'));
  assert.ok(texts.includes('and 5 more'));
  assert.equal(doc.pages[0].nodes.filter((n) => n.props?.status === 'online').length, 20);
});

test('durations are written back exactly', () => {
  assert.deepEqual([3_600_000, 600_000, 90_000, 1500].map(durationText), ['1h', '10m', '90s', '1500ms']);
});

test('the Claude tool writes a drawing to a file, never over one, and labels what the registry sent', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { stub, json, signedIn, mcpRun, byId, call, INIT, HOSTILE, tmp } = await import('./harness.js');
  const pipe = { image: 'local', steps: [{ name: 'install', run: 'true' }, { name: 'test', run: 'false' }] };
  const reg = await stub((req, res, body) => {
    if (req.url === '/api/v1/topoforge/system') return json(res, 200, { ...pipelineToDrawing(pipe, { name: HOSTILE }) });
    if (req.url === '/api/v1/topoforge/import') {
      const { drawing } = JSON.parse(body);
      return json(res, 200, { pipeline: { ...pipelineFromDrawing(drawing), image: 'local', timeoutMs: 600_000, on: ['manual'], env: {}, artifacts: null, deploy: null } });
    }
    json(res, 404, { error: 'not_found' });
  });
  try {
    const env = signedIn(reg.url);
    const dir = tmp();
    const out = path.join(dir, 'instance.topoforge.json');
    const drawingFile = path.join(dir, 'pipe.json');
    fs.writeFileSync(drawingFile, JSON.stringify(pipelineToDrawing(pipe)));
    const { replies } = await mcpRun(env, [INIT,
      call(1, 'gitcha_topoforge', { action: 'system', out }),
      call(2, 'gitcha_topoforge', { action: 'system', out }),
      call(3, 'gitcha_topoforge', { action: 'check', drawing: drawingFile }),
      call(4, 'gitcha_topoforge', { action: 'build', out: path.join(dir, 'x.txt'), id: 'job_1' })], { want: 5 });
    const t = (id) => byId(replies, id).result.content[0].text;
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).format, 'topoforge', 'the drawing is on disk');
    assert.match(t(1), /Wrote .*instance\.topoforge\.json/);
    assert.match(t(1), /registry/i, 'what the registry sent is labelled as such');
    assert.match(t(2), /already exists/);
    assert.match(t(3), /2 step\(s\)[\s\S]*1\. install: true[\s\S]*2\. test: false/);
    assert.match(t(4), /ending in \.json/);
  } finally { await reg.close(); }
});
