// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A private project leaves no trace a stranger can read (PRIV-1, PRIV-2, PRIV-3),
// budgets are the owner's alone (GQL-2), and a site administrator who reads a
// private project tells its owner (ADM-1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code, newRepo, pushAs } from './social-helpers.js';

let s, T, repo, secretTask, openTask;
const as = (who) => (query, variables) => s.gql(T[who], query, variables);

before(async () => {
  // admin1 registers first and so is the administrator; alice owns the projects.
  s = await startSocial({ people: ['admin1', 'alice', 'bob', 'carol'] });
  T = s.tokens;
  const { gql } = s;
  ok(await gql(T.alice, 'mutation { updateProfile(displayName: "Alice") { displayName } }'));
  ok(await gql(T.alice, 'mutation { registerAgent(handle:"ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.bob, 'mutation { registerAgent(handle:"bea", name:"Bea", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.carol, 'mutation { registerAgent(handle:"cora", name:"Cora", model:"claude-haiku-5-5") { handle } }'));
  ok(await gql(T.admin1, 'mutation { registerAgent(handle:"zed", name:"Zed", model:"claude-haiku-5-5") { handle } }'));
  for (const [who, agent] of [['carol', 'cora'], ['admin1', 'zed']]) ok(await gql(T[who], `mutation { setReviewPreferences(agent:"${agent}", prefs:{anything:true}) { handle } }`));
  // Ada's owner keeps a private project, a person and a tag in her review preferences.
  ok(await gql(T.alice, 'mutation { setReviewPreferences(agent:"ada", prefs:{enabled:true, projects:["alice/secret"], people:["bob"], tags:["internal-audit"]}) { handle } }'));

  await s.stepUp('alice');
  for (const [name, visibility] of [['secret', 'private'], ['open', 'public']]) {
    ok(await gql(T.alice, `mutation { createProject(name:"${name}", visibility:"${visibility}") { key } }`));
    ok(await gql(T.alice, `mutation { setTaskTracking(project:"alice/${name}", enabled:true) { taskTracking } }`));
    ok(await gql(T.alice, `mutation { addCollaborator(project:"alice/${name}", agent:"bea") { key } }`));
  }
  ok(await gql(T.alice, 'mutation { addCollaborator(project:"alice/secret", username:"carol") { key } }'));
  for (const project of ['alice/open', 'alice/secret']) {
    repo = await newRepo(); // a repository of its own, so each push carries only its own commit
    await pushAs(s.srv, repo, { token: T.alice, agent: 'ada', project, byline: 'Ada (for Alice, claude-opus-5-5)' });
    await pushAs(s.srv, repo, { token: T.bob, agent: 'bea', project, byline: 'Bea (for bob, claude-opus-5-5)' });
  }
  const tasks = (key) => Object.values(s.srv.store.data.tasks).filter((t) => t.project === key && t.kind === 'second_reader');
  secretTask = tasks('alice/secret')[0];
  openTask = tasks('alice/open')[0];
  assert.ok(secretTask && openTask, 'both projects opened a Second Reader task');
});
after(() => s.srv.close());

test('PRIV-1: the review pool never lists a private project\'s task to someone outside it', async () => {
  // Zed belongs to the administrator, who is not part of either project.
  const stranger = ok(await as('admin1')('{ reviewPool(agent:"zed") { id project } }')).reviewPool;
  assert.deepEqual(stranger.map((t) => t.id), [openTask.id], 'a stranger\'s agent sees the public task only');
  // Carol is a collaborator on the private project, so she sees both.
  const member = ok(await as('carol')('{ reviewPool(agent:"cora") { id project } }')).reviewPool;
  assert.deepEqual(member.map((t) => t.id).sort(), [openTask.id, secretTask.id].sort());
});

test('PRIV-2: counters shown to a stranger leave out private work; the owner sees the totals', async () => {
  // Carol reviews the private task and the maintainer accepts a finding.
  ok(await as('carol')(`mutation { claimTask(id:"${secretTask.id}", agent:"cora") { id } }`));
  ok(await as('carol')(`mutation($f:[FindingInput!]) { submitReview(id:"${secretTask.id}", verdict:"request_changes", summary:"Read both commits in the private project.", findings:$f) { status } }`, { f: [{ title: 'A private finding', severity: 'high' }] }));
  await s.stepUp('alice');
  ok(await as('alice')(`mutation { decideFinding(task:"${secretTask.id}", finding:"f1", accept:true) { status } }`));

  const anon = (await s.gql(null, '{ cora: agent(handle:"cora") { stats { reviews findingsAccepted commits } } ada: agent(handle:"ada") { stats { reviews findingsAccepted commits } } }')).data;
  assert.deepEqual(anon.cora.stats, { reviews: 0, findingsAccepted: 0, commits: 0 }, 'one review, one finding: both in a private project');
  assert.deepEqual(anon.ada.stats, { reviews: 0, findingsAccepted: 0, commits: 1 }, 'two commits, one of them in the private project');
  const owner = (await s.gql(T.carol, '{ agent(handle:"cora") { stats { reviews findingsAccepted commits } } }')).data.agent.stats;
  assert.deepEqual(owner, { reviews: 1, findingsAccepted: 1, commits: 0 }, 'the owner sees the totals');
  const adaOwner = (await s.gql(T.alice, '{ agent(handle:"ada") { stats { commits } } }')).data.agent.stats;
  assert.equal(adaOwner.commits, 2);
});

test('PRIV-2: the ledger that names a private task is not public', async () => {
  const anon = await s.gql(null, '{ agent(handle:"cora") { handle budget { ledger } } }');
  assert.equal(anon.data.agent.budget, null);
  assert.ok(!JSON.stringify(anon).includes(secretTask.id), 'the private task id is nowhere in what a stranger can fetch');
  const other = await s.gql(T.bob, '{ agent(handle:"cora") { budget { ledger } } }');
  assert.equal(code(other), 'not_yours');
  assert.ok(!JSON.stringify(other).includes(secretTask.id));
});

test('PRIV-3: review preferences show a stranger the flags and nothing a person typed', async () => {
  const q = '{ agent(handle:"ada") { reviewPrefs { enabled anything projects people teams tags } } }';
  const anon = (await s.gql(null, q)).data.agent.reviewPrefs;
  assert.deepEqual(anon, { enabled: true, anything: false, projects: [], people: [], teams: [], tags: [] });
  assert.ok(!JSON.stringify(anon).includes('secret'));
  const owner = (await s.gql(T.alice, q)).data.agent.reviewPrefs;
  assert.deepEqual(owner.projects, ['alice/secret']);
  assert.deepEqual(owner.people, ['bob']);
});

test('GQL-2: a budget is read by its owner, through any path', async () => {
  const q = (u) => `{ user(username:"${u}") { username budget { balance ledger } } }`;
  const anon = await s.gql(null, q('alice'));
  assert.equal(code(anon), 'unauthenticated');
  assert.equal(anon.data.user.budget, null, 'the refusal costs the field, not the person');
  assert.equal(code(await s.gql(T.bob, q('alice'))), 'not_yours');
  assert.equal(code(await s.gql(T.bob, '{ agent(handle:"ada") { budget { balance } } }')), 'not_yours');
  assert.equal(code(await s.gql(T.alice, q('alice'))), undefined);
  assert.equal(code(await s.gql(T.alice, '{ agent(handle:"ada") { budget { balance } } me { budget { balance } agents { budget { balance } } } }')), undefined);
  assert.equal(code(await s.gql(T.alice, '{ user(username:"alice") { agents { budget { balance } } } }')), undefined);
  assert.equal(code(await s.gql(T.alice, '{ user(username:"bob") { budget { balance } } }')), 'not_yours');
});

test('ADM-1: an administrator who opens a private project tells its owner, once an hour', async () => {
  const alice = s.srv.store.userByName('alice');
  const rows = () => s.srv.store.auditFor(alice.id, 500).filter((e) => e.event === 'project.admin_read');
  const start = rows().length;
  const open = () => as('admin1')('{ project(owner:"alice", name:"secret") { key } }');
  assert.equal(ok(await open()).project.key, 'alice/secret');
  assert.equal(rows().length, start + 1);
  assert.equal(rows()[0].by, 'admin1');
  assert.equal(rows()[0].project, 'alice/secret');
  assert.match(rows()[0].name, /alice\/secret read by administrator admin1/, 'the account page prints the name column');
  ok(await open());
  assert.equal(rows().length, start + 1, 'not again within the hour');
  s.srv.clock.advance(61 * 60_000);
  ok(await open());
  assert.equal(rows().length, start + 2);
  // A task page is a read of the project too.
  s.srv.clock.advance(61 * 60_000);
  ok(await as('admin1')(`{ task(id:"${secretTask.id}") { title } }`));
  assert.equal(rows().length, start + 3);
  // Belonging to the project is not an administrator's read.
  s.srv.clock.advance(61 * 60_000);
  ok(await as('bob')('{ project(owner:"alice", name:"secret") { key } }'));
  ok(await as('alice')('{ project(owner:"alice", name:"secret") { key } }'));
  assert.equal(rows().length, start + 3);
  // A list does not show an administrator what they are not part of.
  assert.deepEqual(ok(await as('admin1')('{ projects { key } }')).projects.map((p) => p.key), ['alice/open']);
  assert.deepEqual(ok(await as('alice')('{ projects { key } }')).projects.map((p) => p.key).sort(), ['alice/open', 'alice/secret']);
  assert.equal(rows().length, start + 3);
});
