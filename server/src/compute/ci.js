// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// CI: build a source tarball with the steps in its pipeline file, on a runner,
// and optionally publish the result to a hosted site.
import { HttpError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { unpackFiles, packFiles } from '../../../extension/lib/tar.js';
import { normalizePipeline, pipelineFromOrg, pipelineFromTopoForge } from './formats.js';
import { ownerKey } from './jobs.js';

export const PIPELINE_FILES = ['gitcha-ci.json', 'gitcha-ci.org', 'gitcha-ci.topoforge.json'];

/** Find and compile the pipeline in a source tarball (null when there is none). */
export function pipelineFromTarball(tarball, { maxUnpackedBytes = 100 * 1024 * 1024, ...opts } = {}) {
  const files = new Map(unpackFiles(tarball, { maxBytes: maxUnpackedBytes }).map((f) => [f.path, f.data]));
  const found = PIPELINE_FILES.find((f) => files.has(f));
  if (!found) return null;
  const text = files.get(found).toString('utf8');
  let raw;
  if (found.endsWith('.org')) raw = pipelineFromOrg(text);
  else {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'bad_spec', `${found} is not valid JSON.`); }
    raw = found.includes('topoforge') ? pipelineFromTopoForge(parsed) : parsed;
  }
  return { file: found, pipeline: normalizePipeline(raw, opts) };
}

export class CiService {
  constructor({ store, config, teams, sites, jobs, billing, budgets, clock = Date.now }) {
    Object.assign(this, { store, config, teams, sites, jobs, billing, budgets, clock });
    jobs.onComplete = (job) => this.afterJob(job);
    // A build that was running when the server stopped (the job service failed it just now) is still owed its metering and
    // its refund. The downtime is not build time: at most the build's own time limit counts.
    for (const id of jobs.restarted ?? []) {
      const j = store.data.jobs[id];
      if (j?.kind === 'ci') this.meter(j, Math.ceil(j.timeoutMs / 60_000));
    }
  }

  ownerFor(user, team) {
    if (!team) return { type: 'user', name: user.username };
    const t = this.teams.get(team);
    this.teams.require(t, user, 'maintainer');
    return { type: 'team', name: t.name };
  }

  canSee(user, job) {
    if (job.owner.type === 'user') return job.owner.name === user.username || user.role === 'admin';
    const t = this.store.team(job.owner.name);
    return user.role === 'admin' || Boolean(t && this.teams.has(t, user, 'member'));
  }

  canManage(user, job) {
    if (job.owner.type === 'user') return job.owner.name === user.username;
    const t = this.store.team(job.owner.name);
    return Boolean(t && this.teams.has(t, user, 'maintainer'));
  }

