import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, deviceLogin } from './helpers.js';

async function setup() {
  const srv = await startServer();
  try { return await populate(srv); } catch (err) { await srv.close(); throw err; }
}

async function populate(srv) {
  const admin = createUser(srv, 'admin1', 'admin long pass!');
  const sam = createUser(srv, 'sam', 'staff long pass!');
  const sue = createUser(srv, 'sue', 'staff two pass!!');
  const cus = createUser(srv, 'cus', 'paying client pw');
  const out = createUser(srv, 'out', 'a stranger here');
  const tok = {};
  for (const [n, u] of Object.entries({ admin, sam, sue, cus, out })) tok[n] = await deviceLogin(srv, u);
  const gql = async (who, query, variables) => {
    const res = await fetch(`${srv.url}/api/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: JSON.stringify({ query, variables }) });
    return res.json();
  };
  return { srv, users: { admin, sam, sue, cus, out }, tok, gql };
}
const ok = (r) => { assert.equal(r.errors, undefined, JSON.stringify(r.errors)); return r.data; };
const code = (r) => r.errors?.[0]?.extensions?.code;

test('roles: only admins make staff', async () => {
  const { srv, gql } = await setup();
  try {
    assert.equal(code(await gql('sam', 'mutation { setRole(username:"sam", role:"staff") }')), 'admin_only');
    assert.deepEqual(ok(await gql('admin', 'mutation { setRole(username:"sam", role:"staff") }')).setRole, { username: 'sam', role: 'staff' });
    assert.equal(code(await gql('admin', 'mutation { setRole(username:"admin1", role:"user") }')), 'last_admin');
  } finally { await srv.close(); }
});

test('tickets: user, tenant and internal scopes; internal notes stay internal', async () => {
  const { srv, gql } = await setup();
  try {
    ok(await gql('admin', 'mutation { setRole(username:"sam", role:"staff") }'));
    ok(await gql('cus', 'mutation { fileTicket(title:"The site is slow", body:"Pages take ten seconds.", kind:"bug") { id } }'));
    const tenant = ok(await gql('cus', 'mutation { fileTicket(scope:"tenant", tenant:"user:cus", title:"Invoice question", priority:"high") { id scope tenant } }')).fileTicket;
    assert.equal(tenant.tenant, 'user:cus');
    assert.equal(code(await gql('out', 'mutation { fileTicket(scope:"tenant", tenant:"user:cus", title:"Pretend to be them") { id } }')), 'not_in_tenant');
    assert.equal(code(await gql('cus', 'mutation { fileTicket(scope:"internal", title:"I am not staff") { id } }')), 'staff_only');
    const internal = ok(await gql('sam', 'mutation { fileTicket(scope:"internal", kind:"incident", title:"Disk filling on gw34", priority:"urgent", via:"c4ok:corwin") { id events } }')).fileTicket;
    assert.equal(internal.events[0].via, 'c4ok:corwin');

    assert.equal(ok(await gql('cus', '{ tickets { id } }')).tickets.length, 2, 'the customer sees their own two');
    assert.equal(ok(await gql('out', '{ tickets { id } }')).tickets.length, 0);
    assert.equal(ok(await gql('sam', '{ tickets { id } }')).tickets.length, 3, 'staff see everything');
    assert.equal(ok(await gql('sam', '{ tickets { id } }')).tickets[0].id, internal.id, 'urgent first');
    assert.equal(code(await gql('cus', `{ ticket(id:"${internal.id}") { id } }`)), 'ticket_not_found');

    ok(await gql('sam', `mutation { commentTicket(id:"${tenant.id}", body:"Customer is on the legacy plan.", internal:true) { id } }`));
    ok(await gql('sam', `mutation { commentTicket(id:"${tenant.id}", body:"Thanks, looking now.") { id } }`));
    ok(await gql('sam', `mutation { updateTicket(id:"${tenant.id}", status:"waiting", assignee:"sam") { status } }`));
    assert.equal(code(await gql('cus', `mutation { updateTicket(id:"${tenant.id}", status:"closed") { status } }`)), 'staff_only');
    const seen = ok(await gql('cus', `{ ticket(id:"${tenant.id}") { comments status } }`)).ticket;
    assert.deepEqual(seen.comments.map((c) => c.body), ['Thanks, looking now.'], 'internal note hidden from the customer');
    const reply = ok(await gql('cus', `mutation { commentTicket(id:"${tenant.id}", body:"Here is the invoice number.") { status } }`)).commentTicket;
    assert.equal(reply.status, 'in_progress', 'a customer reply takes it off "waiting"');
    assert.equal(code(await gql('sam', `mutation { updateTicket(id:"${tenant.id}", assignee:"cus") { id } }`)), 'bad_assignee');
  } finally { await srv.close(); }
});

test('changes: plan and rollback required; approvals need a fresh code, a second person, and two for high risk', async () => {
  const { srv, gql, users } = await setup();
  try {
    ok(await gql('admin', 'mutation { setRole(username:"sam", role:"staff") }'));
    ok(await gql('admin', 'mutation { setRole(username:"sue", role:"staff") }'));
    assert.equal(code(await gql('cus', 'mutation { createChange(title:"Let me in") { id } }')), 'staff_only');
    const c = ok(await gql('sam', 'mutation { createChange(title:"Upgrade node on gw34", risk:"high", systems:["gw34"]) { id status requiredApprovals } }')).createChange;
    assert.equal(c.requiredApprovals, 2);
    assert.equal(code(await gql('sam', `mutation { advanceChange(id:"${c.id}", to:"submitted") { status } }`)), 'incomplete');
    ok(await gql('sam', `mutation { editChange(id:"${c.id}", plan:"apt upgrade nodejs; restart gitcha", rollback:"apt install nodejs=22.11; restart") { id } }`));
    ok(await gql('sam', `mutation { advanceChange(id:"${c.id}", to:"submitted") { status } }`));
    assert.equal(code(await gql('sam', `mutation { advanceChange(id:"${c.id}", to:"approved") { status } }`)), 'own_change');
    assert.equal(code(await gql('sue', `mutation { advanceChange(id:"${c.id}", to:"in_progress") { status } }`)), 'bad_transition');

    srv.clock.advance(11 * 60_000);
    assert.equal(code(await gql('sue', `mutation { advanceChange(id:"${c.id}", to:"approved") { status } }`)), 'mfa_required');
    const one = ok(await gql('sue', `mutation($c:String) { advanceChange(id:"${c.id}", to:"approved", code:$c, note:"Read the plan.") { status approvals } }`, { c: users.sue.nextCode() })).advanceChange;
    assert.equal(one.status, 'submitted', 'high risk: one approval is not enough');
    assert.equal(code(await gql('sue', `mutation { advanceChange(id:"${c.id}", to:"approved") { status } }`)), 'already_approved');
    const two = ok(await gql('admin', `mutation($c:String) { advanceChange(id:"${c.id}", to:"approved", code:$c) { status approvals } }`, { c: users.admin.nextCode() })).advanceChange;
    assert.equal(two.status, 'approved');
    assert.equal(two.approvals.length, 2);
    for (const to of ['scheduled', 'in_progress', 'failed', 'rolled_back']) ok(await gql('sam', `mutation { advanceChange(id:"${c.id}", to:"${to}") { status } }`));
    const done = ok(await gql('sue', `{ change(id:"${c.id}") { status events } }`)).change;
    assert.equal(done.status, 'rolled_back');
    assert.deepEqual(done.events.map((e) => e.type), ['created', 'submitted', 'approved', 'approved', 'scheduled', 'in_progress', 'failed', 'rolled_back']);
  } finally { await srv.close(); }
});

test('the kiosk summary is staff-only and counts what matters', async () => {
  const { srv, gql } = await setup();
  try {
    ok(await gql('admin', 'mutation { setRole(username:"sam", role:"staff") }'));
    ok(await gql('cus', 'mutation { fileTicket(title:"Everything is down", priority:"urgent", kind:"incident") { id } }'));
    assert.equal(code(await gql('cus', '{ opsSummary }')), 'staff_only');
    const s = ok(await gql('sam', '{ opsSummary }')).opsSummary;
    assert.equal(s.tickets.open, 1);
    assert.equal(s.tickets.urgent[0].title, 'Everything is down');
    assert.equal(s.users, 5);
    assert.deepEqual(Object.keys(s).sort(), ['agents', 'at', 'billing', 'changes', 'hosting', 'jobs', 'ring', 'runners', 'tickets', 'users']);
  } finally { await srv.close(); }
});
