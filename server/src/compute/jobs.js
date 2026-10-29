// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The job queue and the runner registry (the list of known runners). The
// Gitcha server never runs user code. Runners do: gitcha-runner, normally on
// separate alphaOS VMs (virtual machines). A runner registers with a
// registration token, then long-polls for jobs (asks and waits for work).
// It runs each job in an isolation backend (a sandbox that keeps the job away
// from the machine), streams logs back and reports the result.
//
// CI jobs are saved in the store (data.jobs), with their logs on disk in
// DATA_DIR/logs. Function invocations are kept in memory only: the HTTP
// request that caused one waits for its result.
// Tokens are stored only as sha256 hashes, so a copy of the store does not
// give anyone a working token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { randomToken, sha256 } from '../crypto.js';

// A job's log is cut off at 5 MB. The store keeps the newest 1000 finished jobs.
const LOG_LIMIT = 5 * 1024 * 1024;
const JOB_HISTORY = 1000;
// A registration token is the key to a runner that may see builds. So by
// default it works once and for one hour. A keeper can allow up to 20 uses.
const REG_TTL = 3600_000;
const REG_MAX_USES = 20;
// A runner's name: 1 to 80 letters, digits, spaces or . @ : _ -
const RUNNER_NAME_RE = /^[\w .@:-]{1,80}$/;
// Careful defaults the keepers can change (config.compute.maxActiveJobs, maxQueuedJobs, maxQueuedCalls).
const MAX_ACTIVE_JOBS = 10;   // builds one owner may have queued or running
const MAX_QUEUED_JOBS = 500;  // builds waiting anywhere on the instance
const MAX_QUEUED_CALLS = 50;  // function calls of one owner waiting for a runner

// "user:name" or "team:name", used as a key for billing and limits.
export const ownerKey = (o) => `${o.type}:${o.name}`;
// A random id such as "job_..." or "inv_...".
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

/**
 * Keeps the queue of jobs, hands them to matching runners, and tracks each
 * job until it ends.
 */
