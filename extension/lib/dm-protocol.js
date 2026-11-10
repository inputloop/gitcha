// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The encryption for Gitcha's direct messages (protocol version 2). One file, used three ways: the browser
// loads it from the server (/static/dm-protocol.js), the gitcha CLI ships its own copy in its package, and
// the tests run it in Node. It uses only Web Crypto, which browsers and Node 20+ both have.
//
// The parts:
//   Identity key   An ECDSA P-256 key pair (for signing). Its public half is who you are; its fingerprint is
//                  what the safety number is made from.
//   Prekey         An ECDH P-256 key pair, signed by the identity key, replaced every 7 days. Messages to you
//                  are encrypted to your current prekey. Old prekeys are destroyed after 30 days, and with them
//                  any way to open messages sent to them: that is the "forward secrecy" (stealing your keys
//                  later does not open older messages).
//   A message      The sender makes a one-time ECDH key, combines it with the recipient's prekey (ECDH), and
//                  turns the result into an AES-256-GCM key (HKDF-SHA256). Inside the encryption go the sender,
//                  the recipient, the exact time and the text, signed with the sender's identity key. So the
//                  server never needs to know (or store) who sent it, and the recipient can check who did.
//                  The text is padded to a fixed size (512 bytes, 2, 8 or 64 KB) so its length is hidden.
//   Backup         The identity key and the prekeys of the last 30 days, locked with a key made from a
//                  passphrase (PBKDF2-SHA256, 600,000 rounds, then AES-GCM). The server stores the locked copy.

export const VERSION = 2;
export const ROTATE_MS = 7 * 86_400_000;   // make a new prekey after 7 days
export const KEEP_MS = 30 * 86_400_000;    // destroy prekeys (and their messages) after 30 days
export const ITERATIONS = 600_000;
// Padded sizes. The signature and names inside take about 160 bytes, so the smallest holds a few hundred
// characters of text: most messages are the same size.
export const BUCKETS = [512, 2048, 8192, 65536];
export const MAX_TEXT_BYTES = 60_000;

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

// ---- encoding helpers -------------------------------------------------------------------------------------
export const b64 = (buf) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const canon = (parts) => enc.encode(JSON.stringify(parts)); // a fixed-order array, so both sides sign the same bytes
const publicPart = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
const randomHex = (n) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));

/** A public key's fingerprint: SHA-256 of "P-256:x:y", as hex. The server computes it the same way. */
export async function fingerprint(jwk) { return hex(await subtle.digest('SHA-256', enc.encode(`P-256:${jwk.x}:${jwk.y}`))); }

