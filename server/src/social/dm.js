// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Direct messages between people, encrypted end to end (protocol version 2, in extension/lib/dm-protocol.js).
// Only the two people's devices can read a message. This server stores sealed envelopes it has no key for,
// and it is built to keep as little as it can about who talks to whom:
//
// - Sealed sender. An envelope names only the inbox it sits in. Who sent it, to whom, and the exact time are
//   inside the encryption (and signed by the sender). Each message is stored twice, as two records with no
//   link between them: one in the recipient's inbox, one in the sender's own (so they can read what they
//   sent). So the database holds no "who wrote to whom". Records are numbered per inbox, never in one shared
//   order, so two records cannot be paired by their numbers. Only the day is kept, not the time.
// - Padding. Every envelope is one of a few fixed sizes, so lengths do not show.
// - Forward secrecy. Each person's "prekey" (what messages to them are encrypted to) is replaced every 7 days
//   by their device and destroyed there after 30 days. This server deletes envelopes after 30 days too
//   (GITCHA_DM_KEEP_DAYS), so nothing old is kept for anyone to try later.
//
// What the server still sees, said plainly in the README: while a message is being sent, which signed-in
// person sent it to which inbox (it must, to apply blocks and limits). It does not record that.
//
// Stored: store.data.dmId (each person's identity key, history, current prekey, locked backup), dmBox (the
// envelopes), dmSeq (each inbox's counter), dmBlocks and dmDaily.
import { HttpError } from '../errors.js';
import { sha256, randomToken } from '../crypto.js';
import { verifyPrekey, checkBackupProof, VERSION } from '../../../extension/lib/dm-protocol.js';

const B64URL = /^[A-Za-z0-9_-]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CT = 87_500;          // base64 characters of the largest envelope (64 KB padded, plus the GCM tag)
const MAX_BACKUP = 400_000;     // base64 characters of a locked keyring
const DAILY_SENDS = 300;        // messages one person may send in a UTC day
const PAGE = 500;               // envelopes in one fetch
const MIN_ITERATIONS = 200_000; // PBKDF2 rounds a backup must say it used
const DAY = 86_400_000;

