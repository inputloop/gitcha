// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// One device's side of Gitcha's encrypted messages: making and unlocking keys, replacing the prekey every
// 7 days, picking up a prekey another of my devices made, fetching and opening envelopes, remembering each
// contact's key, and sending. The browser page (server/public/dm.js) and the gitcha CLI (gitcha messages)
// both use this file, so there is one implementation to read and to test. The cryptography is in
// dm-protocol.js.
//
// The two differ only in where they keep things (`storage`) and how:
//   mode "cryptokey"  the browser: keys are Web Crypto objects in IndexedDB that the page can use but not
//                     read out. To update the backup after a new prekey, it keeps the locked keyring and the
//                     passphrase key (also not readable out).
//   mode "pkcs8"      the CLI: keys are kept as PKCS#8 text in a file only you can read (mode 600), the way
//                     SSH keeps private keys.
// Messages already opened are kept on the device, because the envelopes on the server, and the prekeys
// that open them, are destroyed after 30 days.
import * as P from './dm-protocol.js';

const today = (t) => new Date(t).toISOString().slice(0, 10);

export class DmDevice {
  /**
   * me: my username. api(method, path, body): calls /api/v1/dm on the server and returns the JSON (it throws
   * an Error whose `code` is the server's error code). storage: { get(name), put(name, value) }, both async.
   */
  constructor({ me, api, storage, mode = 'cryptokey', now = () => Date.now() }) {
    Object.assign(this, { me, api, storage, mode, now });
    this.directory = new Map(); // username -> the server's view of their keys (fetched once per load)
  }

  // ---- what this device keeps -----------------------------------------------------------------------------
  async load() {
    const [keys, wrap, locked, msgs, seq, pins, read] = await Promise.all(['keys', 'wrap', 'locked', 'msgs', 'seq', 'pins', 'read'].map((n) => this.storage.get(n)));
    Object.assign(this, { keys: keys ?? null, wrap: wrap ?? null, locked: locked ?? null, msgs: msgs ?? {}, seq: seq ?? 0, pins: pins ?? {}, read: read ?? {} });
    this.loaded = true;
    return this;
  }
  /** Load what this device keeps, once, before anything reads or changes it. */
  async ensure() { if (!this.loaded) await this.load(); }
  save(...names) { return Promise.all(names.map((n) => this.storage.put(n, this[n]))); }

  /** A stored key entry as a CryptoKey: the browser stored the key itself, the CLI stored PKCS#8 text. */
  identityKey() { return this.keys.identity.key ?? P.importIdentity(this.keys.identity.pkcs8); }
  async prekeyKey(id) {
    const e = this.keys?.prekeys.find((p) => p.id === id);
    return e ? (e.key ?? P.importPrekey(e.pkcs8)) : null;
  }
  current() { return this.keys.prekeys.find((p) => p.id === this.keys.current); }
  async wrapKey() { return this.wrap.key ?? P.importWrapKey(this.wrap.raw); }

  /** Keep a keyring's keys on this device, in this device's way. */
  async keepKeyring(kr, current) {
    const asKey = (pkcs8, imp) => (this.mode === 'cryptokey' ? imp(pkcs8).then((key) => ({ key })) : { pkcs8 });
    this.keys = {
      identity: { publicKey: kr.identity.publicKey, fingerprint: await P.fingerprint(kr.identity.publicKey), ...(await asKey(kr.identity.pkcs8, P.importIdentity)) },
      prekeys: await Promise.all(P.prune(kr.prekeys, this.now()).map(async (p) => ({ id: p.id, createdAt: p.createdAt, publicKey: p.publicKey, sig: p.sig, ...(await asKey(p.pkcs8, P.importPrekey)) }))),
      current,
    };
  }

  async keepWrap(passphrase, salt, iterations) {
    const extractable = this.mode !== 'cryptokey';
    const key = await P.passphraseKey(passphrase, salt, iterations, extractable);
    this.wrap = { salt: P.b64(salt), iterations, ...(extractable ? { raw: await P.exportWrapKey(key) } : { key }) };
    return key;
  }

  // ---- where this device stands --------------------------------------------------------------------------
  /**
   * 'setup' (no key anywhere yet), 'restore' (the server has a key this device does not hold), or 'ready'.
   * When ready, it also replaces an old prekey and picks up one another device made.
   */
  async status() {
    await this.ensure();
    const server = await this.api('GET', '/me');
    this.server = server;
    if (!server.fingerprint) return { state: 'setup', server };
    if (!this.keys || this.keys.identity.fingerprint !== server.fingerprint) {
      return { state: 'restore', server, reason: this.keys ? 'changed' : server.hasBackup ? 'new-device' : 'no-backup' };
    }
    const upkeep = await this.maintain(server);
    return { state: upkeep.needsRestore ? 'restore' : 'ready', server, reason: upkeep.needsRestore ? 'other-device' : undefined };
  }

