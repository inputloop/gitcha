// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Registered agents. Each agent belongs to one person, has a persona name and
// the model it runs on, and signs in the house form:
//
//     NAME (for HUMAN, MODEL)        e.g. Alfred (for Bryant, claude-opus-5-5)
//
// Registering an agent is free, as is adding one to someone else's project
// (the project's maintainers decide) and offering it for peer review.
import { HttpError } from '../errors.js';

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const PERSONA_RE = /^[A-Za-z][A-Za-z0-9 .'-]{0,39}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,59}$/;
// The one form, as inputloop's commit checker reads it: last line "NAME (for PERSON, model)".
export const BYLINE_RE = /^([A-Za-z][A-Za-z0-9 .'-]{0,39}) \(for ([A-Za-z][A-Za-z0-9 .'-]{0,39})(?:[,;] ([a-z0-9][a-z0-9.-]{0,59}))?\)$/;

export function byline(agent, ownerName) {
  return `${agent.name} (for ${ownerName}, ${agent.model})`;
}

/** The byline on the last non-empty line of a commit message, if any. */
export function parseByline(message) {
  const last = String(message ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const m = BYLINE_RE.exec(last);
  return m ? { name: m[1], forName: m[2], model: m[3] ?? null } : null;
}

const cleanList = (v, re, n = 50) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase()).filter((x) => re.test(x)))].slice(0, n);

export class AgentService {
  constructor({ store, clock = Date.now }) {
    Object.assign(this, { store, clock });
    store.data.agents ??= {};
  }

  get data() { return this.store.data.agents; }

  displayName(user) { return user?.profile?.displayName || user?.username || 'someone'; }

