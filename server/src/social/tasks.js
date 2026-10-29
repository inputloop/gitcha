// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Project tasks, including the Second Reader review. When the work of two
// different agents meets in a project that has task tracking on, Gitcha opens
// a Second Reader task. Only an agent that opted in to review this kind of
// work may claim it, and it must be independent of both (not one of them, and
// not owned by either of their owners). Its review and findings earn credits
// once a maintainer accepts them. That maintainer must not own the reviewing
// agent: nobody decides on their own agent's work.
//
// Claims and changes to tasks come through the GraphQL API (or the web pages).
// Tasks live in store.data.tasks. Tasks of public projects may also be copied
// to NextTime (see nexttime.js).
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { byline } from './agents.js';
import { principalKey } from './principal.js';
import { ProjectAccess } from './access.js';

const CLAIM_TTL = 72 * 3600_000; // a claim lasts 72 hours, then the task is open again
const SEVERITIES = ['low', 'medium', 'high'];
const VERDICTS = ['approve', 'request_changes', 'comment'];

/**
 * Opens, claims, reviews and closes tasks. It also hooks into the project service
 * (projects.onWorkedTogether), which calls it after a push where two agents worked together.
 */
export class TaskService {
  constructor({ store, config, projects, teams, agents, budgets, nexttime, clock = Date.now }) {
    Object.assign(this, { store, config, projects, agents, budgets, nexttime, clock });
    this.access = new ProjectAccess({ store, projects, teams, clock });
    this.mirrors = new Map(); // task id -> the NextTime create call that is still running
    store.data.tasks ??= {};
    projects.onWorkedTogether = (p, info) => this.secondReaderFor(p, info);
  }

  get data() { return this.store.data.tasks; }

  url(t) { return `${this.config.publicUrl}/tasks/${t.id}`; }

  /** The task with this id, or a 404. `Object.hasOwn` means a name like "constructor" finds nothing. */
  get(id) {
    const t = Object.hasOwn(this.data, id) ? this.data[id] : null;
    if (!t) throw new HttpError(404, 'task_not_found', 'No such task.');
    return t;
  }

  /** The project a task belongs to. */
  project(t) { return this.store.data.projects[t.project]; }

  /**
   * The task's project, if this caller may read it. If not, a 404, so a private task looks the
   * same as a missing one. Uses access.read, which tells the owners when an administrator reads.
   */
  readable(principal, t) {
    const p = this.project(t);
    if (!p || !this.access.read(principal, p)) throw new HttpError(404, 'task_not_found', 'No such task.');
    return p;
  }

  /** A short view of an agent: handle, owner and byline. An unknown handle still shows its name. */
  agentRef(handle) {
    const a = this.store.data.agents[handle];
    if (!a) return { handle, byline: handle };
    const owner = this.agents.ownerOf(a);
    return { handle, owner: owner?.username ?? null, byline: byline(a, this.agents.displayName(owner)) };
  }

  /** The task as the API and pages show it. `canDecide` says whether the caller is one of the project's maintainers. */
  view(t, principal) {
    const p = this.project(t);
    return {
      id: t.id, kind: t.kind, title: t.title, body: t.body, status: t.status, project: t.project, url: this.url(t),
      createdAt: t.createdAt, createdBy: t.createdBy, tags: t.tags,
      agents: (t.agents ?? []).map((h) => this.agentRef(h)), commits: t.commits ?? [],
      claimant: t.claimant ? { ...t.claimant, ...(t.claimant.kind === 'agent' ? this.agentRef(t.claimant.handle) : {}) } : null,
      claimExpiresAt: t.claimExpiresAt ?? null, review: t.review ?? null,
      nexttime: this.nexttimeView(t, p, principal),
      canDecide: Boolean(principal?.kind === 'user' && p && this.projects.isMaintainer(principal.user, p)),
    };
  }

  newId() { return `t_${crypto.randomBytes(6).toString('hex')}`; }

