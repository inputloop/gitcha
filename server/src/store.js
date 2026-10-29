// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Tiny durable JSON store. Every mutation is written atomically (write temp file, fsync, rename, fsync the
// directory) so a crash never leaves a half-written DB, and one process at a time owns the data directory (db.lock).
// Package tarballs live in a content-addressed blob directory, written the same way and checked when read.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { StartupError } from './config.js';
import { HttpError } from './errors.js';

const EMPTY = () => ({
  version: 1, users: {}, sessions: {}, packages: {}, teams: {}, audit: {},
  sites: {}, domains: {}, ring: { peers: {}, announcements: {} },
});

// The audit log is kept per user, in three lists, so one user's traffic can never push another's rows out
// (AUTH-5 / STORE-3). security: what the user did; others: what other people did to them (a team owner adding
// them); traffic: package downloads. Per-user caps are a keepers' choice; these are the conservative defaults.
const AUDIT_CAP = { security: 1000, others: 200, traffic: 200 };
// A ceiling on the whole log, so a database of many users stays a sane size; at the ceiling the biggest holder
// gives up its oldest row first, never a user with little in the log.
const AUDIT_CEILING = 100_000;
const TRAFFIC = new Set(['package.downloaded']);

/** The first versions kept one array of rows for everyone; split it per user, oldest first, under the same caps. */
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
// db.json is loaded once and rewritten whole on every change, so a second process on the same directory would
// silently erase what the first one wrote. The lock file holds "<pid> <nonce>"; it is created exclusively. A lock
// whose process is gone (a crash, SIGKILL) is taken over; a live one stops the start with a message.
const HELD = new Map(); // lock path -> nonce, so one 'exit' handler can release every lock this process holds
process.on('exit', () => { for (const [file, nonce] of HELD) releaseLock(file, nonce); });

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function releaseLock(file, nonce) {
  try {
    if (fs.readFileSync(file, 'utf8').trim().split(' ')[1] === nonce) fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
  HELD.delete(file);
}

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

  countAuditRows() {
    return Object.values(this.data.audit).reduce((n, s) => n + s.security.length + s.others.length + s.traffic.length, 0);
  }

  /** What db.json holds ({} for a first start). A file that cannot be read is named, never overwritten. */
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

  /** Run `fn` against the data and persist the result. If the write fails, memory goes back to what is on disk. */
  tx(fn) {
    const result = fn(this.data);
    this.flush();
    return result;
  }

  flush() {
    try {
      writeFileDurably(this.file, JSON.stringify(this.data));
    } catch (err) {
      this.restore();
      throw err;
    }
  }

  /**
   * A write failed (disk full, I/O error): memory holds changes that disk does not, and a later write would persist
   * them as if they had been acknowledged (STORE-5). Put memory back to the last file, in place: other services keep
   * a reference to the top-level `data` object, so it is emptied and refilled, not replaced.
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

  /**
   * Blobs are named by the SHA-256 of their bytes. A new one is written to a temporary name and renamed, so a crash
   * leaves no partial blob under a real name (STORE-4). One that is already there is trusted only after its bytes
   * have been hashed once in this process; a damaged one is replaced.
   */
  writeBlob(sha, buf) {
    const file = path.join(this.blobDir, sha);
    if (fs.existsSync(file) && this.blobIsSound(sha, file)) return;
    writeFileDurably(file, buf);
    this.verifiedBlobs.add(sha);
  }

  blobIsSound(sha, file) {
    if (this.verifiedBlobs.has(sha)) return true;
    const ok = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha;
    if (ok) this.verifiedBlobs.add(sha);
    return ok;
  }

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

  /** Drop the oldest row of whoever holds the most rows. */
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
   * The rows of one list, newest first: 'security' (what the user did), 'others' (what other people did to
   * them) or 'traffic' (downloads); with no kind, all three merged by time. `skip` pages.
   */
  auditFor(userId, limit = 100, { kind, skip = 0 } = {}) {
    const slot = this.data.audit[userId];
    if (!slot) return [];
    const ordered = kind ? slot[kind] : [...slot.security, ...slot.others, ...slot.traffic].sort((a, b) => a.at - b.at);
    const out = [];
    for (let i = ordered.length - 1 - skip; i >= 0 && out.length < limit; i--) out.push(ordered[i]);
    return out;
  }

  auditCount(userId, kind) {
    const slot = this.data.audit[userId];
    if (!slot) return 0;
    return kind ? slot[kind].length : slot.security.length + slot.others.length + slot.traffic.length;
  }
}
