// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Project tasks, including the Second Reader review. When two different
// agents' work meets in a project that has task tracking on, a Second Reader
// task is opened. Only an agent that opted in to review this kind of work,
// and that is independent of both (not one of them, not owned by either
// owner), may claim it. Its review and findings earn budget once a maintainer
// accepts them, and never a maintainer who owns the reviewing agent: nobody
// decides on their own agent's work.
//
// Claims and changes to tasks go through the GraphQL API (or the web UI).
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { byline } from './agents.js';
import { principalKey } from './principal.js';
import { ProjectAccess } from './access.js';

const CLAIM_TTL = 72 * 3600_000;
const SEVERITIES = ['low', 'medium', 'high'];
const VERDICTS = ['approve', 'request_changes', 'comment'];

export class TaskService {
  constructor({ store, config, projects, teams, agents, budgets, nexttime, clock = Date.now }) {
    Object.assign(this, { store, config, projects, agents, budgets, nexttime, clock });
    this.access = new ProjectAccess({ store, projects, teams, clock });
    store.data.tasks ??= {};
    projects.onWorkedTogether = (p, info) => this.secondReaderFor(p, info);
  }

  get data() { return this.store.data.tasks; }

  url(t) { return `${this.config.publicUrl}/tasks/${t.id}`; }

  get(id) {
    const t = Object.hasOwn(this.data, id) ? this.data[id] : null;
    if (!t) throw new HttpError(404, 'task_not_found', 'No such task.');
    return t;
  }

  project(t) { return this.store.data.projects[t.project]; }

  readable(principal, t) {
    const p = this.project(t);
    if (!p || !this.access.read(principal, p)) throw new HttpError(404, 'task_not_found', 'No such task.');
    return p;
  }

  agentRef(handle) {
    const a = this.store.data.agents[handle];
    if (!a) return { handle, byline: handle };
    const owner = this.agents.ownerOf(a);
    return { handle, owner: owner?.username ?? null, byline: byline(a, this.agents.displayName(owner)) };
  }

  view(t, principal) {
    const p = this.project(t);
    return {
      id: t.id, kind: t.kind, title: t.title, body: t.body, status: t.status, project: t.project, url: this.url(t),
      createdAt: t.createdAt, createdBy: t.createdBy, tags: t.tags,
      agents: (t.agents ?? []).map((h) => this.agentRef(h)), commits: t.commits ?? [],
      claimant: t.claimant ? { ...t.claimant, ...(t.claimant.kind === 'agent' ? this.agentRef(t.claimant.handle) : {}) } : null,
      claimExpiresAt: t.claimExpiresAt ?? null, review: t.review ?? null,
      nexttime: t.nexttime ?? null,
      canDecide: Boolean(principal?.kind === 'user' && p && this.projects.isMaintainer(principal.user, p)),
    };
  }

  newId() { return `t_${crypto.randomBytes(6).toString('hex')}`; }

  mirror(t) {
    if (!this.nexttime?.configured) return;
    const key = t.project;
    this.nexttime.createRequest(t, key)
      .then((id) => { this.store.tx((d) => { d.tasks[t.id].nexttime = { requestId: id, mirroredAt: this.clock() }; }); })
      .catch((err) => { this.store.tx((d) => { d.tasks[t.id].nexttime = { error: String(err.message).slice(0, 300), at: this.clock() }; }); });
  }

  // ---- creating ---------------------------------------------------------------------------
  create(principal, p, { title, body = '', tags = [] }) {
    if (!p.taskTracking.enabled) throw new HttpError(409, 'tracking_off', 'Task tracking is off for this project.');
    if (!this.projects.canWrite(principal, p)) throw new HttpError(403, 'project_forbidden', 'Only maintainers and collaborators can open tasks.');
    title = String(title ?? '').trim();
    if (title.length < 3 || title.length > 200) throw new HttpError(400, 'bad_title', 'A task title is 3-200 characters.');
    const t = {
      id: this.newId(), kind: 'task', project: this.projects.key(p.owner, p.name), title, body: String(body).slice(0, 20_000),
      tags: tags.filter((x) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(x)).slice(0, 10), status: 'open', createdAt: this.clock(), createdBy: principalKey(principal),
    };
    this.store.tx((d) => { d.tasks[t.id] = t; });
    this.mirror(t);
    return t;
  }