  /** What a reader sees of the NextTime side. Only the project's maintainers see NextTime's refusal texts; others see `refused: true` (NXT-2). */
  nexttimeView(t, p, principal) {
    if (!t.nexttime) return null;
    if (principal?.kind === 'user' && p && this.projects.isMaintainer(principal.user, p)) return t.nexttime;
    const { error, completeError, ...rest } = t.nexttime;
    return { ...rest, ...(error || completeError ? { refused: true } : {}) };
  }

  /**
   * Copies a task to NextTime as a request. Only tasks of public projects go (NXT-1): the
   * NextTime board is shared, so a private project's titles, bodies and bylines never leave
   * this server. The call runs in the background, and its result (the request id, or the
   * error) is saved on the task.
   */
  mirror(t) {
    if (!this.nexttime?.configured) return;
    if (this.project(t)?.visibility !== 'public') return;
    const call = this.nexttime.createRequest({ ...t, url: this.url(t) }, t.project)
      .then((id) => { this.store.tx((d) => { d.tasks[t.id].nexttime = { requestId: id, mirroredAt: this.clock() }; }); })
      .catch((err) => { this.store.tx((d) => { d.tasks[t.id].nexttime = { error: String(err.message).slice(0, 300), at: this.clock() }; }); })
      .finally(() => this.mirrors.delete(t.id));
    this.mirrors.set(t.id, call);
  }

  /**
   * Tells NextTime how a closed task ended: 'closed' cancels the request, and 'done' completes
   * it (when completing is turned on). It waits until the request exists, and does this only
   * once (NXT-2). A refused complete is noted on the task and not tried again.
   */
  settleNextTime(id) {
    const wait = this.mirrors.get(id);
    if (wait) { wait.then(() => this.settleNextTime(id)); return; } // closed while the create was in flight
    const t = this.get(id);
    const rid = t.nexttime?.requestId;
    if (!rid || !this.nexttime?.configured || t.nexttime.completedAt || t.nexttime.cancelledAt || t.nexttime.completeTriedAt) return;
    const note = (patch) => this.store.tx((d) => { d.tasks[id].nexttime = { ...d.tasks[id].nexttime, ...patch }; });
    if (t.status === 'closed') this.nexttime.cancel(rid).then(() => note({ cancelledAt: this.clock() })).catch(() => {});
    else if (t.status === 'done' && this.nexttime.completeOnDone) {
      this.nexttime.complete(rid)
        .then(() => note({ completedAt: this.clock(), completeError: null }))
        .catch((err) => note({ completeError: String(err.message).slice(0, 300), completeTriedAt: this.clock() }));
    }
  }

  // ---- creating ---------------------------------------------------------------------------
  /** Opens a plain task. Task tracking must be on, and the caller must be able to write to the project. */
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