  /** Queue a build. `trigger` is "manual" or "publish:<pkg>@<version>". */
  run(user, { tarball, team, owner, trigger = 'manual', sandboxAgent = null, paidByPlan = true }, ip) {
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No source tarball was sent.');
    if (tarball.length > this.config.maxPackageBytes) throw new HttpError(413, 'too_large', 'Source is too large.');
    let found;
    try {
      found = pipelineFromTarball(tarball, { defaultImage: this.config.compute.defaultImage, maxTimeoutMs: this.config.compute.maxJobMs, maxUnpackedBytes: 4 * this.config.maxPackageBytes });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'bad_tarball', `Invalid source tarball: ${err.message}`);
    }
    if (!found) throw new HttpError(400, 'no_pipeline', `No pipeline file found. Add one of: ${PIPELINE_FILES.join(', ')}.`);
    const o = owner ?? this.ownerFor(user, team);
    // Permission to deploy is decided now, by whoever started the build.
    if (found.pipeline.deploy && sandboxAgent) throw new HttpError(403, 'sandbox_no_deploy', 'Sandbox runs cannot deploy sites; a person deploys.');
    let deployTarget;
    if (found.pipeline.deploy) {
      const site = this.sites.get(found.pipeline.deploy.site);
      if (!this.sites.canManage(user, site)) throw new HttpError(403, 'site_forbidden', `You cannot deploy to "${site.name}".`);
      deployTarget = this.sites.identity(site); // the site as it is now; a name made again later is another site
    }
    // One owner's builds waiting or running are bounded before anything is stored (LIM-2).
    this.jobs.assertRoom(o);
    // The plan's minutes are spent when a build ends, so builds still waiting or running count at their timeouts (QUOTA-1).
    if (!sandboxAgent || paidByPlan) {
      this.billing?.check(ownerKey(o), 'build_minutes', (this.billing.usage(ownerKey(o)).build_minutes ?? 0) + this.jobs.reservedMinutes(o));
    }
    // A sandbox agent's budget is held for the whole time limit now and the unused part is given back when the build ends
    // (BUD-2): the limit is cut to the credits it has, one credit a minute, so the hold always covers what the build can use.
    const budgetKey = sandboxAgent && !paidByPlan ? `agent:${sandboxAgent}` : null;
    let timeoutMs = found.pipeline.timeoutMs;
    let reservedMinutes = 0;
    let cutTo = null;
    if (budgetKey) {
      const credits = Math.floor(this.budgets?.balance(budgetKey) ?? 0);
      reservedMinutes = Math.min(Math.ceil(timeoutMs / 60_000), credits);
      if (reservedMinutes < 1) throw new HttpError(402, 'budget_exhausted', `${sandboxAgent} has no sandbox credits left to hold for a build.`);
      if (reservedMinutes * 60_000 < timeoutMs) { timeoutMs = reservedMinutes * 60_000; cutTo = reservedMinutes; }
    }
    // The pipeline is stored once, in a blob; the source in a file of its own, so it can go when the build ends.
    const sourceKey = this.jobs.keepSource(tarball);
    const pipelineJson = Buffer.from(JSON.stringify(found.pipeline));
    const pipelineSha = sha256(pipelineJson);
    this.store.writeBlob(pipelineSha, pipelineJson);
    const job = this.jobs.enqueue({
      kind: 'ci', owner: o, createdBy: user.username, trigger, sourceSha: sourceKey, ownSource: true, pipelineFile: found.file,
      pipelineSha, timeoutMs, deploy: found.pipeline.deploy, deployAllowedBy: found.pipeline.deploy ? user.username : null, deployTarget,
      sandboxAgent, paidByBudget: Boolean(budgetKey), reservedMinutes,
    });
    // The hold is its own ledger entry per build (an entry with the same ref is skipped, so the ref carries the job).
    if (budgetKey) this.budgets.entry(budgetKey, -reservedMinutes, 'sandbox_reserve', `job:${job.id}:reserve`);
    if (cutTo) this.jobs.appendLog(job, `[gitcha] time limit cut to ${cutTo} minute${cutTo === 1 ? '' : 's'}: that is the sandbox credit ${sandboxAgent} had to hold\n`);
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'ci.queued', ip, job: job.id, owner: ownerKey(o), trigger }));
    return this.jobs.view(job);
  }

  /** Called after a package is published: build it if its pipeline asks to run on publish. */
  onPublish(user, pkg, tarball, ip) {
    let found;
    try { found = pipelineFromTarball(tarball, { defaultImage: this.config.compute.defaultImage, maxTimeoutMs: this.config.compute.maxJobMs, maxUnpackedBytes: 4 * this.config.maxPackageBytes }); } catch { return null; }
    if (!found?.pipeline.on.includes('publish')) return null;
    const owner = pkg.team ? { type: 'team', name: pkg.team } : { type: 'user', name: user.username };
    try {
      return this.run(user, { tarball, owner, trigger: `publish:${pkg.name}@${pkg.version}` }, ip);
    } catch {
      return null; // a broken pipeline never blocks a publish; the user can run it by hand to see why
    }
  }

  /** What a build used: plan minutes recorded, or the agent's held credits settled. Once per build, never more than `atMost` minutes. */
  meter(job, atMost = Infinity) {
    if (job.settled) return;
    this.store.tx((d) => { if (d.jobs[job.id]) d.jobs[job.id].settled = true; });
    const minutes = job.startedAt ? Math.min(atMost, Math.max(1, Math.ceil(((job.finishedAt ?? this.clock()) - job.startedAt) / 60_000))) : 0;
    if (job.paidByBudget) {
      const key = `agent:${job.sandboxAgent}`;
      const reserved = job.reservedMinutes ?? 0;
      if (reserved) {
        // Give back what the reservation did not use; a build that ran over pays the difference, as far as the budget goes.
        const refund = reserved - Math.min(minutes, reserved);
        if (refund > 0) this.budgets.entry(key, refund, 'sandbox_refund', `job:${job.id}`);
        const bal = this.budgets?.balance(key) ?? 0;
        if (minutes > reserved && bal > 0) this.budgets.entry(key, -Math.min(minutes - reserved, bal), 'sandbox_minutes', `job:${job.id}`);
      } else if (minutes) {
        // Queued before reservations existed: charged at the end, as before (it may go to zero, not below).
        const bal = this.budgets?.balance(key) ?? 0;
        if (bal > 0) this.budgets.entry(key, -Math.min(minutes, bal), 'sandbox_minutes', `job:${job.id}`);
      }
    } else if (minutes) {
      this.billing?.record(ownerKey(job.owner), 'build_minutes', minutes);
    }
  }

  async afterJob(job) {
    if (job.kind !== 'ci') return;
    this.meter(job);
    if (job.status !== 'succeeded' || !job.deploy || !job.deployAllowedBy) return;
    if (!job.artifactSha) {
      this.jobs.appendLog(job, '\n[gitcha] the pipeline asked to deploy but the runner returned no artifacts\n');
      return;
    }
    // The build may have run for an hour: deploy only if the same site is still there and its starter may still publish to it.
    const target = this.store.data.sites[job.deploy.site];
    const starter = this.store.userByName(job.deployAllowedBy);
    const same = target && (job.deployTarget === undefined || this.sites.identity(target) === job.deployTarget);
    if (!same || !starter || starter.status !== 'active' || !this.sites.canManage(starter, target)) {
      this.jobs.appendLog(job, '\n[gitcha] not deployed: the site was removed or changed hands, or the person who started this build can no longer deploy to it\n');
      return;
    }
    // Artifacts come from ordinary tar inside the job: re-pack them into Gitcha's own format.
    const files = unpackFiles(this.store.readBlob(job.artifactSha), { root: '', maxBytes: this.config.hosting.maxSiteBytes });
    const dep = this.sites.deploy(null, job.deploy.site, { tarball: packFiles(files), source: 'ci', jobId: job.id }, 'runner');
    this.store.tx((d) => { d.jobs[job.id].deployed = { site: job.deploy.site, deploy: dep.id }; });
    this.jobs.appendLog(job, `\n[gitcha] deployed to site ${job.deploy.site} as ${dep.id}\n`);
  }

  list(user, { owner } = {}) {
    return Object.values(this.store.data.jobs)
      .filter((j) => j.kind === 'ci' && this.canSee(user, j) && (!owner || ownerKey(j.owner) === owner))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map((j) => this.jobs.view(j));
  }

  get(user, id) {
    const j = this.store.data.jobs[id];
    if (!j || !this.canSee(user, j)) throw new HttpError(404, 'not_found', 'No such job.');
    return j;
  }
}
