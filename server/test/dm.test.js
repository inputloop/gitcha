// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Encrypted direct messages (protocol version 2), driven through the same device code the browser page and
// the CLI use (extension/lib/dm-client.js), against a real server. Each test reads what the server stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { DmDevice } from '../../extension/lib/dm-client.js';
import * as P from '../../extension/lib/dm-protocol.js';

const DAY = 86_400_000;

/** A device for `name`, signed in with `token`, keeping its keys in memory. */
function deviceFor(srv, name, token) {
  const mem = {};
  const call = async (method, p, body) => {
    const r = await api(srv.url, method, `/api/v1/dm${p}`, { token, body });
    if (r.status >= 400) { const e = new Error(r.body.message); e.code = r.body.error; throw e; }
    return r.body;
  };
  return new DmDevice({ me: name, api: call, storage: { get: async (n) => mem[n], put: async (n, v) => { mem[n] = structuredClone(v); } }, mode: 'pkcs8', now: () => srv.clock() });
}

async function setup() {
  // Some tests move the clock on by weeks; long sessions and a long 2FA re-check keep these test devices signed
  // in meanwhile (a real device would sign in again). The 10-minute window for sensitive actions is unchanged.
  const year = 365 * DAY;
  const srv = await startServer({ overrides: { policy: { sessionIdle: year, sessionMaxAge: year, stepUpInterval: year } } });
  const out = { srv };
  for (const [name, pass] of [['alice', 'first long pass!'], ['bob', 'second long pass'], ['carol', 'third long passw']]) {
    const u = createUser(srv, name, pass);
    const token = await deviceLogin(srv, u);
    out[name] = { user: u, token, device: deviceFor(srv, name, token) };
  }
  return out;
}
const db = (srv) => JSON.parse(fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8'));

test('a message reaches its recipient and the sender\'s own copy, and the server cannot tell who wrote to whom', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup('alice backup words');
    await bob.device.setup(null);
    assert.equal((await alice.device.status()).state, 'ready');
    await alice.device.send('bob', 'Meet at the rail yard at noon.');
    await bob.device.status();
    await bob.device.sync();
    assert.deepEqual(bob.device.thread('alice').map((m) => [m.from, m.text, m.trusted]), [['alice', 'Meet at the rail yard at noon.', true]]);
    assert.deepEqual(alice.device.thread('bob').map((m) => [m.from, m.to, m.out]), [['alice', 'bob', true]], 'alice reads her own copy');

    const stored = db(srv);
    const raw = JSON.stringify(stored);
    assert.ok(!raw.includes('rail yard'), 'the words are not on the server');
    const records = Object.values(stored.dmBox);
    assert.equal(records.length, 2, 'one envelope in each inbox');
    const ids = { alice: srv.store.userByName('alice').id, bob: srv.store.userByName('bob').id };
    assert.deepEqual(records.map((r) => r.owner).sort(), [ids.alice, ids.bob].sort());
    for (const r of records) {
      assert.deepEqual(Object.keys(r).sort(), ['ct', 'day', 'ek', 'id', 'iv', 'owner', 'seq', 'spk', 'v'], 'no sender, no recipient, no time of day');
      assert.equal(r.seq, 1, 'each inbox counts on its own, so two records cannot be paired by number');
      assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(!JSON.stringify(r).includes(r.owner === ids.alice ? ids.bob : ids.alice), 'a record does not name the other person');
    }
  } finally { await srv.close(); }
});

test('envelopes come in a few fixed sizes, so a message\'s length does not show', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup(null);
    await bob.device.setup(null);
    for (const text of ['ok', 'see you at noon by the north gate, bring the second key and the map']) await alice.device.send('bob', text);
    const inbox = Object.values(db(srv).dmBox).filter((r) => r.owner === srv.store.userByName('bob').id);
    assert.equal(new Set(inbox.map((r) => r.ct.length)).size, 1);
  } finally { await srv.close(); }
});

test('forward secrecy: the prekey is replaced every 7 days and destroyed after 30, and then old envelopes cannot be opened', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup(null);
    await bob.device.setup(null);
    const first = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body.prekey.id;
    await alice.device.send('bob', 'an old secret');
    const envelope = Object.values(db(srv).dmBox).find((r) => r.owner === srv.store.userByName('bob').id);
    for (let week = 0; week < 5; week++) { srv.clock.advance(8 * DAY); await bob.device.status(); }
    const now = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body.prekey.id;
    assert.notEqual(now, first, 'bob\'s device made new prekeys');
    assert.equal(await bob.device.prekeyKey(first), null, 'and destroyed the first one');
    await assert.rejects(P.open(envelope, { me: 'bob', myFingerprint: bob.device.keys.identity.fingerprint, prekeyKey: (id) => bob.device.prekeyKey(id), signerOf: async () => alice.device.keys.identity.publicKey }), /destroyed/);
    assert.ok(srv.dm.sweep() >= 1, 'the server deletes envelopes older than 30 days too');
    assert.equal(Object.values(db(srv).dmBox).length, 0);
  } finally { await srv.close(); }
});

