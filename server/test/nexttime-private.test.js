// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What Gitcha sends to NextTime, and when (NXT-1, NXT-2): nothing from a private
// project, a link that works, one completion however often a task is closed, a
// close that waits for the request to exist, and refusal texts for maintainers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, newRepo, pushAs, settle } from './social-helpers.js';

let s, calls, gate, refuse, nextId;
const as = (who) => (query, variables) => s.gql(s.tokens[who], query, variables);
const seen = (suffix) => calls.filter((c) => c.url.endsWith(suffix));

before(async () => {
  calls = [];
  nextId = 5000;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (gate && url.endsWith('/requests')) await gate;
    if (refuse && url.endsWith('/complete')) return { ok: false, status: 400, json: async () => ({ error: 'Accept at least one volunteer before completing the request' }) };
    return { ok: true, status: 200, json: async () => ({ id: ++nextId }) };
  };
  s = await startSocial({
    people: ['alice', 'bob', 'carol'],
    overrides: { nexttime: { url: 'https://cloud.example', user: 'gitcha-bot', appPassword: 'app-pass', categoryId: 7, hoursBudget: 1 } },
    appOpts: { fetchImpl },
  });
  await s.stepUp('alice');
  for (const [name, visibility] of [['secret', 'private'], ['open', 'public']]) {
    ok(await as('alice')(`mutation { createProject(name:"${name}", visibility:"${visibility}") { key } }`));
    ok(await as('alice')(`mutation { setTaskTracking(project:"alice/${name}", enabled:true) { taskTracking } }`));
  }
});
after(() => s.srv.close());

const task = async (project, title) => {
  const t = ok(await as('alice')(`mutation { createTask(project:"${project}", title:"${title}", body:"A body that says what the task is about.") { id } }`)).createTask;
  await settle();
  return t.id;
};

test('NXT-1: a private project\'s tasks are never copied to NextTime', async () => {
  const before = calls.length;
  const id = await task('alice/secret', 'Rotate the production signing key');
  await settle();
  assert.equal(calls.length, before, 'no call at all');
  assert.equal(ok(await as('alice')(`{ task(id:"${id}") { nexttime } }`)).task.nexttime, null);

  // Nor is the Second Reader task that two agents' work in the private project opens.
  ok(await as('alice')('mutation { registerAgent(handle:"ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  ok(await as('bob')('mutation { registerAgent(handle:"bea", name:"Bea", model:"claude-opus-5-5") { handle } }'));
  ok(await as('alice')('mutation { addCollaborator(project:"alice/secret", agent:"ada") { key } }'));
  ok(await as('alice')('mutation { addCollaborator(project:"alice/secret", agent:"bea") { key } }'));
  const repo = await newRepo();
  await pushAs(s.srv, repo, { token: s.tokens.alice, agent: 'ada', project: 'alice/secret', byline: 'Ada (for alice, claude-opus-5-5)' });
  await pushAs(s.srv, repo, { token: s.tokens.bob, agent: 'bea', project: 'alice/secret', byline: 'Bea (for bob, claude-opus-5-5)' });
  await settle();
  assert.ok(Object.values(s.srv.store.data.tasks).some((t) => t.kind === 'second_reader' && t.project === 'alice/secret'), 'the task exists');
  assert.equal(calls.length, before, 'and still no call');
  assert.ok(!JSON.stringify(calls).includes('secret'));
});

test('NXT-1: a public project\'s task goes with a link that works', async () => {
  const before = calls.length;
  const id = await task('alice/open', 'Write the changelog');
  const sent = seen('/requests').slice(before)[0];
  assert.ok(sent, 'one create call');
  assert.match(sent.body.title, /^\[alice\/open\] Write the changelog/);
  assert.doesNotMatch(sent.body.description, /undefined/);
  assert.ok(sent.body.description.includes(`Gitcha task ${id}: ${s.srv.url}/tasks/${id}`) || /Gitcha task t_[0-9a-f]+: https?:\/\/\S+\/tasks\/t_[0-9a-f]+/.test(sent.body.description), sent.body.description);
});

test('NXT-2: closing a task twice completes its request once, and a done task cannot be cancelled', async () => {
  const id = await task('alice/open', 'Tidy the examples');
  const rid = ok(await as('alice')(`{ task(id:"${id}") { nexttime } }`)).task.nexttime.requestId;
  const before = calls.length;
  const close = (status) => as('alice')(`mutation { closeTask(id:"${id}", status:"${status}") { status } }`);
  assert.equal(ok(await close('done')).closeTask.status, 'done');
  await settle();
  assert.equal(ok(await close('done')).closeTask.status, 'done', 'the second close answers with the task as it is');
  assert.equal(ok(await close('closed')).closeTask.status, 'done', 'a finished task stays as it finished');
  await settle();
  assert.deepEqual(calls.slice(before).map((c) => `${c.method} ${c.url.split('/api')[1]}`), [`POST /requests/${rid}/complete`]);
});

test('NXT-2: a task closed while its request is still being created is completed when the request exists', async () => {
  let release;
  gate = new Promise((r) => { release = r; });
  const before = calls.length;
  const id = ok(await as('alice')('mutation { createTask(project:"alice/open", title:"Close me quickly", body:"This one is closed at once.") { id } }')).createTask.id;
  ok(await as('alice')(`mutation { closeTask(id:"${id}", status:"done") { status } }`));
  await settle();
  assert.equal(seen('/complete').slice(before).length, 0, 'nothing to complete yet');
  gate = null;
  release();
  await settle(150);
  const rid = ok(await as('alice')(`{ task(id:"${id}") { nexttime } }`)).task.nexttime.requestId;
  assert.ok(rid, 'the request got its id');
  assert.deepEqual(calls.slice(before).filter((c) => !c.url.endsWith('/requests')).map((c) => `${c.method} ${c.url.split('/api')[1]}`), [`POST /requests/${rid}/complete`]);
});

test('NXT-2: NextTime\'s refusal text is for the project\'s maintainers', async () => {
  refuse = true;
  const id = await task('alice/open', 'Something NextTime will refuse');
  ok(await as('alice')(`mutation { closeTask(id:"${id}", status:"done") { status } }`));
  await settle();
  refuse = false;
  const q = `{ task(id:"${id}") { status nexttime } }`;
  const maintainer = ok(await as('alice')(q)).task;
  assert.match(maintainer.nexttime.completeError, /Accept at least one volunteer/);
  for (const who of ['bob', 'carol']) {
    const r = ok(await as(who)(q)).task;
    assert.equal(r.status, 'done');
    assert.doesNotMatch(JSON.stringify(r), /volunteer|completeError/, 'a stranger does not read the text');
  }
});
