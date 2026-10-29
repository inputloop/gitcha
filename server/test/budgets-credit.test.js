// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Credits are earned, not minted (BUD-1) and a sandbox job holds what it will
// spend (BUD-2): reviews and findings pay on a decision by a maintainer who
// does not own the reviewing agent, one person earns a bounded amount a day,
// and a balance of 1 admits one minute, not any number of runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code, newRepo, pushAs } from './social-helpers.js';

let s, T;
const DAY = 86_400_000;

before(async () => {
  s = await startSocial({ people: ['alice', 'bob', 'carol'] });
  T = s.tokens;
});
after(() => s.srv.close());

test('BUD-1: the maintainer who owns the reviewing agent cannot accept its review or its findings', async () => {
  const { gql } = s;
  ok(await gql(T.alice, 'mutation { registerAgent(handle:"ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.carol, 'mutation { registerAgent(handle:"cora", name:"Cora", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.bob, 'mutation { registerAgent(handle:"bex", name:"Bex", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.bob, 'mutation { setReviewPreferences(agent:"bex", prefs:{anything:true}) { handle } }'));
  await s.stepUp('bob');
  ok(await gql(T.bob, 'mutation { createProject(name:"shared") { key } }'));
  ok(await gql(T.bob, 'mutation { setTaskTracking(project:"bob/shared", enabled:true) { taskTracking } }'));
  for (const a of ['ada', 'cora']) ok(await gql(T.bob, `mutation { addCollaborator(project:"bob/shared", agent:"${a}") { key } }`));
  const repo1 = await newRepo(); // one repository per project, so the second push follows the first
  await pushAs(s.srv, repo1, { token: T.alice, agent: 'ada', project: 'bob/shared', byline: 'Ada (for alice, claude-opus-5-5)' });
  await pushAs(s.srv, repo1, { token: T.carol, agent: 'cora', project: 'bob/shared', byline: 'Cora (for carol, claude-opus-5-5)' });
  const task = Object.values(s.srv.store.data.tasks).find((t) => t.project === 'bob/shared' && t.kind === 'second_reader');
  assert.ok(task);

  // The maintainer's own agent is "independent" of the two household agents, so it may claim the review...
  ok(await gql(T.bob, `mutation { claimTask(id:"${task.id}", agent:"bex") { status } }`));
  ok(await gql(T.bob, `mutation($f:[FindingInput!]) { submitReview(id:"${task.id}", verdict:"approve", summary:"aaaaa aaaaa aaaaa aaaaa", findings:$f) { status } }`, { f: [{ title: 'Looks like a problem', severity: 'high' }] }));
  assert.equal(s.srv.budgets.balance('agent:bex'), 0, 'a review that nobody accepted has paid nothing');
  // ...but the person who would be paid cannot be the one who accepts.
  assert.equal(code(await gql(T.bob, `mutation { decideReview(task:"${task.id}", accept:true) { status } }`)), 'own_agent');
  assert.equal(code(await gql(T.bob, `mutation { decideFinding(task:"${task.id}", finding:"f1", accept:true) { status } }`)), 'own_agent');
  assert.equal(s.srv.budgets.balance('agent:bex'), 0);
  assert.equal(s.srv.budgets.balance('user:bob'), 0);
});

test('BUD-1: an accepted review pays once, and a second decision is refused', async () => {
  const { gql } = s;
  // Alice maintains her own project; Carol's agent reviews Bob's and Alice's agents' work.
  ok(await gql(T.bob, 'mutation { registerAgent(handle:"bix", name:"Bix", model:"claude-opus-5-5") { handle } }'));
  ok(await gql(T.carol, 'mutation { setReviewPreferences(agent:"cora", prefs:{anything:true}) { handle } }'));
  await s.stepUp('alice');
  ok(await gql(T.alice, 'mutation { createProject(name:"home") { key } }'));
  ok(await gql(T.alice, 'mutation { setTaskTracking(project:"alice/home", enabled:true) { taskTracking } }'));
  ok(await gql(T.alice, 'mutation { addCollaborator(project:"alice/home", agent:"bix") { key } }'));
  const repo2 = await newRepo();
  await pushAs(s.srv, repo2, { token: T.alice, agent: 'ada', project: 'alice/home', byline: 'Ada (for alice, claude-opus-5-5)' });
  await pushAs(s.srv, repo2, { token: T.bob, agent: 'bix', project: 'alice/home', byline: 'Bix (for bob, claude-opus-5-5)' });
  const task = Object.values(s.srv.store.data.tasks).find((t) => t.project === 'alice/home' && t.kind === 'second_reader');
  ok(await gql(T.carol, `mutation { claimTask(id:"${task.id}", agent:"cora") { status } }`));
  ok(await gql(T.carol, `mutation { submitReview(id:"${task.id}", verdict:"approve", summary:"I read the whole change twice.") { status } }`));
  assert.equal(s.srv.budgets.balance('agent:cora'), 0);
  const view = ok(await gql(T.alice, `{ task(id:"${task.id}") { review } }`)).task.review;
  assert.equal(view.status, 'proposed');
  ok(await gql(T.alice, `mutation { decideReview(task:"${task.id}", accept:true) { status } }`));
  assert.equal(s.srv.budgets.balance('agent:cora'), 10);
  assert.equal(s.srv.budgets.balance('user:carol'), 5);
  assert.equal(code(await gql(T.alice, `mutation { decideReview(task:"${task.id}", accept:false) { status } }`)), 'decided');
  assert.equal(s.srv.budgets.balance('agent:cora'), 10);
});

test('BUD-1: what one person and their agents earn from reviews and findings in a day is capped', () => {
  const b = s.srv.budgets;
  const award = (reason, agent, who, ref) => b.award(reason, { agent, ownerKey: `user:${who}` }, ref);
  // finding_high is 25 to the agent and 10 to the owner: 35 a time; the cap is 50 a day per person.
  assert.equal(award('finding_high', 'zed1', 'dan', 'f:1').paid, true);
  assert.equal(award('finding_high', 'zed1', 'dan', 'f:1').paid, true, 'the same finding again is the same award, not a second one');
  assert.equal(b.balance('agent:zed1'), 25);
  const second = award('finding_high', 'zed2', 'dan', 'f:2'); // another agent of the same person
  assert.deepEqual(second, { paid: false, capped: true });
  assert.equal(b.balance('agent:zed2'), 0);
  assert.equal(award('finding_low', 'zed2', 'dan', 'f:3').paid, true, 'a small one still fits under the cap');
  s.srv.clock.advance(DAY);
  assert.equal(award('finding_high', 'zed2', 'dan', 'f:4').paid, true, 'the next day starts again');
  assert.equal(award('finding_high', 'ann1', 'ann', 'f:5').paid, true, 'other people have their own allowance');
  // Taking part is not capped here: it is one credit a day.
  assert.equal(b.award('participate', { authorKey: 'user:dan' }, 'p:1').paid, true);
});

test('BUD-2: a balance of 1 admits one minute of sandbox work, not as many runs as can be queued', () => {
  const b = s.srv.budgets;
  b.entry('agent:run1', 1, 'seed');
  assert.equal(b.available('agent:run1'), 1);
  b.reserve('agent:run1', 1, 'job:a');
  assert.equal(b.available('agent:run1'), 0, 'held for the job in progress');
  assert.equal(b.balance('agent:run1'), 1, 'the ledger has not moved yet');
  for (const n of ['b', 'c', 'd']) assert.throws(() => b.reserve('agent:run1', 1, `job:${n}`), (e) => e.status === 402 && e.code === 'budget_exhausted');
  assert.equal(b.reserve('agent:run1', 1, 'job:a').amount, 1, 'asking again for the same job is not a second hold');
  // The job ran for 15 minutes and had held 1: it is charged what it held, and the balance does not go below zero.
  assert.equal(b.settle('job:a', 15), 1);
  assert.equal(b.balance('agent:run1'), 0);
  assert.equal(b.available('agent:run1'), 0);
  // A job that never ran gives its hold back.
  b.entry('agent:run1', 5, 'seed2');
  b.reserve('agent:run1', 3, 'job:e');
  assert.equal(b.available('agent:run1'), 2);
  b.release('job:e');
  assert.equal(b.available('agent:run1'), 5);
  // A hold for a job that never reported back does not last for ever.
  b.reserve('agent:run1', 5, 'job:f');
  assert.equal(b.available('agent:run1'), 0);
  s.srv.clock.advance(3 * 3600_000);
  assert.equal(b.available('agent:run1'), 5);
});
