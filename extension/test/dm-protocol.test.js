// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The direct-message protocol (version 2): sealed sender, signed prekeys, padding, forward secrecy, backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../lib/dm-protocol.js';

/** A person: identity, one prekey, and what the server would publish about them. */
async function person(name, now = Date.now()) {
  const id = P.newIdentity ? await P.newIdentity() : null;
  const identityKey = await P.importIdentity(id.pkcs8);
  const pre = await P.newPrekey(identityKey, now);
  const prekeys = new Map([[pre.id, await P.importPrekey(pre.pkcs8)]]);
  return {
    name, id, identityKey, pre, prekeys,
    box: () => ({ fingerprint: id.fingerprint, prekey: { id: pre.id, publicKey: pre.publicKey } }),
    opener: (directory) => ({ me: name, myFingerprint: id.fingerprint, prekeyKey: async (k) => prekeys.get(k) ?? null, signerOf: async (u) => directory[u]?.id.publicKey ?? null }),
  };
}

test('a sealed message opens for its recipient, and the sender\'s own copy opens for the sender', async () => {
  const alice = await person('alice'), bob = await person('bob');
  const dir = { alice, bob };
  const env = await P.seal({ identityKey: alice.identityKey, from: 'alice', to: 'bob', at: 1000, text: 'the second key is under the mat', box: bob.box() });
  assert.deepEqual(await P.open(env, bob.opener(dir)), { from: 'alice', to: 'bob', at: 1000, text: 'the second key is under the mat', signer: alice.id.fingerprint });
  const mine = await P.seal({ identityKey: alice.identityKey, from: 'alice', to: 'bob', at: 1000, text: 'the second key is under the mat', box: alice.box() });
  assert.equal((await P.open(mine, alice.opener(dir))).to, 'bob');
  assert.equal(JSON.stringify(env).includes('alice'), false, 'the envelope does not name the sender');
  assert.equal(JSON.stringify(env).includes('under the mat'), false);
});

test('a third person cannot open it, a forwarded copy does not verify, and a change breaks it', async () => {
  const alice = await person('alice'), bob = await person('bob'), carol = await person('carol');
  const dir = { alice, bob, carol };
  const env = await P.seal({ identityKey: alice.identityKey, from: 'alice', to: 'bob', text: 'hi bob', box: bob.box() });
  await assert.rejects(P.open(env, carol.opener(dir)), /destroyed|could not be decrypted/);
  // Carol tries to pass the envelope off as hers by putting it in her own inbox under her fingerprint: the AES
  // additional data binds the recipient's fingerprint, so it does not open.
  await assert.rejects(P.open(env, { ...bob.opener(dir), myFingerprint: carol.id.fingerprint }), /could not be decrypted/);
  const ct = P.unb64(env.ct); ct[5] ^= 1;
  await assert.rejects(P.open({ ...env, ct: P.b64(ct) }, bob.opener(dir)), /could not be decrypted/);
});

test('a message signed by someone else than the name inside it is refused', async () => {
  const alice = await person('alice'), bob = await person('bob'), mallory = await person('mallory');
  const env = await P.seal({ identityKey: mallory.identityKey, from: 'alice', to: 'bob', text: 'it is me, alice', box: bob.box() });
  await assert.rejects(P.open(env, bob.opener({ alice, bob, mallory })), /signature does not match alice/);
});

test('lengths are hidden: texts of different lengths in one bucket make envelopes of one size', async () => {
  const alice = await person('alice'), bob = await person('bob');
  const sizes = new Set();
  for (const text of ['ok', 'see you at noon', 'a'.repeat(250)]) sizes.add((await P.seal({ identityKey: alice.identityKey, from: 'alice', to: 'bob', text, box: bob.box() })).ct.length);
  assert.equal(sizes.size, 1);
  assert.deepEqual([...P.unpad(P.pad(new Uint8Array([1, 2, 3])))], [1, 2, 3]);
  assert.equal(P.pad(new Uint8Array(300)).length, 512);
  assert.equal(P.pad(new Uint8Array(600)).length, 2048);
  assert.throws(() => P.pad(new Uint8Array(70_000)), /at most/);
});

test('prekeys are signed by their identity; a swapped prekey does not verify', async () => {
  const alice = await person('alice'), bob = await person('bob');
  assert.equal(await P.verifyPrekey(bob.id.publicKey, bob.pre), true);
  assert.equal(await P.verifyPrekey(bob.id.publicKey, { ...bob.pre, publicKey: alice.pre.publicKey }), false, 'a server cannot slip in its own prekey');
  assert.equal(await P.verifyPrekey(alice.id.publicKey, bob.pre), false);
});

test('forward secrecy: once a prekey is destroyed, messages sent to it cannot be opened, even with the identity key', async () => {
  const alice = await person('alice'), bob = await person('bob');
  const env = await P.seal({ identityKey: alice.identityKey, from: 'alice', to: 'bob', text: 'old news', box: bob.box() });
  bob.prekeys.delete(bob.pre.id); // the prekey grew older than 30 days and was destroyed
  await assert.rejects(P.open(env, bob.opener({ alice, bob })), /destroyed/);
  const now = Date.now();
  const kept = P.prune([{ id: 'a', createdAt: now - 40 * 86_400_000 }, { id: 'b', createdAt: now - 10 * 86_400_000 }, { id: 'c', createdAt: now }], now);
  assert.deepEqual(kept.map((k) => k.id), ['b', 'c']);
  assert.deepEqual(P.prune([{ id: 'only', createdAt: now - 99 * 86_400_000 }], now).map((k) => k.id), ['only'], 'the newest prekey is never dropped');
});

test('the keyring locks with a passphrase and unlocks only with it', async () => {
  const alice = await person('alice');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const keyring = { identity: { pkcs8: alice.id.pkcs8, publicKey: alice.id.publicKey }, prekeys: [alice.pre] };
  const backup = await P.lockKeyring(keyring, await P.passphraseKey('a long walk by the river', salt, 1000), { salt, iterations: 1000 });
  assert.equal(JSON.stringify(backup).includes(alice.id.pkcs8), false);
  assert.deepEqual(await P.unlockKeyring(backup, await P.passphraseKey('a long walk by the river', salt, 1000)), keyring);
  await assert.rejects(P.unlockKeyring(backup, await P.passphraseKey('wrong words', salt, 1000)), /does not unlock/);
});

test('the safety number is the same both ways round', async () => {
  assert.equal(await P.safetyNumber('aa', 'bb'), await P.safetyNumber('bb', 'aa'));
  assert.match(await P.safetyNumber('aa', 'bb'), /^(\d{5} ){11}\d{5}$/);
});