  register(user, { handle, name, model, description = '' }, ip) {
    handle = String(handle ?? '').trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'bad_handle', 'Agent handles are 3-32 lowercase letters, digits, "-" or "_".');
    if (this.store.nameInUse(handle)) throw new HttpError(409, 'handle_taken', `"${handle}" is already a user, team or agent.`);
    if (!PERSONA_RE.test(String(name ?? ''))) throw new HttpError(400, 'bad_name', 'The persona name starts with a letter and has at most 40 characters (e.g. Alfred).');
    if (!MODEL_RE.test(String(model ?? ''))) throw new HttpError(400, 'bad_model', 'Give the model as its identifier, lowercase (e.g. claude-opus-5-5).');
    const agent = {
      handle, name, model, description: String(description).slice(0, 500), owner: user.id, createdAt: this.clock(),
      reviewPrefs: { enabled: false, anything: false, projects: [], people: [], teams: [], tags: [] },
      stats: { reviews: 0, findingsAccepted: 0, commits: 0 },
    };
    this.store.tx((d) => {
      d.agents[handle] = agent;
      this.store.audit({ userId: user.id, event: 'agent.registered', ip, agent: handle, model });
    });
    return this.view(agent, { owner: true });
  }

  get(handle) {
    const a = this.find(handle);
    if (!a) throw new HttpError(404, 'agent_not_found', `No agent "${handle}".`);
    return a;
  }

  /** The agent with this handle, or null. */
  find(handle) {
    const key = String(handle ?? '').toLowerCase();
    return Object.hasOwn(this.data, key) ? this.data[key] : null;
  }

  /** One of this user's own agents. */
  mine(user, handle) {
    const a = this.get(handle);
    if (a.owner !== user.id) throw new HttpError(403, 'not_your_agent', `${a.handle} belongs to someone else.`);
    return a;
  }

  ownerOf(agent) { return this.store.userById(agent.owner); }

  /**
   * The agent as a reader sees it. The owner gets the preferences and the totals; anyone else gets
   * the two review flags (a project name typed there may be a private one) and counters without
   * private work. Callers say `{ owner: true }`; the default is the stranger's view.
   */
  view(a, { owner: isOwner = false } = {}) {
    const owner = this.ownerOf(a);
    const prefs = a.reviewPrefs;
    return {
      handle: a.handle, name: a.name, model: a.model, description: a.description, createdAt: a.createdAt,
      owner: owner?.username ?? null, byline: byline(a, this.displayName(owner)),
      reviewPrefs: isOwner ? prefs : { enabled: prefs.enabled, anything: prefs.anything, projects: [], people: [], teams: [], tags: [] },
      stats: isOwner ? a.stats : this.publicStats(a),
    };
  }

  /**
   * The totals less the work done in projects that are not public: reviews and accepted findings from
   * tasks, commits from the pushes the project kept (its last 200, so a very old private push may not
   * be taken off; that errs towards a number that is too high, never towards a name).
   */
  publicStats(a) {
    const projects = this.store.data.projects ?? {};
    const hidden = { reviews: 0, findingsAccepted: 0, commits: 0 };
    for (const t of Object.values(this.store.data.tasks ?? {})) {
      if (t.claimant?.handle !== a.handle || !t.review || projects[t.project]?.visibility === 'public') continue;
      hidden.reviews += 1;
      hidden.findingsAccepted += t.review.findings.filter((f) => f.status === 'accepted').length;
    }
    for (const p of Object.values(projects)) {
      if (p.visibility === 'public') continue;
      for (const push of p.pushes ?? []) hidden.commits += push.commits.filter((c) => c.agent === a.handle).length;
    }
    const s = a.stats;
    return { reviews: Math.max(0, s.reviews - hidden.reviews), findingsAccepted: Math.max(0, s.findingsAccepted - hidden.findingsAccepted), commits: Math.max(0, s.commits - hidden.commits) };
  }

  forOwner(userId) { return Object.values(this.data).filter((a) => a.owner === userId); }

  setReviewPrefs(user, handle, prefs, ip) {
    const a = this.mine(user, handle);
    const next = {
      enabled: Boolean(prefs.enabled ?? true), anything: Boolean(prefs.anything),
      projects: cleanList(prefs.projects, /^@?[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/),
      people: cleanList(prefs.people, /^[a-z0-9][a-z0-9_-]{2,31}$/),
      teams: cleanList(prefs.teams, /^[a-z0-9][a-z0-9_-]{1,31}$/),
      tags: cleanList(prefs.tags, /^[a-z0-9][a-z0-9-]{0,39}$/),
    };
    this.store.tx((d) => {
      d.agents[a.handle].reviewPrefs = next;
      this.store.audit({ userId: user.id, event: 'agent.review_prefs', ip, agent: a.handle, anything: next.anything });
    });
    return this.view(this.data[a.handle], { owner: true });
  }

  /**
   * Find a registered agent named in a byline (persona name + owner display name or username).
   * A username always wins over a display name, and a display name that two people share names
   * nobody, so nobody can make a stranger's byline point at their own agent (SOC-1).
   */
  fromByline(b) {
    if (!b) return null;
    const want = b.forName.toLowerCase();
    const named = Object.values(this.data).filter((a) => a.name.toLowerCase() === b.name.toLowerCase());
    const byUser = named.find((a) => this.ownerOf(a)?.username.toLowerCase() === want);
    if (byUser) return byUser;
    const byDisplay = named.filter((a) => { const o = this.ownerOf(a); return o && this.displayName(o).toLowerCase() === want; });
    return byDisplay.length === 1 ? byDisplay[0] : null;
  }

  /**
   * May this agent second-read work done by `involved` agents on `project`?
   * Independence: not one of them, and not owned by any of their owners.
   */
  eligible(agent, { involved, project, tags = [] }) {
    const p = agent.reviewPrefs;
    if (!p.enabled) return false;
    if (involved.some((x) => x.handle === agent.handle || x.owner === agent.owner)) return false;
    if (p.anything) return true;
    const pkey = `${project.owner.type === 'team' ? '@' : ''}${project.owner.name}/${project.name}`;
    if (p.projects.includes(pkey)) return true;
    if (project.owner.type === 'team' && p.teams.includes(project.owner.name)) return true;
    const people = [project.owner.type === 'user' ? project.owner.name : null, ...involved.map((x) => this.ownerOf(x)?.username)].filter(Boolean);
    if (people.some((u) => p.people.includes(u))) return true;
    return [...tags, ...(project.tags ?? [])].some((t) => p.tags.includes(t));
  }
}
