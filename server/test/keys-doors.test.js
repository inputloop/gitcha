// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Agent keys and console keys (KEY-1, KEY-2, K4): an agent key opens only the
// sandbox door; a key minted from a session never renews that session's code;
// agent keys can be listed, expire and are revoked one at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code, newRepo, git } from './social-helpers.js';

let s, agentKey;
const DAY = 86_400_000;

before(async () => {
  s = await startSocial({ people: ['alice', 'bob'], env: { GITCHA_HOSTING_DOMAINS: 'pages.test' } });
  ok(await s.gql(s.tokens.alice, 'mutation { registerAgent(handle:"ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  s.srv.budgets.entry('agent:ada', 5, 'seed');
  ok(await s.gql(s.tokens.alice, 'mutation { createProject(name:"demo") { key } }'));
  ok(await s.gql(s.tokens.alice, 'mutation { addCollaborator(project:"alice/demo", agent:"ada") { key } }'));
  await s.stepUp('alice');
  agentKey = ok(await s.gql(s.tokens.alice, 'mutation { createAgentKey(agent:"ada", purpose:"sandbox") { token } }')).createAgentKey.token;
});
after(() => s.srv.close());

test('KEY-1: an agent key opens the sandbox door and no other', async () => {
  const p = s.srv.principals;
  assert.equal(p.fromToken(agentKey, '127.0.0.1', { purpose: 'sandbox' })?.agent.handle, 'ada', 'the sandbox door accepts it');
  assert.equal(p.fromToken(agentKey, '127.0.0.1'), null, 'a door that names no purpose does not');
  assert.equal(p.fromToken(agentKey, '127.0.0.1', { purpose: 'commits' }), null, 'nor a purpose it was not issued for');

  // GraphQL
  const me = await s.gql(agentKey, '{ me { username } }');
  assert.equal(me.status, 401);
  assert.equal(me.error, 'unauthenticated');
  const post = await s.gql(agentKey, 'mutation { createPost(title:"as the agent", body:"x") { id } }');
  assert.equal(post.status, 401);
  // Media
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);
  const up = await fetch(`${s.srv.url}/api/v1/media`, { method: 'POST', headers: { Authorization: `Bearer ${agentKey}` }, body: png });
  assert.equal(up.status, 401);
  // Git over HTTPS: the key is not a password
  const dir = await newRepo();
  const port = new URL(s.srv.url).port;
  await git(dir, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'work\n\nAda (for alice, claude-opus-5-5)']);
  await assert.rejects(git(dir, ['push', '-q', `http://ada:${agentKey}@127.0.0.1:${port}/git/alice/demo.git`, 'HEAD:refs/heads/main']), /Authentication failed|401|could not read/);
  assert.deepEqual(s.srv.store.data.projects['alice/demo'].pushes, []);
});

test('KEY-1: a person key still works, and the agent key stays revocable', async () => {
  assert.equal(ok(await s.gql(s.tokens.alice, '{ me { username } }')).me.username, 'alice');
});