  /**
   * Two agents worked together in a push: opens a Second Reader task for the pair, or adds the
   * new commits to the one still open or claimed. Returns null when task tracking is off.
   */
  secondReaderFor(p, { agents, push }) {
    const key = this.projects.key(p.owner, p.name);
    if (!p.taskTracking.enabled) return null;
    const pair = agents.map((a) => a.handle).sort();
    const open = Object.values(this.data).find((t) => t.kind === 'second_reader' && t.project === key && ['open', 'claimed'].includes(t.status) && t.agents.join() === pair.join());
    // The second reader reads every commit either agent made in the last 7 days on the branches this push touched.
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
   * Open Second Reader tasks this agent may claim and `principal` may see. A task of a private
   * project is listed only to people who belong to it. A site administrator must open one by
   * its id, which tells the owner, instead of finding it in a list.
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
  /** The acting agent: an agent caller itself, or one of a person's own agents named by handle. An agent key acts only for its own agent. */
  actingAgent(principal, handle) {
    if (principal?.kind === 'agent') {
      if (handle && handle !== principal.agent.handle) throw new HttpError(403, 'not_your_agent', 'An agent key acts only for its own agent.');
      return principal.agent;
    }
    if (principal?.kind === 'user' && handle) return this.agents.mine(principal.user, handle);
    return null;
  }

  /**
   * Claims an open task for 72 hours. A Second Reader task must be claimed by an eligible agent
   * (see AgentService.eligible). A plain task needs write access, or an agent that is one of the
   * project's collaborators. Claims that ran out are opened again first.
   */
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

  /** Is this caller the claimant? For a claim made by an agent, the agent itself or its owner counts. */
  isClaimant(principal, t) {
    if (!t.claimant || !principal) return false;
    if (t.claimant.kind === 'user') return principal.kind === 'user' && principal.user.username === t.claimant.username;
    if (principal.kind === 'agent') return principal.agent.handle === t.claimant.handle;
    return this.store.data.agents[t.claimant.handle]?.owner === principal.user.id;
  }

  /** The claimant gives the task back, and it is open again. */
  release(principal, id) {
    const t = this.get(id);
    if (t.status !== 'claimed' || !this.isClaimant(principal, t)) throw new HttpError(403, 'not_claimant', 'Only the claimant can release this task.');
    this.store.tx((d) => Object.assign(d.tasks[id], { status: 'open', claimant: null, claimExpiresAt: null }));
    return this.get(id);
  }

  /** Opens again every task whose claim has run out. */
  expireClaims() {
    for (const t of Object.values(this.data)) {
      if (t.status === 'claimed' && t.claimExpiresAt < this.clock()) this.store.tx((d) => Object.assign(d.tasks[t.id], { status: 'open', claimant: null, claimExpiresAt: null }));
    }
  }

  // ---- reviewing --------------------------------------------------------------------------------
  /**
   * The claimant hands in a Second Reader review: a verdict, a summary of at least 20 characters,
   * and up to 50 findings. Nothing is paid yet; the review waits for a maintainer to decide.
   * The agent's review count goes up now.
   */
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

  /** A maintainer may decide on a review or finding, unless they own the agent that wrote it. Returns that agent. */
  requireIndependent(user, t) {
    const p = this.project(t);
    if (!p || !this.projects.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers accept or reject reviews and findings.');
    const agent = this.store.data.agents[t.claimant?.handle];
    if (agent && agent.owner === user.id) throw new HttpError(403, 'own_agent', 'Nobody decides on their own agent\'s work; another maintainer of the project does.');
    return agent;
  }

  /** Accepts (then the review pays) or rejects a submitted review. Each review is decided only once. */
  decideReview(user, id, accept) {
    const t = this.get(id);
    const agent = this.requireIndependent(user, t);
    if (!t.review) throw new HttpError(409, 'no_review', 'Nothing has been submitted to decide on.');
    const state = t.review.status ?? 'accepted'; // a review from before reviews waited for a decision was already paid when it came in
    if (state !== 'proposed') throw new HttpError(409, 'decided', `That review was already ${state}.`);
    this.store.tx((d) => { Object.assign(d.tasks[id].review, { status: accept ? 'accepted' : 'rejected', decidedBy: user.username, decidedAt: this.clock() }); });
    if (accept) this.budgets.award('review', { agent: agent.handle, ownerKey: `user:${this.agents.ownerOf(agent).username}` }, `review:${id}`);
    return this.get(id);
  }

  /** Accepts or rejects one finding, once. An accepted finding pays by its severity and counts in the agent's stats. */
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

  /** A maintainer closes a task as 'done' or 'closed', and NextTime is told. */
  close(user, id, { status = 'done' } = {}) {
    const t = this.get(id);
    const p = this.project(t);
    if (!p || !this.projects.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers close tasks.');
    if (!['done', 'closed'].includes(status)) throw new HttpError(400, 'bad_status', 'Close as done or closed.');
    if (['done', 'closed'].includes(t.status)) return t; // already finished: a second close changes nothing and tells NextTime nothing
    this.store.tx((d) => Object.assign(d.tasks[id], { status, closedAt: this.clock(), closedBy: user.username }));
    this.settleNextTime(id);
    return this.get(id);
  }

  /** All tasks of one project, newest first. */
  forProject(key) {
    return Object.values(this.data).filter((t) => t.project === key).sort((a, b) => b.createdAt - a.createdAt);
  }
}
