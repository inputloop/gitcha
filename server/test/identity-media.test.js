// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Bylines name one person (SOC-1) and an account's uploads are bounded (MEDIA-1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSocial, ok, code } from './social-helpers.js';

let s;
const as = (who) => (query, variables) => s.gql(s.tokens[who], query, variables);
const setName = (who, name) => as(who)(`mutation { updateProfile(displayName:"${name}") { displayName } }`);

before(async () => { s = await startSocial({ people: ['alice', 'bob', 'carol'] }); });
after(() => s.srv.close());

test('SOC-1: a display name cannot be another person\'s username or display name', async () => {
  assert.equal(code(await setName('bob', 'alice')), 'display_name_taken', 'a username');
  assert.equal(code(await setName('bob', 'ALICE')), 'display_name_taken', 'whatever the case');
  assert.equal(ok(await setName('alice', 'Alice')).updateProfile.displayName, 'Alice', 'one\'s own username, in capitals, is fine');
  assert.equal(code(await setName('carol', 'Alice')), 'display_name_taken', 'another\'s display name');
  assert.equal(ok(await setName('carol', 'Carol the Careful')).updateProfile.displayName, 'Carol the Careful');
  assert.equal(ok(await setName('carol', 'Carol the Careful')).updateProfile.displayName, 'Carol the Careful', 'saving the same name again is not a clash');
  assert.equal(s.srv.store.userByName('bob').profile?.displayName, undefined, 'bob was left as he was');
});

test('SOC-1: a byline resolves to the named person\'s agent, whoever registered first', async () => {
  const { store, agents } = s.srv;
  // Bob took the display name "alice" before this rule (a name he can no longer set), and registered Ada first.
  store.tx((d) => { d.users[store.userByName('bob').id].profile = { displayName: 'alice' }; });
  ok(await as('bob')('mutation { registerAgent(handle:"mal-ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  ok(await as('alice')('mutation { registerAgent(handle:"ada", name:"Ada", model:"claude-opus-5-5") { handle } }'));
  assert.equal(agents.fromByline({ name: 'Ada', forName: 'alice', model: null })?.handle, 'ada', 'the username wins over a display name');
  assert.equal(agents.fromByline({ name: 'ADA', forName: 'Alice', model: null })?.handle, 'ada');
  // A display name two people share names nobody.
  store.tx((d) => { d.users[store.userByName('carol').id].profile = { displayName: 'Dee' }; d.users[store.userByName('bob').id].profile = { displayName: 'dee' }; });
  ok(await as('carol')('mutation { registerAgent(handle:"cee", name:"Cee", model:"claude-opus-5-5") { handle } }'));
  ok(await as('bob')('mutation { registerAgent(handle:"bee", name:"Cee", model:"claude-opus-5-5") { handle } }'));
  assert.equal(agents.fromByline({ name: 'Cee', forName: 'Dee', model: null }), null, 'two people are called Dee: the byline names neither');
  // A display name held by one person still works.
  store.tx((d) => { d.users[store.userByName('bob').id].profile = { displayName: 'Bobby' }; });
  assert.equal(agents.fromByline({ name: 'Cee', forName: 'Dee', model: null })?.handle, 'cee');
  assert.equal(agents.fromByline({ name: 'Cee', forName: 'Bobby', model: null })?.handle, 'bee');
});

test('MEDIA-1: an account may add a bounded amount of public media a day', async () => {
  const png = (n) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(992, n)]); // 1000 bytes, each distinct
  const up = (who, buf) => fetch(`${s.srv.url}/api/v1/media`, { method: 'POST', headers: { Authorization: `Bearer ${s.tokens[who]}` }, body: buf });
  s.srv.config.social.mediaDailyBytes = 3500;
  try {
    for (let i = 1; i <= 3; i++) assert.equal((await up('alice', png(i))).status, 201, `upload ${i}`);
    const over = await up('alice', png(4));
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error, 'media_quota');
    assert.equal((await up('bob', png(5))).status, 201, 'another account has its own allowance');
    // Not a clock trick: the next UTC day starts again.
    s.srv.clock.advance(25 * 3600_000);
    await s.stepUp('alice');
    assert.equal((await up('alice', png(6))).status, 201);
    assert.equal(Object.keys(s.srv.store.data.media).length, 5, 'the refused file was not stored');
  } finally { delete s.srv.config.social.mediaDailyBytes; }
});

test('MEDIA-1: the number of files a day is bounded too', async () => {
  const up = (n) => s.srv.social.uploadMedia({ kind: 'user', user: s.srv.store.userByName('carol') }, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`file number ${n}`)]));
  for (let i = 0; i < 200; i++) up(i);
  assert.throws(() => up(200), (e) => e.status === 429 && e.code === 'media_quota');
});
