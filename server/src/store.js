// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The server's database: one JSON file (db.json) in the data folder, kept in memory and written back
// whole after every change. Each write is atomic (all or nothing): write a temporary file, fsync it
// (force it onto the disk), rename it into place, then fsync the folder. So a crash never leaves a
// half-written database. Only one process at a time may own the data folder (the db.lock file).
// Package tarballs (and other stored files, such as CI artifacts and media) live in a blob folder, named by the
// hash of their bytes ("content-addressed").
// They are written the same way and checked when read.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { StartupError } from './config.js';
import { HttpError } from './errors.js';

// The shape of a brand-new database. Other services add their own collections (such as agents or jobs) as needed.
const EMPTY = () => ({
  version: 1, users: {}, sessions: {}, packages: {}, teams: {}, audit: {},
  sites: {}, domains: {}, ring: { peers: {}, announcements: {} },
});

// The audit log (a record of security events) is kept per user, in three lists, so one user's traffic can never
// push another's rows out (AUTH-5 / STORE-3). security: what the user did. others: what other people did to them
// (such as a team owner adding them). traffic: package downloads. Per-user caps are a keepers' choice; these
// are the careful defaults.
const AUDIT_CAP = { security: 1000, others: 200, traffic: 200 };
// A ceiling on the whole log, so a database with many users stays a sane size. At the ceiling, the user with
// the most rows gives up their oldest row first, never a user with little in the log.
const AUDIT_CEILING = 100_000;
const TRAFFIC = new Set(['package.downloaded']); // events that go in the 'traffic' list

/** The first versions kept one array of rows for everyone. Split it per user, oldest first, under the same caps. */
function splitLegacyAudit(rows, users) {
  const out = {};
  for (const row of rows) {
    const slot = (out[row.userId ?? ''] ??= { security: [], others: [], traffic: [] });
    const user = row.userId ? users?.[row.userId] : null;
    const kind = TRAFFIC.has(row.event) ? 'traffic' : row.by !== undefined && user && user.username !== row.by ? 'others' : 'security';
    slot[kind].push(row);
  }
  for (const slot of Object.values(out)) for (const kind of Object.keys(AUDIT_CAP)) if (slot[kind].length > AUDIT_CAP[kind]) slot[kind].splice(0, slot[kind].length - AUDIT_CAP[kind]);
  return out;
}

// ---- one process per data directory (STORE-1) ---------------------------------------------------------
// db.json is loaded once and rewritten whole on every change. So a second process on the same folder would
// silently erase what the first one wrote. The lock file holds "<pid> <nonce>" (process id and a random value).
// It is created only if it does not exist yet. A lock whose process is gone (a crash, SIGKILL) is taken over;
// a live one stops the start with a message.
const HELD = new Map(); // lock path -> nonce, so one 'exit' handler can release every lock this process holds
process.on('exit', () => { for (const [file, nonce] of HELD) releaseLock(file, nonce); });

