// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Encrypted direct messages. These tests play the browser's part with Node's Web Crypto, the same way
// server/public/dm.js does, so the server is tested with real ciphertext, and checked never to hold the words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, createUser, api, deviceLogin } from './helpers.js';

const { subtle } = globalThis.crypto;
const enc = new TextEncoder(), dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (buf) => Buffer.from(buf).toString('base64');
const hex = (buf) => Buffer.from(buf).toString('hex');
const fingerprint = async (jwk) => hex(await subtle.digest('SHA-256', enc.encode(`P-256:${jwk.x}:${jwk.y}`)));

/** A person's browser: a key pair, and the protocol of dm.js. */
async function browserFor(username) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const me = { username, privateKey: pair.privateKey, publicKey, fingerprint: await fingerprint(publicKey) };
  const keyWith = async (theirJwk, theirFp) => {
    const pub = await subtle.importKey('jwk', theirJwk, ECDH, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, me.privateKey, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('gitcha-dm-v1'), info: enc.encode(`gitcha dm v1|${[me.fingerprint, theirFp].sort().join('|')}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };
  const bound = (m) => enc.encode(JSON.stringify(['gitcha-dm-v1', m.from, m.to, m.fromKey, m.toKey]));
  me.encrypt = async (to, theirKey, text) => {
    const m = { from: username, to, fromKey: me.fingerprint, toKey: theirKey.fingerprint };
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bound(m) }, await keyWith(theirKey.publicKey, theirKey.fingerprint), enc.encode(text));
    return { to, iv: b64(iv), ct: b64(ct), fromKey: m.fromKey, toKey: m.toKey };
  };
  me.decrypt = async (m, theirKey) => dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(m.iv, 'base64'), additionalData: bound(m) }, await keyWith(theirKey.publicKey, theirKey.fingerprint), Buffer.from(m.ct, 'base64')));
  return me;
}

async function setup() {
  const srv = await startServer();
  const people = {};
  for (const [name, pass] of [['alice', 'first long pass!'], ['bob', 'second long pass'], ['carol', 'third long passw']]) {
    const u = createUser(srv, name, pass);
    people[name] = { token: await deviceLogin(srv, u), browser: await browserFor(name) };
  }
  for (const p of Object.values(people)) {
    const r = await api(srv.url, 'PUT', '/api/v1/dm/key', { token: p.token, body: { publicKey: p.browser.publicKey } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fingerprint, p.browser.fingerprint, 'the server computes the same fingerprint as the browser');
  }
  return { srv, ...people };
}

test('a message is stored as ciphertext only, and both people (and only they) can read it', async () => {
  const { srv, alice, bob, carol } = await setup();
  try {
    const bobKey = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body;
    const words = 'Meet at the rail yard at noon. Bring the second key.';
    const sent = await api(srv.url, 'POST', '/api/v1/dm/send', { token: alice.token, body: await alice.browser.encrypt('bob', bobKey, words) });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const db = fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8');
    assert.ok(!db.includes('rail yard') && !db.includes(b64(enc.encode(words))), 'the server never had the words');

    const t = (await api(srv.url, 'GET', '/api/v1/dm/with/alice', { token: bob.token })).body;
    assert.equal(t.messages.length, 1);
    const aliceKey = t.with;
    assert.equal(await bob.browser.decrypt(t.messages[0], aliceKey), words, 'bob reads it');
    const mineAgain = (await api(srv.url, 'GET', '/api/v1/dm/with/bob', { token: alice.token })).body.messages[0];
    assert.equal(await alice.browser.decrypt(mineAgain, bobKey), words, 'and alice can read what she sent');
    await assert.rejects(carol.browser.decrypt(t.messages[0], aliceKey), 'carol\'s key does not open it');
    const relabelled = { ...t.messages[0], from: 'carol' };
    await assert.rejects(bob.browser.decrypt(relabelled, aliceKey), 'a message the server relabels does not decrypt');
    assert.deepEqual((await api(srv.url, 'GET', '/api/v1/dm/with/alice', { token: carol.token })).body.messages, [], 'carol is not in that conversation');

    const convs = (await api(srv.url, 'GET', '/api/v1/dm/conversations', { token: bob.token })).body.conversations;
    assert.deepEqual(convs.map((c) => [c.with, c.unread]), [['alice', 0]], 'opening the conversation marked it read');
  } finally { await srv.close(); }
});

test('a message must name the keys both people have now', async () => {
  const { srv, alice, bob } = await setup();
  try {
    const bobKey = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body;
    const stale = await alice.browser.encrypt('bob', bobKey, 'hello');
    bob.browser = await browserFor('bob'); // bob makes a new key
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/key', { token: bob.token, body: { publicKey: bob.browser.publicKey } })).status, 200);
    const r = await api(srv.url, 'POST', '/api/v1/dm/send', { token: alice.token, body: stale });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'key_changed');
    const view = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body;
    assert.equal(view.history.length, 2, 'the old key stays in the history, so a browser can tell that it changed');
  } finally { await srv.close(); }
});

test('keys, backups and messages are checked for shape; a private part is refused', async () => {
  const { srv, alice } = await setup();
  try {
    const priv = await subtle.exportKey('jwk', (await subtle.generateKey(ECDH, true, ['deriveBits'])).privateKey);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/key', { token: alice.token, body: { publicKey: priv } })).status, 400, 'a key with its private part (d) is refused');
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/key', { token: alice.token, body: { publicKey: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } } })).status, 400);
    const weak = { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-GCM', iterations: 1000, salt: b64(Buffer.alloc(16)), iv: b64(Buffer.alloc(12)), data: 'AAAA' };
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/key', { token: alice.token, body: { publicKey: alice.browser.publicKey, backup: weak } })).status, 400, 'a backup locked with too few rounds is refused');
    const ok = { ...weak, iterations: 600_000 };
    assert.equal((await api(srv.url, 'PUT', '/api/v1/dm/key', { token: alice.token, body: { publicKey: alice.browser.publicKey, backup: ok } })).status, 200);
    assert.deepEqual((await api(srv.url, 'GET', '/api/v1/dm/backup', { token: alice.token })).body.backup, ok, 'only its owner gets the backup back');
    for (const bad of [{ iv: 'short', ct: 'AAAA' }, { iv: b64(Buffer.alloc(12)), ct: '' }, { iv: b64(Buffer.alloc(12)), ct: 'A'.repeat(48_004) }]) {
      const me = (await api(srv.url, 'GET', '/api/v1/dm/me', { token: alice.token })).body;
      const bobFp = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body.fingerprint;
      assert.equal((await api(srv.url, 'POST', '/api/v1/dm/send', { token: alice.token, body: { to: 'bob', fromKey: me.fingerprint, toKey: bobFp, ...bad } })).status, 400);
    }
  } finally { await srv.close(); }
});

test('replacing a key and reading the backup need a fresh code; a block stops messages', async () => {
  const { srv, alice, bob } = await setup();
  try {
    srv.clock.advance(11 * 60_000); // past the 10-minute window for sensitive actions
    const stale = await api(srv.url, 'PUT', '/api/v1/dm/key', { token: alice.token, body: { publicKey: alice.browser.publicKey } });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, 'mfa_required');
    assert.equal((await api(srv.url, 'GET', '/api/v1/dm/backup', { token: alice.token })).body.error, 'mfa_required');

    assert.equal((await api(srv.url, 'POST', '/api/v1/dm/block', { token: bob.token, body: { username: 'alice' } })).status, 200);
    const bobKey = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body;
    const r = await api(srv.url, 'POST', '/api/v1/dm/send', { token: alice.token, body: await alice.browser.encrypt('bob', bobKey, 'hi') });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'blocked');
  } finally { await srv.close(); }
});

test('from a browser, every call needs the CSRF header from the page, reads included', async () => {
  const { srv } = await setup();
  try {
    const sid = srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 't', ip: '127.0.0.1' }).token;
    const page = await fetch(`${srv.url}/messages`, { headers: { Cookie: `gitcha_sid=${sid}` } });
    assert.equal(page.status, 200);
    const csrf = /gitcha_csrf=([^;]+)/.exec(page.headers.get('set-cookie'))[1];
    const html = await page.text();
    assert.match(html, /<script src="\/static\/dm\.js" type="module"><\/script>/);
    assert.match(html, /end-to-end encrypted/);
    const cookies = `gitcha_sid=${sid}; gitcha_csrf=${csrf}`;
    assert.equal((await fetch(`${srv.url}/api/v1/dm/conversations`, { headers: { Cookie: cookies } })).status, 403, 'no header: refused');
    assert.equal((await fetch(`${srv.url}/api/v1/dm/conversations`, { headers: { Cookie: cookies, 'X-Gitcha-CSRF': 'forged.token' } })).status, 403);
    assert.equal((await fetch(`${srv.url}/api/v1/dm/conversations`, { headers: { Cookie: cookies, 'X-Gitcha-CSRF': csrf, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'another site: refused');
    assert.equal((await fetch(`${srv.url}/api/v1/dm/conversations`, { headers: { Cookie: cookies, 'X-Gitcha-CSRF': csrf } })).status, 200);
    const js = await fetch(`${srv.url}/static/dm.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
  } finally { await srv.close(); }
});

test('one person may send at most 300 messages a day', async () => {
  const { srv, alice } = await setup();
  try {
    const day = new Date(srv.clock()).toISOString().slice(0, 10);
    srv.store.tx((d) => { d.dmDaily[srv.store.userByName('alice').id] = { day, count: 300 }; });
    const bobKey = (await api(srv.url, 'GET', '/api/v1/dm/keys/bob', { token: alice.token })).body;
    const r = await api(srv.url, 'POST', '/api/v1/dm/send', { token: alice.token, body: await alice.browser.encrypt('bob', bobKey, 'one more') });
    assert.equal(r.status, 429);
  } finally { await srv.close(); }
});