test('KEY-2: a key minted in the code window carries the window it was minted in, and no more', async () => {
  await s.stepUp('alice');
  const mint = async (token, name) => s.gql(token, `mutation { createConsoleKey(name:"${name}") { token } }`);
  const k1 = ok(await mint(s.tokens.alice, 'one')).createConsoleKey.token;
  s.srv.clock.advance(8 * 60_000);
  const k2 = ok(await mint(k1, 'two')).createConsoleKey.token; // still inside the first code's ten minutes
  s.srv.clock.advance(8 * 60_000);
  const third = await mint(k2, 'three'); // 16 minutes after the only code
  assert.equal(code(third), 'mfa_required', JSON.stringify(third.errors));
  // The same holds for the work the window guards, and for the long interval.
  assert.equal(code(await s.gql(k2, 'mutation { addCollaborator(project:"alice/demo", username:"bob") { key } }')), 'mfa_required');
  s.srv.clock.advance(13 * 3600_000);
  assert.equal(code(await s.gql(k2, '{ me { username } }')), 'mfa_required');
  // A real code on the key gives it a window of its own.
  const res = await fetch(`${s.srv.url}/api/v1/auth/step-up`, { method: 'POST', headers: { Authorization: `Bearer ${k2}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: s.users.alice.nextCode() }) });
  assert.equal(res.status, 200);
  ok(await mint(k2, 'four'));
});

test('KEY-2: the service stamps the parent time, and fails closed without one', () => {
  const alice = s.srv.store.userByName('alice');
  s.srv.keys.createConsoleKey(alice, { name: 'a' }, '127.0.0.1', { mfaAt: 12345 });
  const a = Object.values(s.srv.store.data.sessions).find((x) => x.name === 'console: a');
  assert.equal(a.mfaAt, 12345);
  s.srv.keys.createConsoleKey(alice, { name: 'b' }, '127.0.0.1');
  const b = Object.values(s.srv.store.data.sessions).find((x) => x.name === 'console: b');
  assert.equal(b.mfaAt, 0, 'no parent time: the key needs a code before it does anything sensitive');
});

test('K4: agent keys can be listed, are revoked one at a time, and expire', async () => {
  await s.stepUp('alice');
  await s.stepUp('bob'); // the 13 hours above stale every device
  const second = ok(await s.gql(s.tokens.alice, 'mutation { createAgentKey(agent:"ada", purpose:"sandbox") { token } }')).createAgentKey.token;
  const list = ok(await s.gql(s.tokens.alice, '{ me { agentKeys { id agent purpose createdAt expiresAt lastUsed revoked } } }')).me.agentKeys;
  assert.equal(list.length, 2);
  assert.ok(list.every((k) => k.agent === 'ada' && k.purpose === 'sandbox' && k.revoked === false));
  assert.ok(list.every((k) => k.expiresAt - k.createdAt === 90 * DAY), 'ninety days');
  assert.doesNotMatch(JSON.stringify(list), /gak_/, 'a listing never shows a secret');
  assert.deepEqual(ok(await s.gql(s.tokens.bob, '{ me { agentKeys { id } } }')).me.agentKeys, [], 'only the owner sees them');

  // Revoke the first by id: the second goes on working.
  s.srv.principals.fromToken(agentKey, '127.0.0.1', { purpose: 'sandbox' }); // touches lastUsed
  const first = ok(await s.gql(s.tokens.alice, '{ me { agentKeys { id lastUsed } } }')).me.agentKeys.find((k) => k.lastUsed);
  assert.ok(first, 'lastUsed is shown');
  assert.equal(code(await s.gql(s.tokens.bob, `mutation { revokeAgentKey(id:"${first.id}") }`)), 'agent_key_not_found', 'not bob\'s');
  assert.equal(ok(await s.gql(s.tokens.alice, `mutation { revokeAgentKey(id:"${first.id}") }`)).revokeAgentKey, true);
  assert.equal(s.srv.principals.fromToken(agentKey, '127.0.0.1', { purpose: 'sandbox' }), null);
  assert.equal(s.srv.principals.fromToken(second, '127.0.0.1', { purpose: 'sandbox' })?.agent.handle, 'ada');
  assert.equal(ok(await s.gql(s.tokens.alice, '{ me { agentKeys { id revoked } } }')).me.agentKeys.find((k) => k.id === first.id).revoked, true);

  // Ninety days on, the second has expired.
  s.srv.clock.advance(91 * DAY);
  assert.equal(s.srv.principals.fromToken(second, '127.0.0.1', { purpose: 'sandbox' }), null);
});

test('K4: revoking by id needs a fresh code, like revoking them all', async () => {
  s.srv.clock.advance(11 * 60_000);
  const t = await (await import('./helpers.js')).deviceLogin(s.srv, s.users.alice);
  s.srv.clock.advance(11 * 60_000);
  assert.equal(code(await s.gql(t, 'mutation { revokeAgentKey(id:"abcdef012345") }')), 'mfa_required');
});
