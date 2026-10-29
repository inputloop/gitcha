// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Keys other than passwords.
//
//   console keys   for a person's scripts and terminal. Each one is a session of
//                  kind "console", so the 2FA rules (two-factor: a code from an
//                  authenticator app) apply to it as to any device. Making one
//                  needs a fresh 2FA code. A new key keeps the code time of the
//                  session that made it, never a fresh one. Only a login or a
//                  typed code opens a window, so a chain of keys cannot keep a
//                  window open.
//   agent keys     ("agentic API keys") exist only to let a registered agent use
//                  the paid sandboxes (runners). They open no other door: the
//                  caller of `principals.fromToken` names the purpose it serves.
//                  They are never issued for anything else: agents contribute for
//                  free over git, the extension or MCP. They expire after 90 days,
//                  can be listed, and can be revoked one at a time or all at once.
//   SSH keys       git over SSH, for a person or one of their agents.
//   GPG keys       to check commit signatures, for a person or one of their agents.
//
// For agent keys Gitcha stores only a SHA-256 hash, never the key itself.
// Everything lives in store.data.keys ({ ssh, gpg, agent }).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../errors.js';
import { randomToken, sha256 } from '../crypto.js';

const AGENT_KEY_TTL = 90 * 86_400_000; // 90 days
/** The public name of an agent key: the first 12 characters of the hash Gitcha keeps. It names the key, but nobody can sign in with it. */
const keyId = (hash) => hash.slice(0, 12);

// The SSH key types we accept (DSA keys are not among them).
const SSH_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa']);

/** Reads and checks an OpenSSH public key line. Returns { type, blob, comment, fingerprint }. Refuses RSA keys under 2048 bits. */
export function parseSshKey(line) {
  const parts = String(line ?? '').trim().split(/\s+/);
  const [type, b64, ...rest] = parts;
  if (!SSH_TYPES.has(type) || !b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new HttpError(400, 'bad_ssh_key', 'That is not an OpenSSH public key (ssh-ed25519, ecdsa or rsa).');
  const blob = Buffer.from(b64, 'base64');
  // The blob (the decoded key data) starts with its own type name. It must match the type written before it.
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  if (len <= 0 || len > 64 || blob.subarray(4, 4 + len).toString() !== type) throw new HttpError(400, 'bad_ssh_key', 'The key data does not match its type.');
  if (type === 'ssh-rsa') {
    // After the type, an RSA blob holds e and then n (the modulus). Refuse keys whose n is under 2048 bits.
    let off = 4 + len;
    const eLen = blob.readUInt32BE(off); off += 4 + eLen;
    const nLen = blob.readUInt32BE(off);
    let n = blob.subarray(off + 4, off + 4 + nLen);
    while (n.length && n[0] === 0) n = n.subarray(1);
    if (n.length * 8 < 2048) throw new HttpError(400, 'weak_ssh_key', 'RSA keys must be at least 2048 bits; ssh-ed25519 is preferred.');
  }
  // The fingerprint is the SHA-256 of the key data in base64 without "=" padding, the way OpenSSH shows it.
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { type, blob: b64, comment: rest.join(' ').slice(0, 100), fingerprint };
}

/**
 * Reads the fingerprint and user ids of an armored (text) public key by running gpg with a
 * throwaway keyring folder, which is deleted after. Refuses private keys. If gpg is not
 * installed, the key is still accepted but marked `checked: false`.
 */
export function inspectGpgKey(armored) {
  const text = String(armored ?? '');
  if (!/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+-----END PGP PUBLIC KEY BLOCK-----/.test(text)) throw new HttpError(400, 'bad_gpg_key', 'Paste an ASCII-armored PGP public key block.');
  if (/PRIVATE KEY/.test(text)) throw new HttpError(400, 'bad_gpg_key', 'That is a private key. Never paste it anywhere; send the public key.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-gpg-'));
  try {
    // "show-only" makes gpg list the key without really importing it. It gets 10 seconds.
    const out = execFileSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--import-options', 'show-only', '--import'], { input: text, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'] });
    const fprs = out.split('\n').filter((l) => l.startsWith('fpr:')).map((l) => l.split(':')[9]);
    const uids = out.split('\n').filter((l) => l.startsWith('uid:')).map((l) => l.split(':')[9]).slice(0, 10);
    if (!fprs.length) throw new HttpError(400, 'bad_gpg_key', 'gpg found no key in that block.');
    return { fingerprint: fprs[0], subkeys: fprs.slice(1), uids, checked: true };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // ENOENT: there is no gpg program on this server.
    if (err.code === 'ENOENT') return { fingerprint: null, subkeys: [], uids: [], checked: false };
    throw new HttpError(400, 'bad_gpg_key', 'gpg could not read that key.');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Adds, lists, checks and removes every kind of key that is not a password. */
