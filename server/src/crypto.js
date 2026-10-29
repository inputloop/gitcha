// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Small building blocks for security, used mostly by auth.js: password hashing, random tokens,
// hashes, keyed hashes (HMAC), timing-safe compares, a box that encrypts secrets, and recovery codes.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

// scrypt settings. scrypt is a password hash made to be slow and use lots of memory, so guessing
// passwords from a stolen hash costs an attacker a lot. N is the work factor; maxmem is 64 MB.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hash a password with a fresh random salt (random bytes mixed in, so two equal passwords get different
 * hashes). The result holds the scheme, its settings, the salt and the hash, separated by '$'.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Check a password against a stored hash, using the settings saved with that hash. The compare takes
 * the same time whatever the answer, so timing gives nothing away.
 */
export function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

/** The same check, run on a background thread, so a sign-in does not freeze the server while scrypt runs. */
export async function verifyPasswordAsync(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

// A hash of a random password nobody knows. Login checks against it when the username is unknown, so a
// wrong username takes as long as a wrong password and timing does not reveal which names exist.
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** A random token: 32 random bytes as base64url text, after an optional prefix that tells token kinds apart. */
export function randomToken(prefix = '') {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

/** The SHA-256 hash (a fixed-length fingerprint of the data) as hex text. */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Make a key for one purpose from the server key, using HMAC (a hash mixed with a secret key). A leak of
 * one purpose's output tells nothing about another's.
 */
export function deriveKey(keyB64, purpose) {
  return crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update(`gitcha:${purpose}`).digest();
}

/** HMAC-SHA256 of `data` under `key`, as base64url text. */
export function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

/** Compare two strings in a time that does not depend on where they first differ, so timing leaks nothing. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * A box that encrypts secrets at rest (stored on disk), such as TOTP secrets, with AES-256-GCM. GCM also
 * adds a tag, so a sealed value that was changed fails to open instead of giving wrong data.
 * seal() returns "v1.<iv>.<tag>.<ciphertext>"; each seal uses a new random 12-byte iv (starting value).
 */
export function createSecretBox(keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('secret key must be 32 bytes (base64)');
  return {
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
    },
    open(sealed) {
      const [v, iv, tag, ct] = String(sealed).split('.');
      if (v !== 'v1') throw new Error('unknown secret box version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

/** Make `n` one-time recovery codes, for when the authenticator app is lost. */
export function generateRecoveryCodes(n = 10) {
  // 80 bits each (AUTH-12): four groups of five hex digits. Codes of the old 40-bit shape are still accepted until
  // their owner makes new ones.
  return Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(10).toString('hex');
    return [0, 5, 10, 15].map((k) => raw.slice(k, k + 5)).join('-');
  });
}

/**
 * Turn a typed recovery code into its standard dashed form: lower case, spaces and dashes ignored. Accepts
 * the old 10-digit and the new 20-digit shape. Returns null when it is not a recovery code.
 */
export function normalizeRecoveryCode(input) {
  const bare = String(input ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (/^[a-f0-9]{10}$/.test(bare)) return `${bare.slice(0, 5)}-${bare.slice(5)}`;
  if (/^[a-f0-9]{20}$/.test(bare)) return [0, 5, 10, 15].map((k) => bare.slice(k, k + 5)).join('-');
  return null;
}