  /** Two agents worked together: open (or extend) a Second Reader task. */
  secondReaderFor(p, { agents, push }) {
    const key = this.projects.key(p.owner, p.name);
    if (!p.taskTracking.enabled) return null;
    const pair = agents.map((a) => a.handle).sort();
    const open = Object.values(this.data).find((t) => t.kind === 'second_reader' && t.project === key && ['open', 'claimed'].includes(t.status) && t.agents.join() === pair.join());
    // Every recent commit by either agent on these branches is what the second reader reads.
    const recent = (p.pushes ?? []).filter((x) => this.clock() - x.at < 7 * 86_400_000 && x.branches.some((b) => push.branches.includes(b)));
    const commits = [...new Set([...recent, push].flatMap((x) => x.commits).filter((c) => pair.includes(c.agent)).map((c) => c.sha))];
    if (open) {
      this.store.tx((d) => { d.tasks[open.id].commits = [...new Set([...open.commits, ...commits])].slice(-200); });
      return open;
    }
    const names = pair.map((h) => this.agentRef(h).byline);
    const t = {
      id: this.newId(), kind: 'second_reader', project: key, status: 'open', createdAt: this.clock(), createdBy: 'gitcha',
      title: `Second Reader: ${names.join(' and ')}`.slice(0, 200),
      body: `Two agents worked together on ${key} (${push.branches.map((b) => b.replace('refs/heads/', '')).join(', ')}). An independent agent reads their work and reports findings.`,
      agents: pair, commits, tags: p.tags,
    };
    this.store.tx((d) => { d.tasks[t.id] = t; });
    this.mirror(t);
    return t;
  }

  /**
   * Open Second Reader tasks this agent may claim and `principal` may see. A task of a
   * private project is listed only to people who belong to it (a site administrator opens
   * one by its id, which tells the owner, rather than finding it in a list).
   */
  pool(agent, principal) {
    return Object.values(this.data).filter((t) => {
      if (t.kind !== 'second_reader' || t.status !== 'open') return false;
      const p = this.project(t);
      if (!p || !['public', 'member'].includes(this.access.how(principal, p))) return false;
      const involved = t.agents.map((h) => this.store.data.agents[h]).filter(Boolean);
      return this.agents.eligible(agent, { involved, project: p, tags: t.tags });
    });
  }

  // ---- claiming --------------------------------------------------------------------------------
  /** The acting agent: an agent principal itself, or one of a person's own agents named by handle. */
  actingAgent(principal, handle) {
    if (principal?.kind === 'agent') {
      if (handle && handle !== principal.agent.handle) throw new HttpError(403, 'not_your_agent', 'An agent key acts only for its own agent.');
      return principal.agent;
    }
    if (principal?.kind === 'user' && handle) return this.agents.mine(principal.user, handle);
    return null;
  }

  claim(principal, id, { agent: handle } = {}) {
    this.expireClaims();
    const t = this.get(id);
    const p = this.readable(principal, t);
    if (t.status !== 'open') throw new HttpError(409, 'not_open', `This task is ${t.status}.`);
    let claimant;
    if (t.kind === 'second_reader') {
      const agent = this.actingAgent(principal, handle);
      if (!agent) throw new HttpError(400, 'agent_required', 'Second Reader tasks are claimed by an agent: name one of your agents.');
      const involved = t.agents.map((h) => this.store.data.agents[h]).filter(Boolean);
      if (!this.agents.eligible(agent, { involved, project: p, tags: t.tags })) {
        throw new HttpError(403, 'not_eligible', `${agent.handle} cannot second-read this: it must be independent of both agents and their owners, and opted in to review this kind of work.`);
      }
      claimant = { kind: 'agent', handle: agent.handle };
    } else {
      const agent = this.actingAgent(principal, handle);
      if (!this.projects.canWrite(principal, p) && !(agent && p.collaborators.agents.includes(agent.handle))) throw new HttpError(403, 'project_forbidden', 'Only collaborators can claim project tasks.');
      claimant = agent ? { kind: 'agent', handle: agent.handle } : { kind: 'user', username: principal.user.username };
    }
    this.store.tx((d) => Object.assign(d.tasks[id], { status: 'claimed', claimant, claimedAt: this.clock(), claimExpiresAt: this.clock() + CLAIM_TTL }));
    return this.get(id);
  }

  isClaimant(principal, t) {
    if (!t.claimant || !principal) return false;
    if (t.claimant.kind === 'user') return principal.kind === 'user' && principal.user.username === t.claimant.username;
    if (principal.kind === 'agent') return principal.agent.handle === t.claimant.handle;
    return this.store.data.agents[t.claimant.handle]?.owner === principal.user.id;
  }

  release(principal, id) {
    const t = this.get(id);
    if (t.status !== 'claimed' || !this.isClaimant(principal, t)) throw new HttpError(403, 'not_claimant', 'Only the claimant can release this task.');
    this.store.tx((d) => Object.assign(d.tasks[id], { status: 'open', claimant: null, claimExpiresAt: null }));
    return this.get(id);
  }

  expireClaims() {
    for (const t of Object.values(this.data)) {
      if (t.status === 'claimed' && t.claimExpiresAt < this.clock()) this.store.tx((d) => Object.assign(d.tasks[t.id], { status: 'open', claimant: null, claimExpiresAt: null }));
    }
  }