export class KeyService {
  constructor({ store, auth, billing, budgets, clock = Date.now }) {
    Object.assign(this, { store, auth, billing, budgets, clock });
    store.data.keys ??= { ssh: {}, gpg: {}, agent: {} };
  }

  get data() { return this.store.data.keys; }

  /** Who a key is for: the user, or one of the user's own agents (agents.mine throws for anyone else's). */
  holder(user, agentHandle, agents) {
    if (!agentHandle) return { kind: 'user', id: user.id, name: user.username };
    const a = agents.mine(user, agentHandle);
    return { kind: 'agent', id: a.handle, name: a.handle };
  }

  // ---- console keys --------------------------------------------------------------------
  /**
   * Makes a console key. `mfaAt` is the time the asking session last typed a 2FA code.
   * The new key gets that time, not "now" (createSession marks it as a fresh login).
   * So making a key never renews the sensitive window or the 12-hour check. With no
   * parent time, the key gets 0: no window at all.
   */
  createConsoleKey(user, { name }, ip, { mfaAt } = {}) {
    const { token, session } = this.auth.createSession(user, { kind: 'console', name: `console: ${String(name ?? 'key').slice(0, 60)}`, ip, userAgent: 'console key' });
    this.store.tx((d) => { d.sessions[sha256(token)].mfaAt = Number.isFinite(mfaAt) ? mfaAt : 0; });
    return { token, name: session.name, createdAt: session.createdAt };
  }

  // ---- agent keys ----------------------------------------------------------------------------
  /**
   * Makes an agent key, only for paid sandbox use. The owner must be on a paid plan, or the
   * agent must have credits. The secret is returned once; only its hash is stored.
   */
  createAgentKey(user, agent, { purpose }, ip) {
    if (purpose !== 'sandbox') {
      throw new HttpError(400, 'agent_keys_are_for_sandboxes', 'Agent keys are issued only to use the paid sandboxes. To contribute, use git, the extension or MCP; for scripts, use a console key.');
    }
    const paid = this.billing.enabled && this.billing.plans[this.billing.planFor(`user:${user.username}`)]?.paid;
    const budget = this.budgets.balance(`agent:${agent.handle}`);
    if (!paid && budget <= 0) {
      throw new HttpError(402, 'sandbox_not_paid', `Sandbox keys need a paid plan or a positive budget; ${agent.handle} has ${budget} credits. Budgets grow with reviews and accepted findings.`);
    }
    const token = randomToken('gak_');
    const hash = sha256(token);
    const createdAt = this.clock();
    this.store.tx((d) => {
      d.keys.agent[hash] = { agent: agent.handle, owner: user.id, createdAt, expiresAt: createdAt + AGENT_KEY_TTL, purpose: 'sandbox' };
      this.store.audit({ userId: user.id, event: 'agent_key.created', ip, agent: agent.handle, key: keyId(hash) });
    });
    return { token, agent: agent.handle, purpose: 'sandbox', id: keyId(hash), expiresAt: createdAt + AGENT_KEY_TTL };
  }

  /** When a key expires. A key made before keys had an end date counts its 90 days from the day it was made. */
  expiresAt(k) { return k.expiresAt ?? k.createdAt + AGENT_KEY_TTL; }

  /**
   * The key record behind a token, if it is live (not revoked or expired) and was issued for
   * `purpose`. A caller (a "door") that names no purpose gets nothing. Notes when it was last used.
   */
  agentForKey(token, purpose) {
    if (!token?.startsWith('gak_')) return null;
    const hash = sha256(token);
    const k = this.data.agent[hash];
    if (!k || k.revoked || k.purpose !== purpose || this.expiresAt(k) < this.clock()) return null;
    this.noteUsed('agent', hash);
    return this.data.agent[hash];
  }

  /**
   * Save when a key was last used. Like a session's last-seen time, it is written at most once a
   * minute per key, so a busy key does not cost a database write on every request.
   */
  noteUsed(kind, id, now = this.clock()) {
    const k = this.data[kind]?.[id];
    if (!k || now - (k.lastUsed ?? 0) < 60_000) return;
    this.store.tx((d) => { if (d.keys[kind][id]) d.keys[kind][id].lastUsed = now; });
  }

  /** The owner's agent keys, newest first. Never the secret. */
  agentKeysFor(user) {
    return Object.entries(this.data.agent).filter(([, k]) => k.owner === user.id).sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .map(([hash, k]) => ({ id: keyId(hash), agent: k.agent, purpose: k.purpose, createdAt: k.createdAt, expiresAt: this.expiresAt(k), lastUsed: k.lastUsed ?? null, revoked: Boolean(k.revoked), expired: this.expiresAt(k) < this.clock() }));
  }

