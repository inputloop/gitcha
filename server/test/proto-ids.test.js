// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Names every object has are never ids (GQL-4): an id argument that is one answers
// 400, and a lookup handed one finds nothing instead of a prototype.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code } from './social-helpers.js';

let s, postId;
const NAMES = ['__proto__', 'constructor', 'prototype'];

before(async () => {
  s = await startSocial({ people: ['admin1', 'alice'] });
  postId = ok(await s.gql(s.tokens.alice, 'mutation { createPost(title:"A real post", body:"hello") { id } }')).createPost.id;
  ok(await s.gql(s.tokens.admin1, 'mutation { setRole(username:"alice", role:"staff") }'));
});
after(() => s.srv.close());

test('GQL-4: an ID argument that names something on every object is refused with 400', async () => {
  const tryOne = async (query, variables) => {
    const r = await s.gql(s.tokens.alice, query, variables);
    assert.equal(r.status, 400, `${query} -> ${JSON.stringify(r).slice(0, 160)}`);
    assert.equal(r.error, 'bad_id');
  };
  for (const n of NAMES) {
    await tryOne(`{ post(id:"${n}") { id } }`);
    await tryOne(`{ task(id:"${n}") { id } }`);
    await tryOne(`{ ticket(id:"${n}") { id } }`);
    await tryOne(`{ change(id:"${n}") { id } }`);
    await tryOne(`mutation { vote(post:"${n}", value:1) { id } }`);
    await tryOne(`mutation { reply(to:"${n}", body:"x") { id } }`);
  }
  await tryOne('query($i:ID!) { post(id:$i) { id } }', { i: '__proto__' });
  await tryOne('mutation($i:ID!) { reply(to:$i, body:"x") { id } }', { i: 'constructor' });
  // A real id, and a name that merely contains one, are fine.
  assert.equal(ok(await s.gql(s.tokens.alice, `{ post(id:"${postId}") { id } }`)).post.id, postId);
  assert.equal(ok(await s.gql(s.tokens.alice, '{ post(id:"my-constructor") { id } }')).post, null);
});

test('GQL-4: names that are not ids (handles, usernames, project names) answer not-found, never an internal error', async () => {
  for (const n of NAMES) {
    const r = await s.gql(s.tokens.alice, `{ a: agent(handle:"${n}") { handle } u: user(username:"${n}") { username } p: project(owner:"${n}", name:"${n}") { key } }`);
    assert.equal(r.status, 200);
    assert.notEqual(code(r), 'internal', JSON.stringify(r.errors));
    assert.deepEqual(r.data, { a: null, u: null, p: null });
  }
  // A post cannot carry media that is not there.
  const r = await s.gql(s.tokens.alice, 'mutation { createPost(title:"Media that is not", body:"x", media:["__proto__"]) { id } }');
  assert.ok(r.status === 400 || code(r) === 'bad_media', JSON.stringify(r).slice(0, 200));
});

test('GQL-4: the services read their own entries only', () => {
  const staff = s.srv.store.userByName('alice');
  for (const n of NAMES) {
    assert.throws(() => s.srv.social.get(n), (e) => e.status === 404);
    assert.throws(() => s.srv.tasks.get(n), (e) => e.status === 404);
    assert.throws(() => s.srv.ops.ticket(staff, n), (e) => e.status === 404 && e.code === 'ticket_not_found');
    assert.throws(() => s.srv.ops.change(staff, n), (e) => e.status === 404 && e.code === 'change_not_found');
    assert.equal(s.srv.agents.find(n), null);
    assert.throws(() => s.srv.agents.get(n), (e) => e.status === 404);
    assert.equal(s.srv.social.mediaView(n), null);
  }
});
