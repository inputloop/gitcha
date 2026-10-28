// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Tiny durable JSON store. Every mutation is written atomically
// (write temp file + rename) so a crash never leaves a half-written DB.
// Package tarballs live in a content-addressed blob directory.
import fs from 'node:fs';
import path from 'node:path';

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

export class Store {
  constructor(dataDir, { auditCeiling = AUDIT_CEILING } = {}) {
    this.auditCeiling = auditCeiling;
    this.file = path.join(dataDir, 'db.json');
    this.blobDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.data = { ...EMPTY(), ...(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}) };
    if (Array.isArray(this.data.audit)) this.data.audit = splitLegacyAudit(this.data.audit, this.data.users);
    this.auditRows = Object.values(this.data.audit).reduce((n, s) => n + s.security.length + s.others.length + s.traffic.length, 0);
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