  /** Revokes one of the user's agent keys by its public id. Someone else's key gets the same 404 as a missing one. */
  revokeAgentKey(user, id, ip) {
    const hash = Object.keys(this.data.agent).find((h) => keyId(h) === String(id));
    const k = hash && this.data.agent[hash];
    if (!k || k.owner !== user.id) throw new HttpError(404, 'agent_key_not_found', 'No such agent key.');
    this.store.tx((d) => {
      d.keys.agent[hash].revoked ??= this.clock();
      this.store.audit({ userId: user.id, event: 'agent_key.revoked', ip, agent: k.agent, key: keyId(hash) });
    });
    return { revoked: keyId(hash) };
  }

  /** Revokes every key of one agent that this user owns. */
  revokeAgentKeys(user, agentHandle, ip) {
    this.store.tx((d) => {
      for (const k of Object.values(d.keys.agent)) if (k.agent === agentHandle && k.owner === user.id) k.revoked ??= this.clock();
      this.store.audit({ userId: user.id, event: 'agent_key.revoked', ip, agent: agentHandle });
    });
  }

  // ---- SSH -------------------------------------------------------------------------------
  /** Adds an SSH key for the user or one of their agents. A key can be registered only once on the whole site. */
  addSsh(user, holder, { key, title }, ip) {
    const k = parseSshKey(key);
    if (this.data.ssh[k.fingerprint]) throw new HttpError(409, 'key_in_use', 'That SSH key is already registered.');
    const rec = { ...k, title: String(title ?? k.comment ?? '').slice(0, 80), holder, owner: user.id, addedAt: this.clock() };
    this.store.tx((d) => {
      d.keys.ssh[k.fingerprint] = rec;
      this.store.audit({ userId: user.id, event: 'ssh_key.added', ip, fingerprint: k.fingerprint, holder: `${holder.kind}:${holder.name}` });
    });
    return this.viewSsh(rec);
  }

  /** What we show about an SSH key: only public facts. */
  viewSsh(r) { return { fingerprint: r.fingerprint, type: r.type, title: r.title, holder: `${r.holder.kind}:${r.holder.name}`, addedAt: r.addedAt, lastUsed: r.lastUsed ?? null }; }

  sshFor(user) { return Object.values(this.data.ssh).filter((r) => r.owner === user.id).map((r) => this.viewSsh(r)); }

  sshByFingerprint(fp) { return this.data.ssh[fp] ?? null; }

  /**
   * The line for OpenSSH's AuthorizedKeysCommand. It forces every key through gitcha's git
   * shell, and turns off port, X11 and agent forwarding, the terminal (pty) and user rc files.
   */
  authorizedKeys(fingerprint, shellPath) {
    const r = this.data.ssh[fingerprint];
    if (!r) return '';
    return `command="${shellPath} ${r.fingerprint}",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ${r.type} ${r.blob}\n`;
  }

  // ---- GPG ----------------------------------------------------------------------------------
  /** Adds a GPG key. A key gpg could not check gets an id like "unchecked-<hash>". At most 64 KB of the text is kept. */
  addGpg(user, holder, { key }, ip) {
    const info = inspectGpgKey(key);
    const id = info.fingerprint ?? `unchecked-${sha256(String(key)).slice(0, 16)}`;
    if (this.data.gpg[id]) throw new HttpError(409, 'key_in_use', 'That GPG key is already registered.');
    const rec = { id, ...info, armored: String(key).slice(0, 64 * 1024), holder, owner: user.id, addedAt: this.clock() };
    this.store.tx((d) => {
      d.keys.gpg[id] = rec;
      this.store.audit({ userId: user.id, event: 'gpg_key.added', ip, fingerprint: id, holder: `${holder.kind}:${holder.name}` });
    });
    return this.viewGpg(rec);
  }

  viewGpg(r) { return { fingerprint: r.fingerprint, checked: r.checked, uids: r.uids, holder: `${r.holder.kind}:${r.holder.name}`, addedAt: r.addedAt }; }

  gpgFor(user) { return Object.values(this.data.gpg).filter((r) => r.owner === user.id).map((r) => this.viewGpg(r)); }

  /** Finds a GPG key by fingerprint: the main key or a subkey, matching all of it or its end (a short key id). */
  gpgByFingerprint(fpr) {
    const up = String(fpr ?? '').toUpperCase();
    return Object.values(this.data.gpg).find((r) => r.fingerprint && (r.fingerprint === up || r.subkeys.includes(up) || r.fingerprint.endsWith(up) || r.subkeys.some((s) => s.endsWith(up)))) ?? null;
  }

  /** Removes one of the user's SSH or GPG keys. Someone else's key gets the same 404 as a missing one. */
  removeKey(user, kind, id, ip) {
    const table = { ssh: 'ssh', gpg: 'gpg' }[kind];
    if (!table || this.data[table][id]?.owner !== user.id) throw new HttpError(404, 'not_found', 'No such key.');
    this.store.tx((d) => {
      delete d.keys[table][id];
      this.store.audit({ userId: user.id, event: `${kind}_key.removed`, ip, fingerprint: id });
    });
    return { removed: id };
  }
}