/** Check a public key in JWK form: a P-256 key with only its public parts. */
export function checkPublicKey(jwk, what = 'key') {
  const ok = jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && jwk.x.length === 43 && jwk.y.length === 43
    && B64URL.test(jwk.x) && B64URL.test(jwk.y) && jwk.d === undefined;
  if (!ok) throw new HttpError(400, 'bad_key', `The ${what} must be a P-256 public key in JWK form, with no private part.`);
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** A key's fingerprint: SHA-256 of "P-256:x:y". The devices compute the same, and show it to people. */
export const fingerprintOf = (jwk) => sha256(`P-256:${jwk.x}:${jwk.y}`);

export class DmService {
  constructor({ store, clock = Date.now, keepDays = 30 }) {
    Object.assign(this, { store, clock, keepMs: keepDays * DAY });
    for (const k of ['dmId', 'dmBox', 'dmSeq', 'dmBlocks', 'dmDaily']) store.data[k] ??= {};
  }

  get d() { return this.store.data; }
  day(t = this.clock()) { return new Date(t).toISOString().slice(0, 10); }

  /** An active person by username, or 404. */
  person(username) {
    const u = this.store.userByName(String(username ?? ''));
    if (!u || u.status !== 'active') throw new HttpError(404, 'not_found', 'No such person.');
    return u;
  }

  rec(u) { return Object.hasOwn(this.d.dmId, u.id) ? this.d.dmId[u.id] : null; }

  /** What anyone signed in may know about a person's keys: identity key, its history, and the current prekey. */
  keyView(u) {
    const k = this.rec(u);
    if (!k) return { username: u.username, identityKey: null, fingerprint: null, prekey: null, history: [] };
    return { username: u.username, identityKey: k.identityKey, fingerprint: k.fingerprint, setAt: k.setAt, prekey: k.prekey,
      history: k.history.map(({ fingerprint, identityKey, at }) => ({ fingerprint, identityKey, at })) };
  }

  /** My own record: my keys, and whether a locked backup is stored (and how it was locked, without the data). */
  me(user) {
    const k = this.rec(user);
    return { ...this.keyView(user), hasBackup: Boolean(k?.backup), backupSalt: k?.backup?.salt ?? null, backupIterations: k?.backup?.iterations ?? null };
  }

  /** Check a prekey (public part, id, time, signature) and that the identity key signed it. */
  async checkPrekey(identityKey, p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[0-9a-f]{24}$/.test(p.id) || !Number.isFinite(p.createdAt)
      || typeof p.sig !== 'string' || !B64.test(p.sig) || p.sig.length > 200) throw new HttpError(400, 'bad_prekey', 'A prekey needs an id, a time, a public key and a signature.');
    const pre = { id: p.id, createdAt: p.createdAt, publicKey: checkPublicKey(p.publicKey, 'prekey'), sig: p.sig };
    if (!(await verifyPrekey(identityKey, pre))) throw new HttpError(400, 'bad_prekey', 'The prekey is not signed by this identity key.');
    if (Math.abs(pre.createdAt - this.clock()) > DAY) throw new HttpError(400, 'bad_prekey', 'The prekey\'s time is more than a day from now.');
    return pre;
  }

  /**
   * Set (or replace) my identity key, with its first prekey and my optional locked backup. A replaced key
   * stays in the history, so other people's devices can say that it changed.
   */
  async setIdentity(user, { identityKey, prekey, backup }, ip) {
    const jwk = checkPublicKey(identityKey, 'identity key');
    const fp = fingerprintOf(jwk);
    const pre = await this.checkPrekey(jwk, prekey);
    const locked = backup === undefined || backup === null ? null : checkBackup(backup);
    const now = this.clock();
    this.store.tx((d) => {
      const old = d.dmId[user.id];
      const history = (old?.history ?? []).filter((h) => h.fingerprint !== fp);
      history.push({ fingerprint: fp, identityKey: jwk, at: now });
      d.dmId[user.id] = { identityKey: jwk, fingerprint: fp, setAt: now, history: history.slice(-20), prekey: pre, backup: locked };
      this.store.audit({ userId: user.id, event: old ? 'dm.key_replaced' : 'dm.key_set', ip, fingerprint: fp.slice(0, 16) });
    });
    return this.me(user);
  }

  /**
   * Publish a new prekey (devices do this every 7 days), with the updated locked backup. Updating the backup
   * here must keep the same salt and rounds, so a stolen session cannot swap in a backup of its own choosing
   * (changing the passphrase is setIdentity's job, which needs a fresh code).
   */
  async rotatePrekey(user, { prekey, backup }) {
    const k = this.rec(user);
    if (!k) throw new HttpError(409, 'no_key', 'Set up your messaging key first.');
    const pre = await this.checkPrekey(k.identityKey, prekey);
    let locked = k.backup;
    if (backup !== undefined && backup !== null) {
      locked = checkBackup(backup);
      if (k.backup && (locked.salt !== k.backup.salt || locked.iterations !== k.backup.iterations)) throw new HttpError(400, 'bad_backup', 'A rotated backup must be locked with the same passphrase settings.');
    }
    this.store.tx((d) => { Object.assign(d.dmId[user.id], { prekey: pre, backup: locked }); });
    return this.me(user);
  }

  /**
   * May this request have my backup without a fresh code? Only if it proves, by a signature over today's date,
   * that it comes from a device that already holds my identity key (to pick up another device's new prekey).
   */
  async provesIdentity(user, proof) {
    const k = this.rec(user);
    if (!k || typeof proof !== 'string' || proof.length > 200) return false;
    return checkBackupProof(k.identityKey, user.username, this.day(), proof);
  }

  /** My locked backup, or 404. It is useless without the passphrase, but it is still only given to me. */
  backup(user) {
    const b = this.rec(user)?.backup;
    if (!b) throw new HttpError(404, 'no_backup', 'No backup of your messaging keys is stored.');
    return { backup: b, fingerprint: this.rec(user).fingerprint };
  }

  blocked(by, who) { return Boolean(this.d.dmBlocks[by.id]?.[who.id]); }

  setBlock(user, username, blocked, ip) {
    const other = this.person(username);
    if (other.id === user.id) throw new HttpError(400, 'bad_request', 'You cannot block yourself.');
    this.store.tx((d) => {
      d.dmBlocks[user.id] ??= {};
      if (blocked) d.dmBlocks[user.id][other.id] = this.clock(); else delete d.dmBlocks[user.id][other.id];
      this.store.audit({ userId: user.id, event: blocked ? 'dm.blocked' : 'dm.unblocked', ip, name: other.username });
    });
    return { username: other.username, blocked: Boolean(blocked) };
  }

  /** People I have blocked (names only, for my own page). */
  blockedBy(user) {
    return Object.keys(this.d.dmBlocks[user.id] ?? {}).map((id) => this.store.userById(id)?.username).filter(Boolean);
  }

  /** Check one envelope's shape: version, one-time key, prekey id, IV and ciphertext size. Nothing inside it. */
  checkEnvelope(e, prekeyId, who) {
    if (!e || typeof e !== 'object' || e.v !== VERSION) throw new HttpError(400, 'bad_message', `Each envelope must be protocol version ${VERSION}.`);
    const ek = checkPublicKey(e.ek, 'one-time key');
    if (e.spk !== prekeyId) throw new HttpError(409, 'key_changed', `${who}'s prekey changed since this page loaded. Fetch it again and resend.`);
    if (typeof e.iv !== 'string' || e.iv.length !== 16 || !B64.test(e.iv)) throw new HttpError(400, 'bad_message', 'An envelope must carry a 12-byte IV in base64.');
    if (typeof e.ct !== 'string' || !e.ct || e.ct.length > MAX_CT || !B64.test(e.ct)) throw new HttpError(400, 'bad_message', 'An envelope\'s ciphertext is missing or too long.');
    return { v: VERSION, ek, spk: e.spk, iv: e.iv, ct: e.ct };
  }

  /**
   * Store one message: `envelope` for the recipient's inbox, `copy` for my own. Who sent it is known here only
   * for this call (to apply blocks and the daily limit) and is not stored with either record.
   */
  send(user, { to, envelope, copy }) {
    const other = this.person(to);
    if (other.id === user.id) throw new HttpError(400, 'bad_request', 'Write to someone else.');
    const mine = this.rec(user), theirs = this.rec(other);
    if (!mine) throw new HttpError(409, 'no_key', 'Set up your messaging key first.');
    if (!theirs) throw new HttpError(409, 'no_key', `${other.username} has not set up encrypted messages yet.`);
    const inbox = this.checkEnvelope(envelope, theirs.prekey.id, other.username);
    const outbox = this.checkEnvelope(copy, mine.prekey.id, 'Your');
    if (this.blocked(other, user)) throw new HttpError(403, 'blocked', `${other.username} does not take messages from you.`);
    const day = this.day();
    const sent = this.d.dmDaily[user.id]?.day === day ? this.d.dmDaily[user.id].count : 0;
    if (sent >= DAILY_SENDS) throw new HttpError(429, 'dm_limit', `You have sent ${sent} messages today; the limit is ${DAILY_SENDS}.`);
    // The two records are written in a random order, so not even their place in the file pairs them.
    const records = [[other.id, inbox], [user.id, outbox]].sort(() => (crypto.getRandomValues(new Uint8Array(1))[0] & 1) - 0.5);
    this.store.tx((d) => {
      for (const [owner, env] of records) {
        const seq = (d.dmSeq[owner] ?? 0) + 1;
        d.dmSeq[owner] = seq;
        const id = randomToken('dm_').slice(0, 28);
        d.dmBox[id] = { id, owner, day, seq, ...env };
      }
      d.dmDaily[user.id] = { day, count: sent + 1 };
    });
    return { sent: true, day };
  }

  /** My envelopes after `after` (my inbox's own counter), oldest first, at most PAGE. */
  box(user, { after = 0 } = {}) {
    const from = Number(after) || 0;
    const mine = Object.values(this.d.dmBox).filter((r) => r.owner === user.id && r.seq > from).sort((a, b) => a.seq - b.seq);
    const page = mine.slice(0, PAGE);
    return { envelopes: page.map(({ owner, ...r }) => r), more: mine.length > page.length, last: page.at(-1)?.seq ?? from };
  }

  /** Delete envelopes older than the keep time (30 days). Devices destroy the prekeys they were sealed to then too. */
  sweep() {
    const cutoff = this.day(this.clock() - this.keepMs);
    const old = Object.values(this.d.dmBox).filter((r) => r.day < cutoff).map((r) => r.id);
    if (old.length) this.store.tx((d) => { for (const id of old) delete d.dmBox[id]; });
    return old.length;
  }
}

/** Check a locked keyring backup: the device's own description of how it locked it. */
function checkBackup(b) {
  const ok = b && typeof b === 'object' && b.v === VERSION && b.kdf === 'PBKDF2-SHA256' && b.cipher === 'AES-GCM'
    && Number.isInteger(b.iterations) && b.iterations >= MIN_ITERATIONS && b.iterations <= 10_000_000
    && typeof b.salt === 'string' && B64.test(b.salt) && b.salt.length >= 22 && b.salt.length <= 44
    && typeof b.iv === 'string' && B64.test(b.iv) && b.iv.length === 16
    && typeof b.data === 'string' && B64.test(b.data) && b.data.length <= MAX_BACKUP;
  if (!ok) throw new HttpError(400, 'bad_backup', `A key backup must say how it was locked (PBKDF2-SHA256 with at least ${MIN_ITERATIONS} rounds, AES-GCM) and carry the locked keys.`);
  return { v: VERSION, kdf: 'PBKDF2-SHA256', cipher: 'AES-GCM', iterations: b.iterations, salt: b.salt, iv: b.iv, data: b.data };
}
