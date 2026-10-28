import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUrl } from '../src/totp.js';

// RFC 4226 Appendix D: secret "12345678901234567890"
const RFC_SECRET = Buffer.from('12345678901234567890');

test('HOTP matches RFC 4226 test vectors', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code));
});

test('TOTP matches RFC 6238 SHA-1 vectors (6-digit truncation)', () => {
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
  for (const [t, code] of vectors) assert.equal(totp(RFC_SECRET, { now: t * 1000 }), code);
});

test('base32 round-trips', () => {
  const b = base32Encode(RFC_SECRET);
  assert.equal(b, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(b), RFC_SECRET);
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'), RFC_SECRET);
});

test('verifyTotp accepts ±1 step and rejects replays', () => {
  const secret = base32Encode(RFC_SECRET);
  const now = 1_700_000_000_000;
  const code = totp(secret, { now });
  const step = verifyTotp(secret, code, { now });
  assert.ok(step);
  assert.equal(verifyTotp(secret, code, { now: now + 30_000 }), step, 'previous step still valid');
  assert.equal(verifyTotp(secret, code, { now, lastStep: step }), null, 'same code cannot be used twice');
  assert.equal(verifyTotp(secret, code, { now: now + 120_000 }), null, 'old code expires');
  assert.equal(verifyTotp(secret, 'abcdef', { now }), null);
  assert.equal(verifyTotp(secret, '12345', { now }), null);
});

test('otpauth URL is Google Authenticator compatible', () => {
  const url = otpauthUrl({ secret: 'ABC', account: 'alice', issuer: 'Gitcha' });
  assert.match(url, /^otpauth:\/\/totp\/Gitcha%3Aalice\?secret=ABC&issuer=Gitcha/);
});
