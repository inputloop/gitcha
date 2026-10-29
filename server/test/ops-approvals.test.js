// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Change approvals mean what they say (OPS-1, OPS-2) and one account cannot
// flood the store with tickets (OPS-3).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code } from './social-helpers.js';

let s;
const DAY = 86_400_000;
const as = (who) => (query, variables) => s.gql(s.tokens[who], query, variables);

before(async () => {
  s = await startSocial({ people: ['admin1', 'sam', 'sue', 'cus'] });
  for (const n of ['sam', 'sue']) ok(await as('admin1')(`mutation { setRole(username:"${n}", role:"staff") }`));
});
after(() => s.srv.close());

/** A submitted change by `author`. */
async function submitted(author, { risk = 'high', plan = 'PLAN-A: upgrade node' } = {}) {
  const q = as(author);
  const c = ok(await q(`mutation { createChange(title:"Upgrade node on gw34", risk:"${risk}", systems:["gw34"]) { id } }`)).createChange;
  ok(await q(`mutation($p:String) { editChange(id:"${c.id}", plan:$p, rollback:"apt install nodejs=22.11") { id } }`, { p: plan }));
  ok(await q(`mutation { advanceChange(id:"${c.id}", to:"submitted") { status } }`));
  return c.id;
}
/** Approve (or reject) with a code of its own. */
const decide = (who, id, to = 'approved') => as(who)(`mutation($c:String) { advanceChange(id:"${id}", to:"${to}", code:$c) { status approvals events } }`, { c: s.users[who].nextCode() });

test('OPS-1: an approval is set aside when the change is sent back and rewritten', async () => {
  const id = await submitted('sam');
  const one = ok(await decide('sue', id)).advanceChange;
  assert.equal(one.status, 'submitted', 'high risk: one of two');
  assert.equal(one.approvals.length, 1);

  const back = ok(await as('admin1')(`mutation { advanceChange(id:"${id}", to:"draft") { status approvals events } }`)).advanceChange;
  assert.equal(back.status, 'draft');
  assert.deepEqual(back.approvals, [], 'nothing approved survives a trip back to draft');
  assert.deepEqual(s.srv.store.data.ops.changes[id].voidedApprovals.map((a) => a.by), ['sue'], 'the record keeps who approved what, as voided');
  assert.equal(back.events.at(-2).type, 'approvals_voided');

  ok(await as('sam')(`mutation { editChange(id:"${id}", plan:"PLAN-B: something else entirely") { id } }`));
  ok(await as('sam')(`mutation { advanceChange(id:"${id}", to:"submitted") { status } }`));
  const two = ok(await decide('admin1', id)).advanceChange;
  assert.equal(two.status, 'submitted', 'one approval of PLAN-B is still one of two');
  assert.deepEqual(two.approvals.map((a) => a.by), ['admin1']);
  // The first approver may approve again, now of the new text.
  const done = ok(await decide('sue', id)).advanceChange;
  assert.equal(done.status, 'approved');
  assert.deepEqual(done.approvals.map((a) => a.by), ['admin1', 'sue']);
  assert.equal(new Set(done.approvals.map((a) => a.hash)).size, 1, 'both cover the same text');
});

test('OPS-1: lowering the risk in a rewrite does not carry the old approvals along', async () => {
  const id = await submitted('sam');
  ok(await decide('sue', id));
  ok(await as('admin1')(`mutation { advanceChange(id:"${id}", to:"draft") { status } }`));
  ok(await as('sam')(`mutation { editChange(id:"${id}", plan:"PLAN-B", risk:"low") { requiredApprovals } }`));
  ok(await as('sam')(`mutation { advanceChange(id:"${id}", to:"submitted") { status } }`));
  const r = ok(await decide('admin1', id)).advanceChange;
  assert.equal(r.status, 'approved', 'low risk needs one approver');
  assert.deepEqual(r.approvals.map((a) => a.by), ['admin1'], 'and the record names the one who read PLAN-B');
  assert.equal(r.approvals[0].risk, 'low');
});

test('OPS-1: only approvals that match the text count, whichever way the text changed', async () => {
  const id = await submitted('sam');
  ok(await decide('sue', id));
  s.srv.store.data.ops.changes[id].plan = 'PLAN-Z: a hand edit that did not go through draft';
  const r = ok(await decide('admin1', id)).advanceChange;
  assert.equal(r.status, 'submitted', 'sue approved another text, so this is the first approval of two');
  assert.deepEqual(r.approvals.map((a) => a.by), ['admin1']);
  assert.ok(r.events.some((e) => e.type === 'approvals_voided' && e.reason === 'changed'));
});

test('OPS-2: each approval and rejection carries a code of its own', async () => {
  const ids = [await submitted('sam', { risk: 'low' }), await submitted('sam', { risk: 'low' }), await submitted('sam', { risk: 'low' })];
  const bare = (who, id, to) => as(who)(`mutation { advanceChange(id:"${id}", to:"${to}") { status } }`);
  // A code typed on its own opens a window for other work, not for decisions.
  ok(await as('sue')(`mutation($c:String!) { stepUp(code:$c) }`, { c: s.users.sue.nextCode() }));
  assert.equal(code(await bare('sue', ids[0], 'approved')), 'mfa_required');
  assert.equal(code(await bare('sue', ids[0], 'rejected')), 'mfa_required');
  // A code that comes with the decision is used up by it.
  assert.equal(ok(await decide('sue', ids[0])).advanceChange.status, 'approved');
  assert.equal(code(await bare('sue', ids[1], 'approved')), 'mfa_required', 'the next change needs the next code');
  assert.equal(ok(await decide('sue', ids[1], 'rejected')).advanceChange.status, 'rejected');
  assert.equal(code(await bare('sue', ids[2], 'rejected')), 'mfa_required');
  // A wrong code decides nothing.
  const wrong = await as('sue')(`mutation { advanceChange(id:"${ids[2]}", to:"approved", code:"000000") { status } }`);
  assert.equal(code(wrong), 'bad_code');
  assert.equal(ok(await as('sam')(`{ change(id:"${ids[2]}") { status } }`)).change.status, 'submitted');
});

test('OPS-3: one account files a bounded number of tickets a day; staff and others are not held back', async () => {
  const file = (who, n) => as(who)(`mutation { fileTicket(title:"Ticket number ${n} from ${who}", body:"x") { id } }`);
  for (let i = 0; i < 10; i++) ok(await file('cus', i));
  const over = await file('cus', 10);
  assert.equal(code(over), 'ticket_limit', JSON.stringify(over.errors));
  assert.equal(Object.values(s.srv.store.data.ops.tickets).filter((t) => t.reporter === 'user:cus').length, 10, 'the eleventh was not stored');
  ok(await file('sue', 0));
  for (let i = 0; i < 12; i++) ok(await file('sam', i));
  s.srv.clock.advance(DAY + 1000);
  await s.stepUp('cus');
  ok(await file('cus', 11));
});