  /** Make my keys (and lock a backup with `passphrase`, if given). */
  async setup(passphrase) {
    await this.ensure();
    const id = await P.newIdentity();
    const pre = await P.newPrekey(await P.importIdentity(id.pkcs8), this.now());
    const keyring = { identity: { pkcs8: id.pkcs8, publicKey: id.publicKey }, prekeys: [pre] };
    let backup = null;
    this.wrap = null;
    if (passphrase) {
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      backup = await P.lockKeyring(keyring, await this.keepWrap(passphrase, salt, P.ITERATIONS), { salt, iterations: P.ITERATIONS });
    }
    const server = await this.api('PUT', '/identity', { identityKey: id.publicKey, prekey: publicPrekey(pre), backup });
    if (server.fingerprint !== id.fingerprint) throw new Error('The server stored a different key from the one this device made. Nothing was kept here.');
    await this.keepKeyring(keyring, pre.id);
    this.locked = backup;
    await this.save('keys', 'wrap', 'locked');
    return server;
  }

  /** Unlock my keys from the backup on the server. */
  async restore(passphrase) {
    await this.ensure();
    const { backup, fingerprint } = await this.api('GET', '/backup');
    const key = await this.keepWrap(passphrase, P.unb64(backup.salt), backup.iterations);
    const kr = await P.unlockKeyring(backup, key);
    if (await P.fingerprint(kr.identity.publicKey) !== fingerprint) throw new Error('The backup does not hold your current identity key.');
    const server = this.server ?? await this.api('GET', '/me');
    if (!kr.prekeys.some((p) => p.id === server.prekey?.id)) throw new Error('The backup does not hold your current prekey yet. Open Messages on the device that made it, then try again.');
    await this.keepKeyring(kr, server.prekey.id);
    this.locked = backup;
    await this.save('keys', 'wrap', 'locked');
  }

  /** Pick up a prekey another device made, replace mine when it is 7 days old, destroy the ones past 30 days. */
  async maintain(server) {
    const now = this.now();
    if (server.prekey && !this.keys.prekeys.some((p) => p.id === server.prekey.id)) {
      if (!this.wrap || !this.locked) return { needsRestore: true };
      const proof = await P.backupProof(await this.identityKey(), this.me, today(now));
      const { backup } = await this.api('GET', `/backup?proof=${encodeURIComponent(proof)}`);
      const kr = await P.unlockKeyring(backup, await this.wrapKey());
      await this.keepKeyring(kr, server.prekey.id);
      this.locked = backup;
      await this.save('keys', 'locked');
    }
    if (now - this.current().createdAt > P.ROTATE_MS) {
      const pre = await P.newPrekey(await this.identityKey(), now);
      let backup;
      if (this.wrap && this.locked) {
        const wk = await this.wrapKey();
        const kr = await P.unlockKeyring(this.locked, wk);
        kr.prekeys = P.prune([...kr.prekeys, pre], now);
        backup = await P.lockKeyring(kr, wk, { salt: P.unb64(this.wrap.salt), iterations: this.wrap.iterations });
      }
      await this.api('PUT', '/prekey', { prekey: publicPrekey(pre), ...(backup ? { backup } : {}) });
      this.keys.prekeys.push({ id: pre.id, createdAt: pre.createdAt, publicKey: pre.publicKey, sig: pre.sig, ...(this.mode === 'cryptokey' ? { key: await P.importPrekey(pre.pkcs8) } : { pkcs8: pre.pkcs8 }) });
      this.keys.current = pre.id;
      if (backup) this.locked = backup;
    }
    const before = this.keys.prekeys.length;
    this.keys.prekeys = P.prune(this.keys.prekeys, now).filter((p) => p.id === this.keys.current || now - p.createdAt <= P.KEEP_MS);
    await this.save('keys', 'locked');
    return { destroyed: before - this.keys.prekeys.length };
  }

  // ---- contacts ---------------------------------------------------------------------------------------------
  /** The server's view of a person's keys, checked here: the fingerprint is computed from the key itself. */
  async keysOf(username, { fresh = false } = {}) {
    if (fresh || !this.directory.has(username)) {
      const kv = await this.api('GET', `/keys/${encodeURIComponent(username)}`);
      if (kv.identityKey && await P.fingerprint(kv.identityKey) !== kv.fingerprint) throw new Error(`The server sent a key for ${username} that does not match its own fingerprint. Nothing will be sent.`);
      this.directory.set(username, kv);
    }
    return this.directory.get(username);
  }

