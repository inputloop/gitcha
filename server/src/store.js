// Tiny durable JSON store. Every mutation is written atomically
// (write temp file + rename) so a crash never leaves a half-written DB.
// Package tarballs live in a content-addressed blob directory.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  version: 1, users: {}, sessions: {}, packages: {}, teams: {}, audit: [],
  sites: {}, domains: {}, ring: { peers: {}, announcements: {} },
});
const AUDIT_LIMIT = 10_000;

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'db.json');
    this.blobDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.data = { ...EMPTY(), ...(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}) };
  }

  /** Run `fn` against the data and persist the result. */
  tx(fn) {
    const result = fn(this.data);
    this.flush();
    return result;
  }

  flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- users -------------------------------------------------------------
  userById(id) { return this.data.users[id] ?? null; }
  userByName(username) {
    const lower = String(username).toLowerCase();
    return Object.values(this.data.users).find((u) => u.username.toLowerCase() === lower) ?? null;
  }
  userCount() { return Object.keys(this.data.users).length; }
  /** Users, teams and agents share one namespace so none can pose as another. */
  nameInUse(name) {
    const n = String(name).toLowerCase();
    return Boolean(this.userByName(n) || this.data.teams[n] || this.data.agents?.[n]);
  }

  // ---- sessions & device tokens -----------------------------------------
  sessionByHash(hash) { return this.data.sessions[hash] ?? null; }
  sessionsForUser(userId) {
    return Object.entries(this.data.sessions)
      .filter(([, s]) => s.userId === userId)
      .map(([hash, s]) => ({ hash, ...s }));
  }

  // ---- teams --------------------------------------------------------------
  team(name) { return this.data.teams[name] ?? null; }
  teams() { return Object.values(this.data.teams); }

  // ---- packages -----------------------------------------------------------
  pkg(name) { return this.data.packages[name] ?? null; }
  packages() { return Object.values(this.data.packages); }

  writeBlob(sha, buf) {
    const file = path.join(this.blobDir, sha);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o600 });
  }
  readBlob(sha) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('bad blob id');
    return fs.readFileSync(path.join(this.blobDir, sha));
  }

  // ---- audit log ----------------------------------------------------------
  audit(entry) {
    this.data.audit.push({ at: Date.now(), ...entry });
    if (this.data.audit.length > AUDIT_LIMIT) this.data.audit.splice(0, this.data.audit.length - AUDIT_LIMIT);
  }
  auditFor(userId, limit = 100) {
    const out = [];
    for (let i = this.data.audit.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.data.audit[i].userId === userId) out.push(this.data.audit[i]);
    }
    return out;
  }
}
