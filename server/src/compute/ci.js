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
export function pipelineFromTarball(tarball, opts) {
  const files = new Map(unpackFiles(tarball).map((f) => [f.path, f.data]));
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
      found = pipelineFromTarball(tarball, { defaultImage: this.config.compute.defaultImage, maxTimeoutMs: this.config.compute.maxJobMs });
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
    if (!sandboxAgent || paidByPlan) this.billing?.check(ownerKey(o), 'build_minutes');
    const sourceSha = sha256(tarball);
    this.store.writeBlob(sourceSha, tarball);
    const job = this.jobs.enqueue({
      kind: 'ci', owner: o, createdBy: user.username, trigger, sourceSha, pipelineFile: found.file,
      spec: { pipeline: found.pipeline }, timeoutMs: found.pipeline.timeoutMs, deploy: found.pipeline.deploy, deployAllowedBy: found.pipeline.deploy ? user.username : null, deployTarget,
      sandboxAgent, paidByBudget: Boolean(sandboxAgent && !paidByPlan),
    });
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'ci.queued', ip, job: job.id, owner: ownerKey(o), trigger }));
    return this.jobs.view(job);
  }

  /** Called after a package is published: build it if its pipeline asks to run on publish. */
  onPublish(user, pkg, tarball, ip) {
    let found;
    try { found = pipelineFromTarball(tarball, { defaultImage: this.config.compute.defaultImage, maxTimeoutMs: this.config.compute.maxJobMs }); } catch { return null; }
    if (!found?.pipeline.on.includes('publish')) return null;
    const owner = pkg.team ? { type: 'team', name: pkg.team } : { type: 'user', name: user.username };
    try {
      return this.run(user, { tarball, owner, trigger: `publish:${pkg.name}@${pkg.version}` }, ip);
    } catch {
      return null; // a broken pipeline never blocks a publish; the user can run it by hand to see why
    }
  }

  async afterJob(job) {
    if (job.kind !== 'ci') return;
    if (job.startedAt) {
      const minutes = Math.max(1, Math.ceil(((job.finishedAt ?? this.clock()) - job.startedAt) / 60_000));
      if (job.paidByBudget) {
        // Sandbox minutes come out of the agent's earned budget (it may go to zero, not below).
        const bal = this.budgets?.balance(`agent:${job.sandboxAgent}`) ?? 0;
        if (bal > 0) this.budgets.entry(`agent:${job.sandboxAgent}`, -Math.min(minutes, bal), 'sandbox_minutes', `job:${job.id}`);
      } else {
        this.billing?.record(ownerKey(job.owner), 'build_minutes', minutes);
      }
    }
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