test('a second device unlocks from the backup, and later picks up a prekey the first made, without a fresh code', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup('alice backup words');
    await bob.device.setup(null);
    const tablet = deviceFor(srv, 'alice', alice.token);
    assert.equal((await tablet.status()).state, 'restore');
    await assert.rejects(tablet.restore('the wrong words'), /does not unlock/);
    await tablet.restore('alice backup words');
    assert.equal((await tablet.status()).state, 'ready');

    srv.clock.advance(8 * DAY);
    await alice.device.status(); // the first device replaces the prekey, and updates the locked backup
    await bob.device.status();
    await bob.device.send('alice', 'sent to the new prekey');
    // The tablet's 2FA is not fresh now; it proves it holds the identity key instead, and gets the new prekey.
    assert.equal((await api(srv.url, 'GET', '/api/v1/dm/backup', { token: alice.token })).body.error, 'mfa_required', 'without a proof, a fresh code is needed');
    assert.equal((await tablet.status()).state, 'ready');
    await tablet.sync();
    assert.deepEqual(tablet.thread('bob').map((m) => m.text), ['sent to the new prekey']);
  } finally { await srv.close(); }
});

test('when a contact\'s key changes, sending stops until it is checked; messages signed by an unconfirmed key are marked', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup(null);
    await bob.device.setup(null);
    await alice.device.send('bob', 'hello');
    const bobAgain = deviceFor(srv, 'bob', bob.token);
    await bobAgain.load();
    await bobAgain.setup(null); // bob starts over with new keys
    alice.device.directory.clear();
    assert.equal((await alice.device.contact('bob', { fresh: true })).pin, 'changed');
    await assert.rejects(alice.device.send('bob', 'are you still you?'), /key changed/);
    await bobAgain.send('alice', 'new keys, same bob');
    await alice.device.sync();
    assert.equal(alice.device.thread('bob').find((m) => m.text === 'new keys, same bob').trusted, false);
    await alice.device.acceptKey('bob');
    assert.equal(alice.device.thread('bob').find((m) => m.text === 'new keys, same bob').trusted, true);
    await alice.device.send('bob', 'checked the number, hello again');
  } finally { await srv.close(); }
});

test('the server checks what it can: signed prekeys, public keys only, backup settings, blocks, limits', async () => {
  const { srv, alice, bob } = await setup();
  try {
    await alice.device.setup('alice backup words');
    await bob.device.setup(null);
    const id = await P.newIdentity();
    const other = await P.newIdentity();
    const forged = await P.newPrekey(await P.importIdentity(other.pkcs8), srv.clock());
    const pub = (p) => ({ id: p.id, createdAt: p.createdAt, publicKey: p.publicKey, sig: p.sig });
    const r1 = await api(srv.url, 'PUT', '/api/v1/dm/identity', { token: alice.token, body: { identityKey: id.publicKey, prekey: pub(forged) } });
    assert.equal(r1.status, 400, 'a prekey not signed by the identity key is refused');
    const priv = await globalThis.crypto.subtle.exportKey('jwk', (await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/identity', { token: alice.token, body: { identityKey: priv, prekey: pub(forged) } })).status, 400, 'a private key is refused');

    const k = await P.newPrekey(await alice.device.identityKey(), srv.clock());
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const backup = await P.lockKeyring({ identity: {}, prekeys: [] }, await P.passphraseKey('another passphrase', salt, 200_000), { salt, iterations: 200_000 });
    const swap = await api(srv.url, 'PUT', '/api/v1/dm/prekey', { token: alice.token, body: { prekey: pub(k), backup } });
    assert.equal(swap.status, 400, 'a rotation cannot swap in a backup with other passphrase settings');

    assert.equal((await api(srv.url, 'POST', '/api/v1/dm/block', { token: bob.token, body: { username: 'alice' } })).status, 200);
    await assert.rejects(alice.device.send('bob', 'hi'), /does not take messages from you/);

    const day = new Date(srv.clock()).toISOString().slice(0, 10);
    srv.store.tx((d) => { d.dmDaily[srv.store.userByName('bob').id] = { day, count: 300 }; });
    await assert.rejects(bob.device.send('alice', 'one more'), /limit is 300/);
  } finally { await srv.close(); }
});

test('setting keys needs a fresh code; from a browser every call needs the page\'s CSRF token, reads included', async () => {
  const { srv, alice } = await setup();
  try {
    srv.clock.advance(11 * 60_000);
    await assert.rejects(alice.device.setup(null), (err) => err.code === 'mfa_required');
    const sid = srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 't', ip: '127.0.0.1' }).token;
    const page = await fetch(`${srv.url}/messages`, { headers: { Cookie: `gitcha_sid=${sid}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    const csrf = /data-csrf="([^"]+)"/.exec(html)[1];
    assert.match(html, /<script src="\/static\/dm\.js" type="module"><\/script>/);
    const cookies = `gitcha_sid=${sid}; gitcha_csrf=${csrf}`;
    assert.equal((await fetch(`${srv.url}/api/v1/dm/box`, { headers: { Cookie: cookies } })).status, 403, 'no header: refused');
    assert.equal((await fetch(`${srv.url}/api/v1/dm/box`, { headers: { Cookie: cookies, 'X-Gitcha-CSRF': csrf, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${srv.url}/api/v1/dm/box`, { headers: { Cookie: cookies, 'X-Gitcha-CSRF': csrf } })).status, 200);
    for (const f of ['dm.js', 'dm-client.js', 'dm-protocol.js']) {
      const js = await fetch(`${srv.url}/static/${f}`);
      assert.equal(js.status, 200, f);
      assert.match(js.headers.get('content-type'), /text\/javascript/);
    }
    const served = Buffer.from(await (await fetch(`${srv.url}/static/dm-protocol.js`)).arrayBuffer());
    assert.deepEqual(served, fs.readFileSync(new URL('../../extension/lib/dm-protocol.js', import.meta.url)), 'the page gets exactly the file the CLI ships');
  } finally { await srv.close(); }
});