/** The safety number for two identity fingerprints: 12 groups of 5 digits, the same for both people. */
export async function safetyNumber(fpA, fpB) {
  const d = new Uint8Array(await subtle.digest('SHA-256', enc.encode([fpA, fpB].sort().join(':'))));
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(String(((d[i * 2] << 8) | d[i * 2 + 1]) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

// ---- padding: hide the length -----------------------------------------------------------------------------
/** Pad bytes to the next bucket size. The first 4 bytes say how long the real content is. */
export function pad(bytes) {
  const need = bytes.length + 4;
  const size = BUCKETS.find((b) => b >= need);
  if (!size) throw new Error(`A message can be at most ${BUCKETS.at(-1) - 4} bytes once written out.`);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
export function unpad(padded) {
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (n > padded.length - 4) throw new Error('The padded message is damaged.');
  return padded.subarray(4, 4 + n);
}

// ---- keys -------------------------------------------------------------------------------------------------
/** A new identity: an ECDSA key pair. Returns the private key as PKCS#8 bytes (for the keyring) and the public JWK. */
export async function newIdentity() {
  const pair = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const publicKey = publicPart(await subtle.exportKey('jwk', pair.publicKey));
  return { pkcs8: b64(await subtle.exportKey('pkcs8', pair.privateKey)), publicKey, fingerprint: await fingerprint(publicKey) };
}

/** A new prekey, signed by the identity. `identityKey` is the identity's private CryptoKey. */
export async function newPrekey(identityKey, now = Date.now()) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const publicKey = publicPart(await subtle.exportKey('jwk', pair.publicKey));
  const id = randomHex(12);
  const sig = b64(await subtle.sign(SIGN, identityKey, canon(['gitcha-dm-v2-prekey', id, publicKey.x, publicKey.y, now])));
  return { id, createdAt: now, publicKey, sig, pkcs8: b64(await subtle.exportKey('pkcs8', pair.privateKey)) };
}

/** Check a published prekey's signature against its owner's identity key (a public JWK). */
export async function verifyPrekey(identityPublic, prekey) {
  try {
    const key = await subtle.importKey('jwk', publicPart(identityPublic), ECDSA, false, ['verify']);
    return await subtle.verify(SIGN, key, unb64(prekey.sig), canon(['gitcha-dm-v2-prekey', prekey.id, prekey.publicKey.x, prekey.publicKey.y, prekey.createdAt]));
  } catch { return false; }
}

export const importIdentity = (pkcs8, extractable = false) => subtle.importKey('pkcs8', unb64(pkcs8), ECDSA, extractable, ['sign']);
export const importPrekey = (pkcs8, extractable = false) => subtle.importKey('pkcs8', unb64(pkcs8), ECDH, extractable, ['deriveBits']);

/** The AES-GCM key for one envelope, from the one-time key and the prekey (either side's private half). */
async function envelopeKey(privateKey, publicJwk, { ek, spk, toFp }) {
  const pub = await subtle.importKey('jwk', publicPart(publicJwk), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('gitcha-dm-v2'), info: canon(['gitcha-dm-v2', ek.x, ek.y, spk, toFp]) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- messages ---------------------------------------------------------------------------------------------
/**
 * Seal one message into an envelope for one inbox. `box` is the person whose inbox it goes to (the recipient,
 * or the sender for their own copy): { fingerprint, prekey: { id, publicKey } }. The signed content names the
 * real sender and recipient (`from`, `to`), the time and the text; none of it is visible outside.
 */
export async function seal({ identityKey, from, to, at = Date.now(), text, box }) {
  const bytes = enc.encode(String(text));
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`A message can be at most ${MAX_TEXT_BYTES} bytes.`);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ek = publicPart(await subtle.exportKey('jwk', eph.publicKey));
  const spk = box.prekey.id, toFp = box.fingerprint;
  const sig = b64(await subtle.sign(SIGN, identityKey, canon(['gitcha-dm-v2-msg', from, to, at, text, ek.x, ek.y, spk, toFp])));
  const body = pad(enc.encode(JSON.stringify({ v: VERSION, from, to, at, text: String(text), sig })));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await envelopeKey(eph.privateKey, box.prekey.publicKey, { ek, spk, toFp });
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: canon(['gitcha-dm-v2', ek.x, ek.y, spk, toFp]) }, key, body);
  return { v: VERSION, ek, spk, iv: b64(iv), ct: b64(ct) };
}

/**
 * Open an envelope from my inbox. `prekeyKey(id)` gives my prekey's private CryptoKey (or null if it was
 * destroyed). `signerOf(username)` gives that person's identity public JWK (or a list of them: their current
 * key and older ones), which this function checks the signature with. Returns { from, to, at, text } or throws
 * a plain-words Error.
 */
export async function open(envelope, { me, myFingerprint, prekeyKey, signerOf }) {
  if (envelope?.v !== VERSION) throw new Error('This message uses a protocol version this page does not know.');
  const pk = await prekeyKey(envelope.spk);
  if (!pk) throw new Error('This message was sent to a key that has been destroyed (older than 30 days, or made on another device without a backup).');
  let inner;
  try {
    const key = await envelopeKey(pk, envelope.ek, { ek: envelope.ek, spk: envelope.spk, toFp: myFingerprint });
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: canon(['gitcha-dm-v2', envelope.ek.x, envelope.ek.y, envelope.spk, myFingerprint]) }, key, unb64(envelope.ct));
    inner = JSON.parse(dec.decode(unpad(new Uint8Array(plain))));
  } catch { throw new Error('This message could not be decrypted: it was changed, or it was not written for this key.'); }
  if (inner.from !== me && inner.to !== me) throw new Error('This message names neither you as sender nor as recipient.');
  const signers = [].concat((await signerOf(inner.from)) ?? []);
  if (!signers.length) throw new Error(`The sender's identity key (${inner.from}) is not known.`);
  const signed = canon(['gitcha-dm-v2-msg', inner.from, inner.to, inner.at, inner.text, envelope.ek.x, envelope.ek.y, envelope.spk, myFingerprint]);
  let signer = null;
  for (const s of signers) {
    const key = await subtle.importKey('jwk', publicPart(s), ECDSA, false, ['verify']);
    if (await subtle.verify(SIGN, key, unb64(inner.sig), signed)) { signer = await fingerprint(s); break; }
  }
  if (!signer) throw new Error(`This message's signature does not match ${inner.from}'s identity key: it may not be from them.`);
  // `signer` is the fingerprint of the key that signed it, so a device can compare it with the key it trusts.
  return { from: inner.from, to: inner.to, at: inner.at, text: inner.text, signer };
}

// ---- proving a device holds the identity key ----------------------------------------------------------------
/**
 * A device that already holds my identity key may fetch my locked backup without a fresh 2FA code (to pick up
 * a prekey another of my devices made). It proves it by signing this, for today.
 */
export async function backupProof(identityKey, username, day) {
  return b64(await subtle.sign(SIGN, identityKey, canon(['gitcha-dm-v2-backup', username, day])));
}
export async function checkBackupProof(identityPublic, username, day, proof) {
  try {
    const key = await subtle.importKey('jwk', publicPart(identityPublic), ECDSA, false, ['verify']);
    return await subtle.verify(SIGN, key, unb64(proof), canon(['gitcha-dm-v2-backup', username, day]));
  } catch { return false; }
}

// ---- backup: the keyring, locked with a passphrase ------------------------------------------------------
/**
 * A key made from a passphrase. A device keeps it to update the backup when it makes a new prekey. In a
 * browser it is not readable out (`extractable` false); the CLI, which keeps its keys in a mode-600 file the
 * way SSH does, asks for an exportable one (exportWrapKey / importWrapKey).
 */
export async function passphraseKey(passphrase, salt, iterations = ITERATIONS, extractable = false) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}
export const exportWrapKey = async (key) => b64(await subtle.exportKey('raw', key));
export const importWrapKey = (raw) => subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** Lock a keyring ({ identity: {pkcs8, publicKey}, prekeys: [...] }) with a passphrase key. */
export async function lockKeyring(keyring, wrapKey, { salt, iterations = ITERATIONS }) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, enc.encode(JSON.stringify(keyring)));
  return { v: VERSION, kdf: 'PBKDF2-SHA256', cipher: 'AES-GCM', iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function unlockKeyring(backup, wrapKey) {
  try {
    return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv) }, wrapKey, unb64(backup.data))));
  } catch { throw new Error('That passphrase does not unlock the backup.'); }
}

/** Drop prekeys older than KEEP_MS, but never the newest one. */
export function prune(prekeys, now = Date.now()) {
  const newest = prekeys.reduce((a, p) => (!a || p.createdAt > a.createdAt ? p : a), null);
  return prekeys.filter((p) => p === newest || now - p.createdAt <= KEEP_MS);
}
