// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// One-time codes for two-factor login. HOTP (RFC 4226) makes a code from a secret and a counter.
// TOTP (RFC 6238) uses the current 30-second time slot as the counter, which gives the 6-digit codes an
// authenticator app shows. Works with Google Authenticator, Authy, 1Password, Aegis, FreeOTP and others.
import crypto from 'node:crypto';

// The base32 alphabet. Authenticator apps expect the secret in base32 (bytes written with these 32 characters).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Write bytes as base32 text, 5 bits per character, with no '=' padding. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Read base32 text back into bytes. Spaces, '=' and '-' are ignored; any other unknown character throws. */
export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random TOTP secret (20 bytes by default), as base32 text. */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * The HOTP code for a counter: HMAC the counter with the secret, then pick 4 bytes from a spot the last
 * byte chooses ("dynamic truncation" in the RFC), and keep the last `digits` digits.
 */
export function hotp(secret, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The number of the current time slot: how many `period`-second slots have passed since 1970. */
export function timeStep(nowMs = Date.now(), period = 30) {
  return Math.floor(nowMs / 1000 / period);
}

/** The TOTP code for a moment in time (now by default). */
export function totp(secret, { now = Date.now(), period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  return hotp(secret, timeStep(now, period), { digits, algorithm });
}

/**
 * Check a 6-digit TOTP code. It may match the current time slot or one `window` slot before or after,
 * which allows for a phone clock that is a little off. Returns the matched time step, so the caller can
 * store it and reject replays (the same code used twice), or null. `lastStep` is the last step accepted
 * for this user; any code at or before it is rejected as a replay.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1, period = 30, lastStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  code = code.trim();
  const current = timeStep(now, period);
  for (let i = -window; i <= window; i++) {
    const step = current + i;
    if (step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

/** The otpauth:// link an authenticator app reads (usually from a QR code) to add this account. */
export function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params}`;
}