  /**
   * A contact as this device sees them: their key, whether it matches the one remembered here ('new' the first
   * time, 'same', or 'changed'), whether their prekey is signed by it, and our safety number.
   */
  async contact(username, opts) {
    await this.ensure();
    const kv = await this.keysOf(username, opts);
    if (!kv.identityKey) return { username, ready: false };
    const pinned = this.pins[username];
    if (!pinned) { this.pins[username] = kv.fingerprint; await this.save('pins'); }
    return {
      username, ready: true, fingerprint: kv.fingerprint, keys: kv,
      pin: !pinned ? 'new' : pinned === kv.fingerprint ? 'same' : 'changed',
      prekeyOk: Boolean(kv.prekey) && await P.verifyPrekey(kv.identityKey, kv.prekey),
      safety: await P.safetyNumber(this.keys.identity.fingerprint, kv.fingerprint),
    };
  }

  /** I checked the new safety number: trust this contact's current key. */
  async acceptKey(username) {
    await this.ensure();
    const kv = await this.keysOf(username, { fresh: true });
    this.pins[username] = kv.fingerprint;
    await this.save('pins');
  }

  // ---- messages ----------------------------------------------------------------------------------------------
  /** Fetch new envelopes, open each one, and keep what it said on this device. Returns how many arrived. */
  async sync() {
    await this.ensure();
    let got = 0;
    for (;;) {
      const { envelopes, more, last } = await this.api('GET', `/box?after=${this.seq}`);
      for (const env of envelopes) {
        try {
          const m = await P.open(env, {
            me: this.me, myFingerprint: this.keys.identity.fingerprint,
            prekeyKey: (id) => this.prekeyKey(id),
            signerOf: async (u) => { const kv = await this.keysOf(u); return [kv.identityKey, ...kv.history.map((h) => h.identityKey)].filter(Boolean); },
          });
          this.msgs[env.id] = { id: env.id, with: m.from === this.me ? m.to : m.from, from: m.from, to: m.to, at: m.at, text: m.text, signer: m.signer };
        } catch (err) {
          this.msgs[env.id] = { id: env.id, failed: err.message, day: env.day };
        }
        got++;
      }
      this.seq = last;
      if (!more) break;
    }
    if (got) await this.save('msgs', 'seq');
    return got;
  }

  /** My conversations, newest first, with how many messages from them I have not opened yet. */
  conversations() {
    const by = new Map();
    for (const m of Object.values(this.msgs)) {
      if (m.failed) continue;
      const c = by.get(m.with) ?? { with: m.with, last: 0, count: 0, unread: 0 };
      c.last = Math.max(c.last, m.at);
      c.count++;
      if (m.from !== this.me && m.at > (this.read[m.with] ?? 0)) c.unread++;
      by.set(m.with, c);
    }
    return [...by.values()].sort((a, b) => b.last - a.last);
  }

  /** The messages with one person, oldest first. Each says whether it was signed by the key I trust for them. */
  thread(username) {
    const pinned = this.pins[username];
    return Object.values(this.msgs).filter((m) => !m.failed && m.with === username).sort((a, b) => a.at - b.at)
      .map((m) => ({ ...m, out: m.from === this.me, trusted: m.from === this.me || !pinned || m.signer === pinned }));
  }

  /** Messages this device could not open (destroyed keys, damage), so they are not silently lost. */
  failures() { return Object.values(this.msgs).filter((m) => m.failed); }

  async markRead(username) {
    await this.ensure();
    this.read[username] = this.now();
    await this.save('read');
  }

  /**
   * Seal and send `text` to `username`: one envelope for their inbox, one for mine. Refuses while their key is
   * unconfirmed after a change, or their prekey is not signed by their key. A prekey that changed meanwhile
   * is fetched again once.
   */
  async send(username, text, { retried = false } = {}) {
    await this.ensure();
    const c = await this.contact(username, { fresh: retried });
    if (!c.ready) throw new Error(`${username} has not set up encrypted messages yet.`);
    if (c.pin === 'changed') throw new Error(`${username}'s key changed. Check the new safety number, then confirm it, before sending.`);
    if (!c.prekeyOk) throw new Error(`${username}'s prekey is not signed by their key. Nothing was sent.`);
    const identityKey = await this.identityKey();
    const at = this.now();
    const mine = this.current();
    const envelope = await P.seal({ identityKey, from: this.me, to: username, at, text, box: { fingerprint: c.fingerprint, prekey: c.keys.prekey } });
    const copy = await P.seal({ identityKey, from: this.me, to: username, at, text, box: { fingerprint: this.keys.identity.fingerprint, prekey: { id: mine.id, publicKey: mine.publicKey } } });
    try {
      await this.api('POST', '/send', { to: username, envelope, copy });
    } catch (err) {
      if (err.code === 'key_changed' && !retried) return this.send(username, text, { retried: true });
      throw err;
    }
    await this.sync();
  }

  block(username, blocked = true) { return this.api('POST', '/block', { username, blocked }); }
}

/** A prekey without its private half: what the server is given. */
const publicPrekey = (p) => ({ id: p.id, createdAt: p.createdAt, publicKey: p.publicKey, sig: p.sig });