export class JobService {
  /** The whole database. Read through the store each time, so a restore of the store is seen here too. */
  get data() { return this.store.data; }

  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
    this.data.runners ??= {};
    this.data.runnerRegs ??= {};
    this.data.jobs ??= {};
    this.logDir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    this.sourceDir = path.join(config.dataDir, 'job-sources');
    fs.mkdirSync(this.sourceDir, { recursive: true, mode: 0o700 });
    this.queue = [];          // queued job ids, oldest first (CI + functions)
    this.live = new Map();    // in-memory function invocations by id
    this.waiters = [];        // runners blocked in claim()
    this.done = new Map();    // job id -> resolve() for awaitResult
    this.onComplete = null;   // set by the CI service (deploy artifacts)
    // Put CI jobs that were queued when the server stopped back in the queue.
    // Mark the ones that were running as failed. The CI service meters the
    // failed ones (`restarted`) once, so a held budget does not stay held forever.
    this.restarted = [];
    for (const j of Object.values(this.data.jobs)) {
      if (j.status === 'queued') this.queue.push(j.id);
      if (j.status === 'running') this.restarted.push(j.id);
    }
    // Save the "failed" mark at once, so a second restart does not find these jobs running again.
    if (this.restarted.length) {
      this.store.tx((d) => {
        for (const id of this.restarted) Object.assign(d.jobs[id], { status: 'failed', error: 'The server restarted while this job ran.', finishedAt: this.clock() });
      });
    }
  }

  // ---- runner registration ----------------------------------------------------------
  // Make a registration token for new runners. A team owner may make one for
  // the team's own runners; only an admin may make instance-wide ones. The
  // token is shown once; only its hash is saved.
  createRegistration(user, { team, uses = 1 } = {}, ip) {
    let scope;
    if (team) {
      const t = this.teams.get(team);
      this.teams.require(t, user, 'owner');
      scope = { type: 'team', name: t.name };
    } else {
      if (user.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only an administrator can register instance-wide runners. Team owners can register runners for their team.');
      scope = { type: 'instance' };
    }
    const n = Number(uses);
    if (!Number.isInteger(n) || n < 1 || n > REG_MAX_USES) throw new HttpError(400, 'bad_uses', `"uses" is how many runners may register with the token: 1 to ${REG_MAX_USES}.`);
    const ttl = this.config.compute.registrationTtlMs ?? REG_TTL;
    const token = randomToken('gtrr_');
    this.store.tx((d) => {
      d.runnerRegs[sha256(token)] = { scope, createdBy: user.username, createdAt: this.clock(), expiresAt: this.clock() + ttl, uses: n, used: 0 };
      this.store.audit({ userId: user.id, event: 'runner.registration_created', ip, scope: scope.type === 'team' ? `team:${scope.name}` : 'instance', uses: n });
    });
    return { token, scope, expiresAt: this.clock() + ttl, uses: n };
  }

  // Admins, and owners of the token's team, may see and revoke a registration.
  canManageRegistration(user, reg) {
    return user.role === 'admin' || (reg.scope.type === 'team' && this.teams.has(this.teams.get(reg.scope.name), user, 'owner'));
  }

  /** The registration tokens still good, as the person may see them (never the token itself). The id is the first 16 characters of the hash. */
  registrationsFor(user) {
    return Object.entries(this.data.runnerRegs)
      .filter(([, r]) => r.expiresAt >= this.clock() && (r.used ?? 0) < (r.uses ?? 1) && this.canManageRegistration(user, r))
      .map(([hash, r]) => ({ id: hash.slice(0, 16), scope: r.scope, createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, usesLeft: (r.uses ?? 1) - (r.used ?? 0) }));
  }

  // Delete a registration token by its short id.
  revokeRegistration(user, id, ip) {
    const hash = Object.keys(this.data.runnerRegs).find((h) => h.slice(0, 16) === String(id));
    const reg = hash && this.data.runnerRegs[hash];
    if (!reg || !this.canManageRegistration(user, reg)) throw new HttpError(404, 'not_found', 'No such registration token.');
    this.store.tx((d) => {
      delete d.runnerRegs[hash];
      this.store.audit({ userId: user.id, event: 'runner.registration_revoked', ip, scope: reg.scope.type === 'team' ? `team:${reg.scope.name}` : 'instance' });
    });
    return { revoked: String(id) };
  }

  // A runner trades a good registration token for its own runner token. The
  // runner gets the token's scope (one team, or the whole instance). Labels and
  // capabilities are cleaned up first.
  register({ token, name, labels = [], capabilities = ['ci', 'fn'], backend = 'unknown', version = '' }, ip) {
    const regKey = sha256(String(token ?? ''));
    const reg = this.data.runnerRegs[regKey];
    if (!reg || reg.expiresAt < this.clock() || (reg.used ?? 0) >= (reg.uses ?? 1)) throw new HttpError(401, 'bad_registration', 'That runner registration token is invalid or expired.');
    if (!RUNNER_NAME_RE.test(String(name ?? ''))) throw new HttpError(400, 'bad_name', 'Give the runner a short name.');
    const id = newId('run');
    const runnerToken = randomToken('gtrn_');
    const runner = {
      id, name, scope: reg.scope, labels: [...new Set(labels.map(String).filter((l) => /^[\w.-]{1,40}$/.test(l)))].slice(0, 20),
      capabilities: capabilities.filter((c) => ['ci', 'fn'].includes(c)), backend: String(backend).slice(0, 30), version: String(version).slice(0, 30),
      tokenHash: sha256(runnerToken), createdAt: this.clock(), lastSeen: this.clock(), ip,
    };
    this.store.tx((d) => { d.runners[id] = runner; d.runnerRegs[regKey].used = (reg.used ?? 0) + 1; });
    return { id, token: runnerToken, scope: runner.scope };
  }

  // Find the runner for a runner token (by its hash), or null. Also notes when it was last seen:
  // saved at most once a minute, like a session's, since a runner calls every few seconds.
  authRunner(token) {
    if (!token) return null;
    const h = sha256(token);
    const r = Object.values(this.data.runners).find((x) => x.tokenHash === h);
    if (!r || r.disabled) return null;
    const now = this.clock();
    if (now - (r.lastSeen ?? 0) >= 60_000) this.store.tx((d) => { d.runners[r.id].lastSeen = now; });
    return this.data.runners[r.id];
  }

  // Runners a user may see: all of them for admins, else their teams' runners.
  // A runner counts as online if it was seen in the last 90 seconds.
  runnersFor(user) {
    return Object.values(this.data.runners)
      .filter((r) => user.role === 'admin' || (r.scope.type === 'team' && this.teams.has(this.store.team(r.scope.name) ?? { members: {} }, user, 'member')))
      .map(({ tokenHash, ...r }) => ({ ...r, online: this.clock() - r.lastSeen < 90_000 }));
  }

  // Remove a runner. Admins may remove any; team owners may remove their team's.
  removeRunner(user, id, ip) {
    const r = this.data.runners[id];
    if (!r) throw new HttpError(404, 'not_found', 'No such runner.');
    const ok = user.role === 'admin' || (r.scope.type === 'team' && this.teams.has(this.teams.get(r.scope.name), user, 'owner'));
    if (!ok) throw new HttpError(403, 'forbidden', 'You cannot remove that runner.');
    this.store.tx((d) => {
      delete d.runners[id];
      this.store.audit({ userId: user.id, event: 'runner.removed', ip, runner: r.name });
    });
    return { removed: id };
  }

  // ---- queue ------------------------------------------------------------------------
  // A job by id: in-memory function calls first, then saved CI jobs.
  get(id) { return this.live.get(id) ?? this.data.jobs[id] ?? null; }

  /** Add a job to the queue. Kind 'ci' jobs are saved; kind 'fn' jobs live in memory. */
  enqueue(job) {
    if (job.kind === 'fn') {
      // Calls nobody has picked up yet sit in memory, so one owner may only have
      // so many waiting (FN-1).
      let waiting = 0;
      for (const j of this.live.values()) if (j.status === 'queued' && ownerKey(j.owner) === ownerKey(job.owner)) waiting++;
      if (waiting >= (this.config.compute.maxQueuedCalls ?? MAX_QUEUED_CALLS)) throw new HttpError(429, 'busy', 'Too many calls to these functions are waiting for a runner; try again shortly.');
    }
    const full = {
      id: newId(job.kind === 'fn' ? 'inv' : 'job'), status: 'queued', createdAt: this.clock(), labels: [], ...(job.kind === 'fn' ? { logBytes: 0 } : {}), ...job,
      tokenHash: null,
    };
    if (full.kind === 'fn') this.live.set(full.id, full);
    else {
      this.store.tx((d) => { d.jobs[full.id] = full; });
      this.trimHistory();
    }
    this.queue.push(full.id);
    this.dispatch();
    return full;
  }

  /** One owner, and the instance, may only have so many builds waiting or running (LIM-2). */
  assertRoom(owner) {
    const mine = ownerKey(owner);
    let active = 0;
    let queued = 0;
    for (const j of Object.values(this.data.jobs)) {
      if (j.kind !== 'ci' || !['queued', 'running'].includes(j.status)) continue;
      if (j.status === 'queued') queued++;
      if (ownerKey(j.owner) === mine) active++;
    }
    if (active >= (this.config.compute.maxActiveJobs ?? MAX_ACTIVE_JOBS)) throw new HttpError(429, 'too_many_jobs', `${mine} already has ${active} builds queued or running; wait for some to finish, or cancel them.`);
    if (queued >= (this.config.compute.maxQueuedJobs ?? MAX_QUEUED_JOBS)) throw new HttpError(429, 'queue_full', 'The build queue is full; try again shortly.');
  }

  /** Minutes the owner's waiting and running plan-paid builds may still use, counted at their full time limits (QUOTA-1). */
  reservedMinutes(owner) {
    const mine = ownerKey(owner);
    let n = 0;
    for (const j of Object.values(this.data.jobs)) {
      if (j.kind === 'ci' && !j.paidByBudget && ['queued', 'running'].includes(j.status) && ownerKey(j.owner) === mine) n += Math.ceil(j.timeoutMs / 60_000);
    }
    return n;
  }

  /** The pipeline a build runs. It is kept once in a blob rather than in every job record (LIM-2). */
  specOf(j) {
    if (j.spec) return j.spec;
    if (!j.pipelineSha) return null;
    try { return { pipeline: JSON.parse(this.store.readBlob(j.pipelineSha).toString('utf8')) }; } catch { return null; }
  }

  /**
   * A build's source is only needed until the build ends. So it is kept in a
   * file of its own under DATA_DIR/job-sources, not in the blobs. Blobs are
   * named by the hash of their bytes, shared with packages and functions, and
   * never deleted (LIM-1b). The file's random key is stored in the job's `sourceSha`.
   */
  keepSource(buf) {
    const key = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(this.sourceDir, key), buf, { mode: 0o600 });
    return key;
  }

  // Read a build's own source file, or 404 if it is gone.
  readSource(job) {
    try { return fs.readFileSync(path.join(this.sourceDir, job.sourceSha)); } catch { throw new HttpError(404, 'no_source', 'This job\'s source is no longer kept.'); }
  }

  // Delete a build's own source file once the build is over.
  dropSource(job) {
    if (job.kind === 'ci' && job.ownSource && job.sourceSha) fs.rmSync(path.join(this.sourceDir, job.sourceSha), { force: true });
  }

  // Delete the oldest finished jobs (and their logs) beyond JOB_HISTORY.
  trimHistory() {
    const ids = Object.values(this.data.jobs).filter((j) => !['queued', 'running'].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt).map((j) => j.id);
    const extra = ids.length - JOB_HISTORY;
    if (extra <= 0) return;
    this.store.tx((d) => { for (const id of ids.slice(0, extra)) { delete d.jobs[id]; fs.rmSync(this.logPath(id), { force: true }); } });
  }

  // May this runner take this job? It must handle the job's kind. A team
  // runner only takes that team's jobs. It must have every label the job asks for.
  matches(runner, job) {
    if (!runner.capabilities.includes(job.kind)) return false;
    if (runner.scope.type === 'team' && !(job.owner.type === 'team' && job.owner.name === runner.scope.name)) return false;
    return (job.labels ?? []).every((l) => runner.labels.includes(l));
  }

  /** Hand queued jobs to waiting runners. Each waiting runner gets the oldest queued job it matches. */
  dispatch() {
    for (let w = 0; w < this.waiters.length; w++) {
      const waiter = this.waiters[w];
      const idx = this.queue.findIndex((id) => { const j = this.get(id); return j && j.status === 'queued' && this.matches(waiter.runner, j); });
      if (idx === -1) continue;
      const [id] = this.queue.splice(idx, 1);
      this.waiters.splice(w--, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(this.start(waiter.runner, this.get(id)));
    }
  }

  // Mark a job as running on a runner and make a fresh job token for it. The
  // deadline is the time limit plus 30 seconds. Only the token's hash is kept.
  start(runner, job) {
    const jobToken = randomToken('gtj_');
    const patch = { status: 'running', startedAt: this.clock(), runnerId: runner.id, runnerName: runner.name, tokenHash: sha256(jobToken), deadline: this.clock() + job.timeoutMs + 30_000 };
    if (job.kind === 'fn') Object.assign(job, patch);
    else this.store.tx((d) => Object.assign(d.jobs[job.id], patch));
    const j = this.get(job.id);
    const handed = {
      job: { id: j.id, kind: j.kind, spec: this.specOf(j), timeoutMs: j.timeoutMs, hasSource: Boolean(j.sourceSha), owner: j.owner, limits: { maxUnpackedBytes: 4 * this.config.maxPackageBytes } },
      jobToken,
    };
    // The runner has the caller's request now, so the server need not keep its
    // body while the call runs (FN-1).
    if (j.kind === 'fn' && j.spec?.request) j.spec = { ...j.spec, request: { ...j.spec.request, body: '' } };
    return handed;
  }

  /**
   * Put a job that was handed to a runner back at the front of the queue, as if it had never started
   * (the runner went away before it got the job). A CI job's record is saved at once.
   */
  requeue(job) {
    const patch = { status: 'queued', tokenHash: null, startedAt: null, runnerId: null, runnerName: null, deadline: null };
    if (job.kind === 'fn') Object.assign(job, patch);
    else this.store.tx((d) => Object.assign(d.jobs[job.id], patch));
    this.queue.unshift(job.id);
  }

  /** Long-poll: resolves with { job, jobToken }, or null after waitMs (at most 30 seconds). */
  claim(runner, waitMs = 25_000) {
    return new Promise((resolve) => {
      const waiter = { runner, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, Math.min(waitMs, 30_000));
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  // Answer every waiting runner with "no job" (used when shutting down).
  cancelWaiters() {
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.waiters = [];
  }

  /** A job token is only good for its own job, while it runs. */
  jobFor(id, token, runnerId) {
    const j = this.get(id);
    if (!j || !token) throw new HttpError(401, 'bad_job_token', 'Unknown job or token.');
    if (j.status !== 'running') throw new HttpError(409, 'job_finished', `This job is already ${j.status}.`);
    // The token belongs to the runner that claimed the job, not to anyone else
    // who holds it (RUN-2).
    if (j.tokenHash !== sha256(token) || (runnerId && j.runnerId !== runnerId)) throw new HttpError(401, 'bad_job_token', 'Unknown job or token.');
    return j;
  }

  logPath(id) { return path.join(this.logDir, `${id}.log`); }

  // Add text to a job's log, up to LOG_LIMIT. A function's log is kept in
  // memory; a CI log goes to a file on disk.
  appendLog(job, text) {
    const buf = Buffer.from(String(text));
    // A function's log lives in memory with its byte count. A CI log's size is the size of its file,
    // so nothing about it needs saving in the database while the job runs.
    const used = job.kind === 'fn' ? (job.logBytes ?? 0) : this.logSize(job.id);
    const room = LOG_LIMIT - used;
    if (room <= 0) return;
    const chunk = buf.subarray(0, room);
    if (job.kind === 'fn') {
      job.log = (job.log ?? '') + chunk.toString('utf8');
      job.logBytes = used + chunk.length;
      return;
    }
    fs.appendFileSync(this.logPath(job.id), chunk);
    if (chunk.length < buf.length) fs.appendFileSync(this.logPath(job.id), '\n[log truncated at 5 MB]\n');
  }

  /** How many bytes a CI job's log file holds (0 when there is no file yet). */
  logSize(id) {
    try { return fs.statSync(this.logPath(id)).size; } catch { return 0; }
  }

  readLog(job) {
    if (job.kind === 'fn') return job.log ?? '';
    try { return fs.readFileSync(this.logPath(job.id), 'utf8'); } catch { return ''; }
  }

  // A runner reports that a job ended. Save the result (an artifact is stored
  // as a blob), clear the job token so it stops working, run the end steps,
  // and wake whoever waits for the result. A finished function call is
  // forgotten after 60 seconds.
  async complete(job, { status, exitCode = null, error = null, artifact = null, response = null }) {
    if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) throw new HttpError(400, 'bad_status', 'Unknown job status.');
    let artifactSha = null;
    if (artifact) {
      artifactSha = sha256(artifact);
      this.store.writeBlob(artifactSha, artifact);
    }
    const patch = { status, exitCode, error: error ? String(error).slice(0, 2000) : null, finishedAt: this.clock(), artifactSha, tokenHash: null };
    if (job.kind === 'fn') Object.assign(job, patch, { response });
    else this.store.tx((d) => Object.assign(d.jobs[job.id], patch));
    const final = this.get(job.id);
    await this.ended(final);
    this.done.get(job.id)?.(final);
    this.done.delete(job.id);
    if (job.kind === 'fn') setTimeout(() => this.live.delete(job.id), 60_000).unref();
    return final;
  }

  /** Every way a build can end comes through here: its source is deleted, and its minutes are metered (TRIG-1). */
  async ended(job) {
    this.dropSource(job);
    if (!this.onComplete) return;
    try { await this.onComplete(job); } catch (err) { this.appendLog(job, `\n[gitcha] after-job step failed: ${err.message}\n`); }
  }

  /** Wait up to `ms` for a job to finish (used for function invocations). After that, the job is marked timed_out. */
  awaitResult(job, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.done.delete(job.id);
        this.queue = this.queue.filter((id) => id !== job.id);
        if (['queued', 'running'].includes(job.status)) Object.assign(job, { status: 'timed_out', finishedAt: this.clock(), tokenHash: null });
        // Nobody will read this call again, so do not keep it, or the caller's
        // body, in memory (FN-1).
        if (job.kind === 'fn') { this.live.delete(job.id); if (job.spec?.request) job.spec = { ...job.spec, request: { ...job.spec.request, body: '' } }; }
        resolve(job);
      }, ms);
      this.done.set(job.id, (j) => { clearTimeout(t); resolve(j); });
    });
  }

  // Cancel a waiting or running CI job, if canManage says the user may.
  async cancel(user, id, canManage) {
    const j = this.data.jobs[id];
    if (!j || !canManage(user, j)) throw new HttpError(404, 'not_found', 'No such job.');
    if (!['queued', 'running'].includes(j.status)) return j;
    this.queue = this.queue.filter((x) => x !== id);
    this.store.tx((d) => Object.assign(d.jobs[id], { status: 'cancelled', finishedAt: this.clock(), tokenHash: null }));
    const final = this.get(id);
    await this.ended(final); // the minutes it used are metered; the runner learns on its next log call and stops
    return final;
  }

  /** Mark CI jobs past their deadline as timed out. Call periodically. */
  sweep() {
    for (const j of Object.values(this.data.jobs)) {
      if (j.status === 'running' && j.deadline < this.clock()) {
        this.store.tx((d) => Object.assign(d.jobs[j.id], { status: 'timed_out', finishedAt: this.clock(), tokenHash: null }));
        this.ended(this.data.jobs[j.id]).catch(() => {});
      }
    }
  }

  // The API shape of a job, without its token hash, log, spec or pipeline hash.
  view(j) {
    const { tokenHash, log, spec, pipelineSha, ...rest } = j;
    return rest;
  }
}
