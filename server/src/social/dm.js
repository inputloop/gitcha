// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Direct messages between people, encrypted end to end. "End to end" means only the two people's browsers
// can read a message: the server stores and passes on ciphertext (scrambled bytes) it has no key for.
//
// How it works (the browser side is server/public/dm.js):
// - Each person's browser makes a key pair (ECDH on the P-256 curve) the first time they open Messages. The
//   private key stays in that browser. Only the public key comes here, with its fingerprint (a SHA-256 of it).
// - To write to someone, the browser combines its private key with the other person's public key. Both sides
//   get the same secret that way, and nobody else can. From it comes an AES-256-GCM key that encrypts the text.
// - A person may store a backup of their private key here, locked with a passphrase in their browser first
//   (PBKDF2, then AES-GCM). The server keeps the locked blob and never sees the passphrase.
//
// What the server can see, and the README says so: who wrote to whom, when, and how long each message is.
// What it cannot: the words. It also checks what it can without the key: sizes, that a message names the
// keys both people have now, daily limits, and blocks.
//
// Stored in store.data.dmKeys (one record per person: the public key, its history, the optional backup),
// store.data.dms (the messages), store.data.dmBlocks and store.data.dmDaily.
import { HttpError } from '../errors.js';
import { sha256, randomToken } from '../crypto.js';

const B64URL = /^[A-Za-z0-9_-]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CT = 48_000;          // base64 characters of one message's ciphertext (about 8,000 characters of text)
const MAX_BACKUP = 8_000;       // base64 characters of a locked private key
const DAILY_SENDS = 300;        // messages one person may send in a UTC day
const PAGE = 100;               // messages in one conversation page
const MIN_ITERATIONS = 200_000; // PBKDF2 rounds a backup must say it used

