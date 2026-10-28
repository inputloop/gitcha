// RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation, compatible with
// Google Authenticator, Authy, 1Password, Aegis, FreeOTP, etc.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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

export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function hotp(secret, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs = Date.now(), period = 30) {
  return Math.floor(nowMs / 1000 / period);
}

export function totp(secret, { now = Date.now(), period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  return hotp(secret, timeStep(now, period), { digits, algorithm });
}

/**
 * Verify a TOTP code. Returns the matched time step (so the caller can store
 * it and reject replays), or null. `lastStep` is the last step accepted for
 * this user; any code at or before it is rejected as a replay.
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

export function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params}`;
}
