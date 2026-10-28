// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What one GraphQL request may cost (GQL-1, GQL-3): fragments count towards the
// depth limit, a thread holds its replies and not itself, aliases and fields
// are bounded, and the work a request may do is metered.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code } from './social-helpers.js';

let s, root, replies;

before(async () => {
  s = await startSocial({ people: ['alice', 'bob'] });
  const { gql, tokens } = s;
  root = ok(await gql(tokens.alice, 'mutation { createPost(title:"A long thread", body:"root") { id } }')).createPost.id;
  replies = [];
  for (let i = 0; i < 8; i++) replies.push(ok(await gql(tokens.bob, `mutation { reply(to:"${root}", body:"reply ${i}") { id } }`)).reply.id);
});
after(() => s.srv.close());

test('GQL-1: the depth limit follows fragment spreads, so a chain of fragments cannot reach any depth', async () => {
  // 30 fragments, each one level of `thread`, each spreading the next: depth 31 through spreads.
  let q = '';
  for (let i = 0; i < 30; i++) q += `fragment F${i} on Post { thread { ...F${i + 1} } }\n`;
  q += 'fragment F30 on Post { id }\n';
  q += `{ post(id:"${root}") { ...F0 } }`;
  const r = await s.gql(null, q);
  assert.equal(r.status, 400, JSON.stringify(r).slice(0, 200));
  assert.equal(r.error, 'too_deep');
});

test('GQL-1: a fragment that spreads itself is refused, not walked for ever', async () => {
  const r = await s.gql(null, `fragment Loop on Post { id thread { ...Loop } } { post(id:"${root}") { ...Loop } }`);
  assert.equal(r.status, 400);
});

test('GQL-1: Post.thread holds the replies and never the post itself', async () => {
  const t = ok(await s.gql(null, `{ post(id:"${root}") { thread { id } } }`)).post.thread.map((x) => x.id);
  assert.deepEqual(t, replies, 'the eight replies, in order, and not the root');
  const under = ok(await s.gql(null, `{ post(id:"${replies[0]}") { thread { id } } }`)).post.thread;
  assert.deepEqual(under, [], 'a reply that nobody answered has an empty thread');
});

test('GQL-1: nesting thread inside thread no longer multiplies the work', async () => {
  const r = await s.gql(null, `{ post(id:"${root}") { thread { thread { thread { thread { thread { id } } } } } } }`);
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r).length < 20_000, `the answer is small (${JSON.stringify(r).length} bytes)`);
});

test('GQL-1: a chain of 30 answers cannot be walked 5 levels deep; the request is metered and refused', async () => {
  let prev = root;
  for (let i = 0; i < 30; i++) prev = ok(await s.gql(s.tokens.bob, `mutation { reply(to:"${prev}", body:"deeper ${i}") { id } }`)).reply.id;
  const started = Date.now();
  const r = await s.gql(null, `{ post(id:"${root}") { thread { thread { thread { thread { thread { id } } } } } } }`);
  assert.equal(r.status, 400, JSON.stringify(r).slice(0, 200));
  assert.equal(r.error, 'too_costly');
  assert.ok(Date.now() - started < 5000);
});

test('GQL-3: more than ten aliased fields in one request are refused', async () => {
  const aliased = (n) => `{ ${Array.from({ length: n }, (_, i) => `a${i}: feed(limit:1) { id }`).join(' ')} }`;
  const bad = await s.gql(null, aliased(11));
  assert.equal(bad.status, 400);
  assert.equal(bad.error, 'too_many_aliases');
  assert.equal((await s.gql(null, aliased(10))).status, 200);
});

test('GQL-3: a fragment that expands to thousands of fields is refused at once', async () => {
  let q = 'fragment F0 on Post { id }\n';
  for (let i = 1; i <= 12; i++) q += `fragment F${i} on Post { ...F${i - 1} author { name } ...F${i - 1} }\n`;
  q += '{ feed { ...F12 } }';
  const started = Date.now();
  const r = await s.gql(null, q);
  assert.equal(r.status, 400, JSON.stringify(r).slice(0, 200));
  assert.equal(r.error, 'too_complex');
  assert.ok(Date.now() - started < 2000);
});

test('GQL-3: variables on a GET that are not JSON answer 400, not 500', async () => {
  const res = await fetch(`${s.srv.url}/api/graphql?query=${encodeURIComponent('{ topics { tag } }')}&variables=${encodeURIComponent('{nope')}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_variables');
  const fine = await fetch(`${s.srv.url}/api/graphql?query=${encodeURIComponent('query($n:Int){ topics(limit:$n) { tag } }')}&variables=${encodeURIComponent('{"n":3}')}`);
  assert.equal(fine.status, 200);
});

test('the limits leave ordinary queries alone', async () => {
  const r = await s.gql(s.tokens.alice, '{ me { username agents { handle } } feed(limit:5) { id title author { name byline } replies thread { id } } topics { tag threads } }');
  assert.equal(r.status, 200);
  assert.equal(code(r), undefined);
});

test('GQL-4: schema introspection is off unless the operator turns it on, and suggestions do not spell the schema', async () => {
  const r = await s.gql(null, '{ __schema { types { name } } }');
  assert.equal(r.status, 403);
  assert.equal(r.error, 'introspection_off');
  assert.equal((await s.gql(null, '{ __type(name:"Post") { name } }')).error, 'introspection_off');
  assert.equal((await s.gql(null, '{ __typename }')).status, 200, '__typename is not introspection');
  const typo = await s.gql(null, '{ usr(username:"alice") { username } }');
  assert.doesNotMatch(typo.errors[0].message, /Did you mean/);

  const on = await startSocial({ people: ['alice'], overrides: { social: { introspection: true } } });
  try {
    const open = await on.gql(null, '{ __schema { types { name } } }');
    assert.ok(open.data.__schema.types.length > 20);
  } finally { await on.srv.close(); }
});