/** Check a public key in JWK form (JSON Web Key): an ECDH P-256 key with only its public parts. */
export function checkPublicKey(jwk) {
  const ok = jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && jwk.x.length === 43 && jwk.y.length === 43
    && B64URL.test(jwk.x) && B64URL.test(jwk.y) && jwk.d === undefined;
  if (!ok) throw new HttpError(400, 'bad_key', 'The public key must be an ECDH P-256 key in JWK form, with no private part.');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** A key's fingerprint: SHA-256 of "P-256:x:y". The browser computes the same, and shows it to people. */
export const fingerprintOf = (jwk) => sha256(`P-256:${jwk.x}:${jwk.y}`);

export class DmService {
  constructor({ store, clock = Date.now }) {
    Object.assign(this, { store, clock });
    store.data.dmKeys ??= {};
    store.data.dms ??= {};
    store.data.dmBlocks ??= {};
    store.data.dmDaily ??= {};
  }

  get d() { return this.store.data; }

  /** An active person by username, or 404. */
  person(username) {
    const u = this.store.userByName(String(username ?? ''));
    if (!u || u.status !== 'active') throw new HttpError(404, 'not_found', 'No such person.');
    return u;
  }

  /** What anyone may know about a person's key: the public key, its fingerprint, and when it changed. */
  keyView(u) {
    const k = Object.hasOwn(this.d.dmKeys, u.id) ? this.d.dmKeys[u.id] : null;
    if (!k) return { username: u.username, publicKey: null, fingerprint: null, history: [] };
    return { username: u.username, publicKey: k.publicKey, fingerprint: k.fingerprint, setAt: k.setAt, history: k.history.map(({ fingerprint, publicKey, at }) => ({ fingerprint, publicKey, at })) };
  }

  /** My own record: my key, and whether a locked backup is stored. */
  me(user) {
    const k = this.d.dmKeys[user.id];
    return { ...this.keyView(user), hasBackup: Boolean(k?.backup) };
  }

  /**
   * Set (or replace) my public key, and my locked backup if I send one. Replacing a key means messages
   * sent to the old one can only be read with the old private key, so the old public key stays in the
   * history (people's browsers use it to tell that a key changed, and to read older messages).
   */
  setKey(user, { publicKey, backup }, ip) {
    const jwk = checkPublicKey(publicKey);
    const fp = fingerprintOf(jwk);
    const locked = backup === undefined || backup === null ? null : checkBackup(backup);
    const now = this.clock();
    this.store.tx((d) => {
      const old = d.dmKeys[user.id];
      const history = (old?.history ?? []).filter((h) => h.fingerprint !== fp);
      history.push({ fingerprint: fp, publicKey: jwk, at: now });
      d.dmKeys[user.id] = { publicKey: jwk, fingerprint: fp, setAt: now, history: history.slice(-20), backup: locked ?? (old?.fingerprint === fp ? old.backup : null) };
      this.store.audit({ userId: user.id, event: old ? 'dm.key_replaced' : 'dm.key_set', ip, fingerprint: fp.slice(0, 16) });
    });
    return this.me(user);
  }

  /** My locked backup, or 404. It is useless without the passphrase, but it is still only given to me. */
  backup(user) {
    const b = this.d.dmKeys[user.id]?.backup;
    if (!b) throw new HttpError(404, 'no_backup', 'No backup of your messaging key is stored.');
    return { backup: b, fingerprint: this.d.dmKeys[user.id].fingerprint };
  }

  /** Is `a` blocked by `b`? */
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

  /**
   * Store one encrypted message. The sender's browser says which two keys it used (fromKey, toKey); both
   * must be the keys the two people have now, so nobody writes to a key that was replaced. The server cannot
   * read `ct`; it checks its size and shape only.
   */
  send(user, { to, iv, ct, fromKey, toKey }) {
    const other = this.person(to);
    if (other.id === user.id) throw new HttpError(400, 'bad_request', 'Write to someone else.');
    const mine = this.d.dmKeys[user.id], theirs = this.d.dmKeys[other.id];
    if (!mine) throw new HttpError(409, 'no_key', 'Set up your messaging key first.');
    if (!theirs) throw new HttpError(409, 'no_key', `${other.username} has not set up encrypted messages yet.`);
    if (fromKey !== mine.fingerprint || toKey !== theirs.fingerprint) throw new HttpError(409, 'key_changed', 'A key changed since this page loaded. Reload, check the safety number, and send again.');
    if (typeof iv !== 'string' || iv.length !== 16 || !B64.test(iv)) throw new HttpError(400, 'bad_message', 'The message must carry a 12-byte IV in base64.');
    if (typeof ct !== 'string' || !ct || ct.length > MAX_CT || !B64.test(ct)) throw new HttpError(400, 'bad_message', `The encrypted message is missing or too long (at most ${MAX_CT} base64 characters).`);
    if (this.blocked(other, user)) throw new HttpError(403, 'blocked', `${other.username} does not take messages from you.`);
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const sent = this.d.dmDaily[user.id]?.day === day ? this.d.dmDaily[user.id].count : 0;
    if (sent >= DAILY_SENDS) throw new HttpError(429, 'dm_limit', `You have sent ${sent} messages today; the limit is ${DAILY_SENDS}.`);
    const id = randomToken('dm_').slice(0, 28);
    const msg = { id, from: user.id, to: other.id, at: this.clock(), iv, ct, fromKey, toKey, readAt: null };
    this.store.tx((d) => {
      d.dms[id] = msg;
      d.dmDaily[user.id] = { day, count: sent + 1 };
    });
    return this.view(msg);
  }

  /** The API shape of a message: names instead of ids. */
  view(m) {
    const name = (id) => this.store.userById(id)?.username ?? '(gone)';
    return { id: m.id, from: name(m.from), to: name(m.to), at: m.at, iv: m.iv, ct: m.ct, fromKey: m.fromKey, toKey: m.toKey, readAt: m.readAt };
  }

  /** My conversations, newest first: who with, the last message's time, and how many I have not read. */
  conversations(user) {
    const by = new Map();
    for (const m of Object.values(this.d.dms)) {
      if (m.from !== user.id && m.to !== user.id) continue;
      const other = m.from === user.id ? m.to : m.from;
      const c = by.get(other) ?? { last: 0, unread: 0, count: 0 };
      c.last = Math.max(c.last, m.at);
      c.count++;
      if (m.to === user.id && !m.readAt) c.unread++;
      by.set(other, c);
    }
    return [...by.entries()].map(([id, c]) => {
      const u = this.store.userById(id);
      return { with: u?.username ?? '(gone)', last: c.last, unread: c.unread, messages: c.count, blocked: u ? this.blocked(user, u) : false };
    }).sort((a, b) => b.last - a.last);
  }

  /**
   * The messages between me and one person, newest `PAGE` before `before` (a time), oldest first.
   * Messages to me are marked read.
   */
  thread(user, username, { before } = {}) {
    const other = this.person(username);
    const all = Object.values(this.d.dms)
      .filter((m) => (m.from === user.id && m.to === other.id) || (m.from === other.id && m.to === user.id))
      .filter((m) => !before || m.at < Number(before))
      .sort((a, b) => a.at - b.at);
    const page = all.slice(-PAGE);
    const unread = page.filter((m) => m.to === user.id && !m.readAt).map((m) => m.id);
    if (unread.length) this.store.tx((d) => { const now = this.clock(); for (const id of unread) d.dms[id].readAt = now; });
    return { with: this.keyView(other), me: this.keyView(user), blocked: this.blocked(user, other), more: all.length > page.length, messages: page.map((m) => this.view(this.d.dms[m.id])) };
  }
}

/** Check a locked private-key backup: the browser's own description of how it locked the key. */
function checkBackup(b) {
  const ok = b && typeof b === 'object' && b.v === 1 && b.kdf === 'PBKDF2-SHA256' && b.cipher === 'AES-GCM'
    && Number.isInteger(b.iterations) && b.iterations >= MIN_ITERATIONS && b.iterations <= 10_000_000
    && typeof b.salt === 'string' && B64.test(b.salt) && b.salt.length >= 22 && b.salt.length <= 44
    && typeof b.iv === 'string' && B64.test(b.iv) && b.iv.length === 16
    && typeof b.data === 'string' && B64.test(b.data) && b.data.length <= MAX_BACKUP;
  if (!ok) throw new HttpError(400, 'bad_backup', `A key backup must say how it was locked (PBKDF2-SHA256 with at least ${MIN_ITERATIONS} rounds, AES-GCM) and carry the locked key.`);
  return { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-GCM', iterations: b.iterations, salt: b.salt, iv: b.iv, data: b.data };
}
