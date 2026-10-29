// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The job queue and the runner registry. The Gitcha server never runs user
// code: runners (gitcha-runner, normally on separate alphaOS VMs) register
// with a registration token, long-poll for jobs, run them in an isolation
// backend, stream logs back and report the result.
//
// CI jobs are persisted (with their logs on disk). Function invocations are
// kept in memory only: the HTTP request that caused one waits for its result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { randomToken, sha256 } from '../crypto.js';

const LOG_LIMIT = 5 * 1024 * 1024;
const JOB_HISTORY = 1000;
// A registration token is the key to a runner that may see builds: one use, one hour, unless the keeper asks otherwise.
const REG_TTL = 3600_000;
const REG_MAX_USES = 20;
const RUNNER_NAME_RE = /^[\w .@:-]{1,80}$/;
// Conservative defaults the keepers can change (config.compute.maxActiveJobs, maxQueuedJobs, maxQueuedCalls).
const MAX_ACTIVE_JOBS = 10;   // builds one owner may have queued or running
const MAX_QUEUED_JOBS = 500;  // builds waiting anywhere on the instance
const MAX_QUEUED_CALLS = 50;  // function calls of one owner waiting for a runner

export const ownerKey = (o) => `${o.type}:${o.name}`;
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

export class JobService {
  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
    this.data = store.data;
    this.data.runners ??= {};
    this.data.runnerRegs ??= {};
    this.data.jobs ??= {};
    this.logDir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    this.queue = [];          // queued job ids, oldest first (CI + functions)
    this.live = new Map();    // in-memory function invocations by id
    this.waiters = [];        // runners blocked in claim()
    this.done = new Map();    // job id -> resolve() for awaitResult
    this.onComplete = null;   // set by the CI service (deploy artifacts)
    // Requeue CI jobs that were queued when the server stopped; fail ones that were running.
    for (const j of Object.values(this.data.jobs)) {
      if (j.status === 'queued') this.queue.push(j.id);
      if (j.status === 'running') Object.assign(j, { status: 'failed', error: 'The server restarted while this job ran.', finishedAt: this.clock() });
    }
  }

  // ---- runner registration ----------------------------------------------------------
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

  canManageRegistration(user, reg) {
    return user.role === 'admin' || (reg.scope.type === 'team' && this.teams.has(this.teams.get(reg.scope.name), user, 'owner'));
  }

  /** The registration tokens still good, as the person may see them (never the token itself). */
  registrationsFor(user) {
    return Object.entries(this.data.runnerRegs)
      .filter(([, r]) => r.expiresAt >= this.clock() && (r.used ?? 0) < (r.uses ?? 1) && this.canManageRegistration(user, r))
      .map(([hash, r]) => ({ id: hash.slice(0, 16), scope: r.scope, createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, usesLeft: (r.uses ?? 1) - (r.used ?? 0) }));
  }

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

  authRunner(token) {
    if (!token) return null;
    const h = sha256(token);
    const r = Object.values(this.data.runners).find((x) => x.tokenHash === h);
    if (!r || r.disabled) return null;
    r.lastSeen = this.clock();
    return r;
  }

  runnersFor(user) {
    return Object.values(this.data.runners)
      .filter((r) => user.role === 'admin' || (r.scope.type === 'team' && this.teams.has(this.store.team(r.scope.name) ?? { members: {} }, user, 'member')))
      .map(({ tokenHash, ...r }) => ({ ...r, online: this.clock() - r.lastSeen < 90_000 }));
  }

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
  get(id) { return this.live.get(id) ?? this.data.jobs[id] ?? null; }

  /** kind 'ci' jobs persist; kind 'fn' jobs live in memory. */
  enqueue(job) {
    if (job.kind === 'fn') {
      // Calls nobody has picked up yet sit in memory; one owner's pile of them is bounded (FN-1).
      let waiting = 0;
      for (const j of this.live.values()) if (j.status === 'queued' && ownerKey(j.owner) === ownerKey(job.owner)) waiting++;
      if (waiting >= (this.config.compute.maxQueuedCalls ?? MAX_QUEUED_CALLS)) throw new HttpError(429, 'busy', 'Too many calls to these functions are waiting for a runner; try again shortly.');
    }
    const full = {
      id: newId(job.kind === 'fn' ? 'inv' : 'job'), status: 'queued', createdAt: this.clock(), labels: [], logBytes: 0, ...job,
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

  /** Minutes the owner's waiting and running plan-paid builds may still use, counted at their timeouts (QUOTA-1). */
  reservedMinutes(owner) {
    const mine = ownerKey(owner);
    let n = 0;
    for (const j of Object.values(this.data.jobs)) {
      if (j.kind === 'ci' && !j.paidByBudget && ['queued', 'running'].includes(j.status) && ownerKey(j.owner) === mine) n += Math.ceil(j.timeoutMs / 60_000);
    }
    return n;
  }

  /** The pipeline a build runs, kept once in a blob rather than in every job record (LIM-2). */
  specOf(j) {
    if (j.spec) return j.spec;
    if (!j.pipelineSha) return null;
    try { return { pipeline: JSON.parse(this.store.readBlob(j.pipelineSha).toString('utf8')) }; } catch { return null; }
  }

  /** A build's source is only needed until it ends; it is stored under a key of its own, so removing it is safe (LIM-1b). */
  dropSource(job) {
    if (job.kind === 'ci' && job.ownSource && job.sourceSha) fs.rmSync(path.join(this.store.blobDir, job.sourceSha), { force: true });
  }

  trimHistory() {
    const ids = Object.values(this.data.jobs).filter((j) => !['queued', 'running'].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt).map((j) => j.id);
    const extra = ids.length - JOB_HISTORY;
    if (extra <= 0) return;
    this.store.tx((d) => { for (const id of ids.slice(0, extra)) { delete d.jobs[id]; fs.rmSync(this.logPath(id), { force: true }); } });
  }

  matches(runner, job) {
    if (!runner.capabilities.includes(job.kind)) return false;
    if (runner.scope.type === 'team' && !(job.owner.type === 'team' && job.owner.name === runner.scope.name)) return false;
    return (job.labels ?? []).every((l) => runner.labels.includes(l));
  }

  /** Hand queued jobs to waiting runners. */
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

  start(runner, job) {
    const jobToken = randomToken('gtj_');
    const patch = { status: 'running', startedAt: this.clock(), runnerId: runner.id, runnerName: runner.name, tokenHash: sha256(jobToken), deadline: this.clock() + job.timeoutMs + 30_000 };
    if (job.kind === 'fn') Object.assign(job, patch);
    else this.store.tx((d) => Object.assign(d.jobs[job.id], patch));
    const j = this.get(job.id);
    const handed = {
      job: { id: j.id, kind: j.kind, spec: this.specOf(j), timeoutMs: j.timeoutMs, hasSource: Boolean(j.sourceSha), owner: j.owner },
      jobToken,
    };
    // The runner has the caller's request now; the server need not keep its body while the call runs (FN-1).
    if (j.kind === 'fn' && j.spec?.request) j.spec = { ...j.spec, request: { ...j.spec.request, body: '' } };
    return handed;
  }

  /** Long-poll: resolves with { job, jobToken } or null after waitMs. */
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

  cancelWaiters() {
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.waiters = [];
  }

  /** A job token is only good for its own job, while it runs. */
  jobFor(id, token, runnerId) {
    const j = this.get(id);
    if (!j || !token) throw new HttpError(401, 'bad_job_token', 'Unknown job or token.');
    if (j.status !== 'running') throw new HttpError(409, 'job_finished', `This job is already ${j.status}.`);
    // The token belongs to the runner that claimed the job, not to whoever else holds it (RUN-2).
    if (j.tokenHash !== sha256(token) || (runnerId && j.runnerId !== runnerId)) throw new HttpError(401, 'bad_job_token', 'Unknown job or token.');
    return j;
  }

  logPath(id) { return path.join(this.logDir, `${id}.log`); }

  appendLog(job, text) {
    const buf = Buffer.from(String(text));
    const room = LOG_LIMIT - (job.logBytes ?? 0);
    if (room <= 0) return;
    const chunk = buf.subarray(0, room);
    if (job.kind === 'fn') {
      job.log = (job.log ?? '') + chunk.toString('utf8');
      job.logBytes = (job.logBytes ?? 0) + chunk.length;
      return;
    }
    fs.appendFileSync(this.logPath(job.id), chunk);
    this.data.jobs[job.id].logBytes = (job.logBytes ?? 0) + chunk.length;
    if (chunk.length < buf.length) fs.appendFileSync(this.logPath(job.id), '\n[log truncated at 5 MB]\n');
  }

  readLog(job) {
    if (job.kind === 'fn') return job.log ?? '';
    try { return fs.readFileSync(this.logPath(job.id), 'utf8'); } catch { return ''; }
  }

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

  /** Every way a build can end comes through here: its source goes, and its minutes are metered (TRIG-1). */
  async ended(job) {
    this.dropSource(job);
    if (!this.onComplete) return;
    try { await this.onComplete(job); } catch (err) { this.appendLog(job, `\n[gitcha] after-job step failed: ${err.message}\n`); }
  }

  /** Wait for a job to finish (used for function invocations). */
  awaitResult(job, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.done.delete(job.id);
        this.queue = this.queue.filter((id) => id !== job.id);
        if (['queued', 'running'].includes(job.status)) Object.assign(job, { status: 'timed_out', finishedAt: this.clock(), tokenHash: null });
        // Nobody will read this call again: do not keep it, or the caller's body, in memory (FN-1).
        if (job.kind === 'fn') { this.live.delete(job.id); if (job.spec?.request) job.spec = { ...job.spec, request: { ...job.spec.request, body: '' } }; }
        resolve(job);
      }, ms);
      this.done.set(job.id, (j) => { clearTimeout(t); resolve(j); });
    });
  }

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

  view(j) {
    const { tokenHash, log, spec, pipelineSha, ...rest } = j;
    return rest;
  }
}