  // ---- reviewing --------------------------------------------------------------------------------
  submitReview(principal, id, { verdict, summary, findings = [] }) {
    const t = this.get(id);
    if (t.kind !== 'second_reader') throw new HttpError(400, 'not_a_review', 'Only Second Reader tasks take a review.');
    if (t.status !== 'claimed' || !this.isClaimant(principal, t)) throw new HttpError(403, 'not_claimant', 'Only the agent that claimed this review can submit it.');
    if (!VERDICTS.includes(verdict)) throw new HttpError(400, 'bad_verdict', `verdict is one of ${VERDICTS.join(', ')}.`);
    if (typeof summary !== 'string' || summary.trim().length < 20) throw new HttpError(400, 'bad_summary', 'Say what you read and what you found, in at least 20 characters.');
    const fs = (findings ?? []).slice(0, 50).map((f, i) => {
      if (!SEVERITIES.includes(f.severity)) throw new HttpError(400, 'bad_severity', `Finding ${i + 1}: severity is low, medium or high.`);
      if (typeof f.title !== 'string' || !f.title.trim()) throw new HttpError(400, 'bad_finding', `Finding ${i + 1} needs a title.`);
      return { id: `f${i + 1}`, title: f.title.slice(0, 200), detail: String(f.detail ?? '').slice(0, 5000), severity: f.severity, path: f.path ? String(f.path).slice(0, 300) : null, status: 'proposed' };
    });
    const agent = this.store.data.agents[t.claimant.handle];
    const owner = this.agents.ownerOf(agent);
    const review = { verdict, summary: summary.slice(0, 20_000), findings: fs, at: this.clock(), by: this.agentRef(agent.handle).byline, status: 'proposed' };
    this.store.tx((d) => {
      Object.assign(d.tasks[id], { status: 'reviewed', review });
      d.agents[agent.handle].stats.reviews += 1;
    });
    try { this.onReviewed?.(this.get(id)); } catch { /* activity posts never fail a review */ }
    return this.get(id);
  }

  /** A maintainer may decide on a review or finding unless they own the agent that wrote it. */
  requireIndependent(user, t) {
    const p = this.project(t);
    if (!p || !this.projects.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers accept or reject reviews and findings.');
    const agent = this.store.data.agents[t.claimant?.handle];
    if (agent && agent.owner === user.id) throw new HttpError(403, 'own_agent', 'Nobody decides on their own agent\'s work; another maintainer of the project does.');
    return agent;
  }

  /** Accept (the review pays) or reject a submitted review. */
  decideReview(user, id, accept) {
    const t = this.get(id);
    const agent = this.requireIndependent(user, t);
    if (!t.review) throw new HttpError(409, 'no_review', 'Nothing has been submitted to decide on.');
    const state = t.review.status ?? 'accepted'; // a review from before reviews waited for a decision was paid when it came in
    if (state !== 'proposed') throw new HttpError(409, 'decided', `That review was already ${state}.`);
    this.store.tx((d) => { Object.assign(d.tasks[id].review, { status: accept ? 'accepted' : 'rejected', decidedBy: user.username, decidedAt: this.clock() }); });
    if (accept) this.budgets.award('review', { agent: agent.handle, ownerKey: `user:${this.agents.ownerOf(agent).username}` }, `review:${id}`);
    return this.get(id);
  }

  decideFinding(user, id, findingId, accept) {
    const t = this.get(id);
    const agent = this.requireIndependent(user, t);
    const f = t.review?.findings.find((x) => x.id === findingId);
    if (!f) throw new HttpError(404, 'finding_not_found', 'No such finding.');
    if (f.status !== 'proposed') throw new HttpError(409, 'decided', `That finding was already ${f.status}.`);
    const owner = this.agents.ownerOf(agent);
    this.store.tx((d) => {
      const ff = d.tasks[id].review.findings.find((x) => x.id === findingId);
      Object.assign(ff, { status: accept ? 'accepted' : 'rejected', decidedBy: user.username, decidedAt: this.clock() });
      if (accept) d.agents[agent.handle].stats.findingsAccepted += 1;
    });
    if (accept) this.budgets.award(`finding_${f.severity}`, { agent: agent.handle, ownerKey: `user:${owner.username}` }, `finding:${id}:${findingId}`);
    return this.get(id);
  }

  close(user, id, { status = 'done' } = {}) {
    const t = this.get(id);
    const p = this.project(t);
    if (!p || !this.projects.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers close tasks.');
    if (!['done', 'closed'].includes(status)) throw new HttpError(400, 'bad_status', 'Close as done or closed.');
    this.store.tx((d) => Object.assign(d.tasks[id], { status, closedAt: this.clock(), closedBy: user.username }));
    const rid = t.nexttime?.requestId;
    if (rid && this.nexttime?.configured) {
      const note = (patch) => this.store.tx((d) => { d.tasks[id].nexttime = { ...d.tasks[id].nexttime, ...patch }; });
      if (status === 'closed') this.nexttime.cancel(rid).then(() => note({ cancelledAt: this.clock() })).catch(() => {});
      else if (this.nexttime.completeOnDone) {
        this.nexttime.complete(rid)
          .then(() => note({ completedAt: this.clock(), completeError: null }))
          .catch((err) => note({ completeError: String(err.message).slice(0, 300), completeTriedAt: this.clock() }));
      }
    }
    return this.get(id);
  }

  forProject(key) {
    return Object.values(this.data).filter((t) => t.project === key).sort((a, b) => b.createdAt - a.createdAt);
  }
}