/** Is process `pid` still running? Signal 0 only checks. EPERM means it exists but belongs to another user. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Remove the lock file, but only if it still holds our nonce (never another process's lock). */
function releaseLock(file, nonce) {
  try {
    if (fs.readFileSync(file, 'utf8').trim().split(' ')[1] === nonce) fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
  HELD.delete(file);
}

/** Take the data folder lock, or throw a StartupError if a live process holds it. Tries up to 3 times. */
function acquireLock(file, dataDir) {
  const nonce = crypto.randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, `${process.pid} ${nonce}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      HELD.set(file, nonce);
      return nonce;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      // Our own pid with another nonce is an earlier Store in this same process (a test restarting the app), not a rival.
      if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) {
        throw new StartupError(`another process (pid ${pid}) is already using ${dataDir}. Run one Gitcha server per data directory. If you are sure none is running, delete ${file}.`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new StartupError(`could not take the lock ${file}; another start is racing for ${dataDir}.`);
}

/** Force a file or folder entry onto the disk. Errors are ignored (see below). */
function fsyncPath(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch { /* a directory cannot be synced on every platform; the file sync above is the one that matters */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write a file whole and durably: temporary name, data to disk, rename into place, then the directory entry. */
function writeFileDurably(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncPath(path.dirname(file));
}

/**
 * The database. Services read `store.data` directly and change it inside tx(), which saves to disk.
 * It also stores blobs and keeps the per-user audit log.
 */
export class Store {
  constructor(dataDir, { auditCeiling = AUDIT_CEILING } = {}) {
    this.auditCeiling = auditCeiling;
    this.file = path.join(dataDir, 'db.json');
    this.blobDir = path.join(dataDir, 'blobs');
    this.lockFile = path.join(dataDir, 'db.lock');
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.lockNonce = acquireLock(this.lockFile, dataDir);
    try {
      // We hold the lock, so any half-written temporary file belongs to a process that died (STORE-6).
      for (const dir of [dataDir, this.blobDir]) {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
      }
      this.verifiedBlobs = new Set(); // blobs whose bytes matched their name once in this process
      this.data = { ...EMPTY(), ...this.readDisk() };
      if (Array.isArray(this.data.audit)) this.data.audit = splitLegacyAudit(this.data.audit, this.data.users);
      this.auditRows = this.countAuditRows();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Count every audit row in every list. */
  countAuditRows() {
    return Object.values(this.data.audit).reduce((n, s) => n + s.security.length + s.others.length + s.traffic.length, 0);
  }

  /** What db.json holds ({} on a first start). A file that cannot be read is named in the error, never overwritten. */
  readDisk() {
    if (!fs.existsSync(this.file)) return {};
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new StartupError(`${this.file} is not valid JSON (${err.message}). Restore it from a backup; the server will not start on it and will not overwrite it.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StartupError(`${this.file} does not hold a Gitcha database (expected a JSON object). Restore it from a backup.`);
    }
    return parsed;
  }

  /** Let go of the data directory (the next process may start). */
  close() {
    if (this.lockNonce) releaseLock(this.lockFile, this.lockNonce);
    this.lockNonce = null;
  }

  /**
   * Run `fn` on the data, then save it to disk. All of the change is kept, or none of it:
   * - If `fn` throws partway through, the part it already changed is undone (memory goes back to
   *   what is on disk), so a later save cannot write a half-made change.
   * - If the write fails, memory goes back to what is on disk too (see restore).
   */
  tx(fn) {
    let result;
    try {
      result = fn(this.data);
      this.flush();
    } catch (err) {
      this.restore();
      throw err;
    }
    return result;
  }

  /** Write the whole database to disk now. */
  flush() {
    try {
      writeFileDurably(this.file, JSON.stringify(this.data));
    } catch (err) {
      this.restore();
      throw err;
    }
  }

  /**
   * A write failed (disk full, I/O error), or a change threw partway through. Memory now holds changes that the
   * disk does not, and a later write would save them as if they had been accepted (STORE-5). So put memory back
   * to the last file, in place. Other services keep a reference to the top-level `data` object, so it is emptied
   * and refilled, not replaced. Services must read their collections through the store each time (as getters),
   * never keep a reference to one, because the collections themselves are replaced.
   */
  restore() {
    let disk;
    try { disk = { ...EMPTY(), ...this.readDisk() }; } catch { return; } // cannot even read it: leave memory, the error is already on its way up
    if (Array.isArray(disk.audit)) disk.audit = splitLegacyAudit(disk.audit, disk.users);
    for (const k of Object.keys(this.data)) delete this.data[k];
    Object.assign(this.data, disk);
    this.auditRows = this.countAuditRows();
  }

  // ---- users -------------------------------------------------------------
  userById(id) { return this.data.users[id] ?? null; }
  userByName(username) {
    const lower = String(username).toLowerCase();
    return Object.values(this.data.users).find((u) => u.username.toLowerCase() === lower) ?? null;
  }
  userCount() { return Object.keys(this.data.users).length; }
  /** Users, teams and agents share one set of names, so none can pose as another. Not case sensitive. */
  nameInUse(name) {
    const n = String(name).toLowerCase();
    return Boolean(this.userByName(n) || this.data.teams[n] || this.data.agents?.[n]);
  }

  // ---- sessions & device tokens -----------------------------------------
  // Sessions are stored under the SHA-256 hash of their token, never the token itself.
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

  /**
   * Save a blob. Blobs are named by the SHA-256 of their bytes. A new one is written to a temporary name and
   * renamed, so a crash leaves no partial blob under a real name (STORE-4). One that is already there is trusted
   * only after its bytes have been hashed once in this process. A damaged one is replaced.
   */
  writeBlob(sha, buf) {
    const file = path.join(this.blobDir, sha);
    if (fs.existsSync(file) && this.blobIsSound(sha, file)) return;
    writeFileDurably(file, buf);
    this.verifiedBlobs.add(sha);
  }

  /** Do the blob's bytes still hash to its name? Remembers a good answer for the rest of this process. */
  blobIsSound(sha, file) {
    if (this.verifiedBlobs.has(sha)) return true;
    const ok = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha;
    if (ok) this.verifiedBlobs.add(sha);
    return ok;
  }

  /** Read a blob. The id must be 64 hex characters, so it can never name a path outside the blob folder. */
  readBlob(sha) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('bad blob id');
    const file = path.join(this.blobDir, sha);
    const buf = fs.readFileSync(file);
    // The name says what the bytes must hash to; check it the first time this process serves the blob.
    if (!this.verifiedBlobs.has(sha)) {
      if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) {
        throw new HttpError(500, 'blob_damaged', 'The stored file for this item is damaged on the server. Ask the maintainer to publish it again and tell the operator.');
      }
      this.verifiedBlobs.add(sha);
    }
    return buf;
  }

  // ---- audit log ----------------------------------------------------------
  /**
   * Add an audit row and drop old rows past the caps. It does not save by itself: callers run it inside
   * tx(), so the row is written with the change it records.
   */
  audit(entry) {
    const row = { at: Date.now(), ...entry };
    const user = row.userId ? this.data.users[row.userId] : null;
    // A row about something another person did to you carries no address of theirs (AUTH-11).
    const byOther = row.by !== undefined && Boolean(user) && user.username !== row.by;
    if (byOther) delete row.ip;
    const slot = (this.data.audit[row.userId ?? ''] ??= { security: [], others: [], traffic: [] });
    const kind = TRAFFIC.has(row.event) ? 'traffic' : byOther ? 'others' : 'security';
    const list = slot[kind];
    list.push(row);
    this.auditRows++;
    if (list.length > AUDIT_CAP[kind]) {
      const drop = list.length - AUDIT_CAP[kind];
      list.splice(0, drop);
      this.auditRows -= drop;
    }
    while (this.auditRows > this.auditCeiling) this.trimBiggestHolder();
  }

  /** Drop the oldest row of whoever holds the most rows (used when the whole log is at its ceiling). */
  trimBiggestHolder() {
    let big = null;
    let bigN = -1;
    for (const slot of Object.values(this.data.audit)) {
      const n = slot.security.length + slot.others.length + slot.traffic.length;
      if (n > bigN) { big = slot; bigN = n; }
    }
    const oldest = Object.keys(AUDIT_CAP).filter((k) => big[k].length).sort((x, y) => big[x][0].at - big[y][0].at)[0];
    big[oldest].shift();
    this.auditRows--;
  }

  /**
   * One user's rows from one list, newest first: 'security' (what the user did), 'others' (what other people
   * did to them) or 'traffic' (downloads). With no kind, all three are merged by time. `skip` jumps past
   * that many rows, for paging. At most `limit` rows come back.
   */
  auditFor(userId, limit = 100, { kind, skip = 0 } = {}) {
    const slot = this.data.audit[userId];
    if (!slot) return [];
    const ordered = kind ? slot[kind] : [...slot.security, ...slot.others, ...slot.traffic].sort((a, b) => a.at - b.at);
    const out = [];
    for (let i = ordered.length - 1 - skip; i >= 0 && out.length < limit; i--) out.push(ordered[i]);
    return out;
  }

  /** How many audit rows a user has, in one list or in all three. */
  auditCount(userId, kind) {
    const slot = this.data.audit[userId];
    if (!slot) return 0;
    return kind ? slot[kind].length : slot.security.length + slot.others.length + slot.traffic.length;
  }
}
