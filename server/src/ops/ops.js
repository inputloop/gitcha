// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Operations: tickets and changes, for the people who run this instance
// (C4OK is meant to be their kiosk) and for everyone they serve.
//
// Tickets have a scope:
//   user      anyone with an account: feedback, questions, bugs. Seen by the reporter and staff.
//   tenant    a paying account (a person, or a team as a whole): seen by its members and staff.
//   internal  staff only.
// Staff can add internal notes to any ticket; only staff see them.
//
// Changes (to the live system) are staff-only and move through
//   draft -> submitted -> approved -> scheduled -> in_progress -> done | failed | rolled_back
// with rejected and cancelled as exits. Approval needs a fresh 2FA code; nobody
// approves their own change; high-risk changes need two approvals.
import { HttpError } from '../errors.js';

const SCOPES = ['user', 'tenant', 'internal'];
const KINDS = ['bug', 'feedback', 'question', 'request', 'incident'];
const STATUSES = ['new', 'triaged', 'in_progress', 'waiting', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RISKS = { low: 1, medium: 1, high: 2 };
const CHANGE_FLOW = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'draft', 'cancelled'],
  approved: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['done', 'failed', 'rolled_back'],
  failed: ['rolled_back', 'in_progress'],
};

export const isStaff = (user) => user && (user.role === 'admin' || user.role === 'staff');

export class OpsService {
  constructor({ store, teams, billing, jobs, sites, ring, clock = Date.now }) {
    Object.assign(this, { store, teams, billing, jobs, sites, ring, clock });
    store.data.ops ??= { tickets: {}, changes: {}, seq: { ticket: 0, change: 0 } };
  }

  get d() { return this.store.data.ops; }

  staff(user) {
    if (!isStaff(user)) throw new HttpError(403, 'staff_only', 'Only staff can do this.');
    return user;
  }

  setRole(admin, username, role, ip) {
    if (admin.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only an administrator assigns roles.');
    if (!['user', 'staff', 'admin'].includes(role)) throw new HttpError(400, 'bad_role', 'Role is user, staff or admin.');
    const u = this.store.userByName(username);
    if (!u) throw new HttpError(404, 'user_not_found', `No user "${username}".`);
    if (u.id === admin.id && role !== 'admin') throw new HttpError(409, 'last_admin', 'Ask another administrator to change your own role.');
    this.store.tx((d) => {
      d.users[u.id].role = role;
      this.store.audit({ userId: admin.id, event: 'role.changed', ip, user: u.username, role });
      this.store.audit({ userId: u.id, event: 'role.changed', ip, by: admin.username, role });
    });
    return { username: u.username, role };
  }

  // ---- tickets ------------------------------------------------------------------------------
  /** May this user act within the tenant (a "user:NAME" or "team:NAME" billing account)? */
  inTenant(user, tenant) {
    if (!tenant) return false;
    if (tenant === `user:${user.username}`) return true;
    const m = /^team:(.+)$/.exec(tenant);
    const t = m && this.store.team(m[1]);
    return Boolean(t && this.teams.has(t, user, 'member'));
  }

  canSee(user, t) {
    if (isStaff(user)) return true;
    if (t.scope === 'internal') return false;
    if (t.scope === 'tenant') return this.inTenant(user, t.tenant);
    return t.reporter === `user:${user.username}`;
  }

  file(user, { scope = 'user', kind = 'feedback', title, body, priority = 'normal', tenant, links, via }) {
    if (!SCOPES.includes(scope)) throw new HttpError(400, 'bad_scope', `Scope is ${SCOPES.join(', ')}.`);
    if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_kind', `Kind is ${KINDS.join(', ')}.`);
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'bad_priority', `Priority is ${PRIORITIES.join(', ')}.`);
    if (scope === 'internal') this.staff(user);
    if (scope === 'tenant' && !(this.inTenant(user, tenant) || isStaff(user))) throw new HttpError(403, 'not_in_tenant', `You are not part of ${tenant}.`);
    if (scope !== 'tenant') tenant = null;
    title = String(title ?? '').trim();
    if (title.length < 5 || title.length > 200) throw new HttpError(400, 'bad_title', 'Give the ticket a title of 5-200 characters.');
    // Only staff may raise urgency above normal on someone's behalf; anyone can say it is urgent for them.
    const id = `T-${String(++this.d.seq.ticket).padStart(4, '0')}`;
    const now = this.clock();
    const t = {
      id, scope, kind, title, body: String(body ?? '').slice(0, 20_000), status: 'new', priority, tenant,
      reporter: `user:${user.username}`, assignee: null, createdAt: now, updatedAt: now, links: links ?? {},
      events: [{ at: now, by: user.username, type: 'filed', via: via ?? null }], comments: [],
    };
    this.store.tx((d) => { d.ops.tickets[id] = t; });
    return t;
  }

  ticket(user, id) {
    const t = this.d.tickets[id];
    if (!t || !this.canSee(user, t)) throw new HttpError(404, 'ticket_not_found', 'No such ticket.');
    return t;
  }

  view(user, t) {
    return { ...t, comments: t.comments.filter((c) => !c.internal || isStaff(user)), events: isStaff(user) ? t.events : t.events.filter((e) => e.type !== 'internal_note') };
  }

  comment(user, id, { body, internal = false, via }) {
    const t = this.ticket(user, id);
    if (internal) this.staff(user);
    body = String(body ?? '').trim();
    if (!body) throw new HttpError(400, 'empty', 'Write something.');
    this.store.tx((d) => {
      const x = d.ops.tickets[id];
      x.comments.push({ at: this.clock(), by: user.username, staff: isStaff(user), internal: Boolean(internal), body: body.slice(0, 20_000), via: via ?? null });
      x.updatedAt = this.clock();
      // A reply from the reporter's side reopens a ticket that was waiting on them.
      if (!isStaff(user) && x.status === 'waiting') x.status = 'in_progress';
    });
    return this.ticket(user, t.id);
  }

  update(user, id, { status, priority, assignee, scope, via }) {
    this.staff(user);
    const t = this.ticket(user, id);
    const patch = {};
    if (status !== undefined) { if (!STATUSES.includes(status)) throw new HttpError(400, 'bad_status', `Status is ${STATUSES.join(', ')}.`); patch.status = status; }
    if (priority !== undefined) { if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'bad_priority', 'Bad priority.'); patch.priority = priority; }
    if (assignee !== undefined) {
      if (assignee !== null && !isStaff(this.store.userByName(assignee))) throw new HttpError(400, 'bad_assignee', 'Tickets are assigned to staff.');
      patch.assignee = assignee;
    }
    if (scope !== undefined) { if (!SCOPES.includes(scope)) throw new HttpError(400, 'bad_scope', 'Bad scope.'); patch.scope = scope; }
    this.store.tx((d) => {
      const x = d.ops.tickets[id];
      x.events.push({ at: this.clock(), by: user.username, type: 'updated', changes: patch, via: via ?? null });
      Object.assign(x, patch, { updatedAt: this.clock() });
    });
    return this.ticket(user, t.id);
  }

  tickets(user, { scope, status, tenant, mine, limit = 100 } = {}) {
    return Object.values(this.d.tickets)
      .filter((t) => this.canSee(user, t))
      .filter((t) => (!scope || t.scope === scope) && (!status || t.status === status) && (!tenant || t.tenant === tenant))
      .filter((t) => !mine || t.reporter === `user:${user.username}` || t.assignee === user.username)
      .sort((a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || b.updatedAt - a.updatedAt)
      .slice(0, Math.min(limit, 500));
  }

  // ---- changes ----------------------------------------------------------------------------------
  createChange(user, { title, summary, risk = 'medium', systems = [], plan = '', rollback = '', tickets = [], windowStart, windowEnd, via }) {
    this.staff(user);
    if (!RISKS[risk]) throw new HttpError(400, 'bad_risk', 'Risk is low, medium or high.');
    title = String(title ?? '').trim();
    if (title.length < 5) throw new HttpError(400, 'bad_title', 'Give the change a title of at least 5 characters.');
    const id = `C-${String(++this.d.seq.change).padStart(4, '0')}`;
    const now = this.clock();
    const c = {
      id, title: title.slice(0, 200), summary: String(summary ?? '').slice(0, 20_000), risk, requiredApprovals: RISKS[risk],
      systems: systems.map(String).slice(0, 20), plan: String(plan).slice(0, 20_000), rollback: String(rollback).slice(0, 20_000),
      tickets: tickets.filter((t) => this.d.tickets[t]).slice(0, 50), window: { start: windowStart ?? null, end: windowEnd ?? null },
      status: 'draft', author: user.username, approvals: [], createdAt: now, updatedAt: now,
      events: [{ at: now, by: user.username, type: 'created', via: via ?? null }],
    };
    this.store.tx((d) => { d.ops.changes[id] = c; });
    return c;
  }

  change(user, id) {
    this.staff(user);
    const c = this.d.changes[id];
    if (!c) throw new HttpError(404, 'change_not_found', 'No such change.');
    return c;
  }

  /** Move a change along its flow. `fresh` is true when the caller passed a fresh 2FA check. */
  advance(user, id, to, { note, fresh = false, via } = {}) {
    const c = this.change(user, id);
    if (!(CHANGE_FLOW[c.status] ?? []).includes(to)) throw new HttpError(409, 'bad_transition', `A ${c.status} change cannot become ${to}.`);
    if (to === 'submitted' && (!c.plan.trim() || !c.rollback.trim())) throw new HttpError(400, 'incomplete', 'Write the plan and the rollback before submitting.');
    if (to === 'approved' || to === 'rejected') {
      if (!fresh) throw new HttpError(401, 'mfa_required', 'Approving or rejecting a change needs a fresh authenticator code.', { reason: 'sensitive_action' });
      if (c.author === user.username) throw new HttpError(403, 'own_change', 'Nobody approves or rejects their own change.');
    }
    if (['scheduled', 'in_progress', 'done', 'failed', 'rolled_back'].includes(to) && c.status === 'submitted') throw new HttpError(409, 'not_approved', 'This change is not approved yet.');
    let status = to;
    const approvals = [...c.approvals];
    if (to === 'approved') {
      if (approvals.some((a) => a.by === user.username)) throw new HttpError(409, 'already_approved', 'You already approved this change.');
      approvals.push({ by: user.username, at: this.clock(), note: note ?? null });
      if (approvals.length < c.requiredApprovals) status = 'submitted'; // still waiting for another approver
    }
    this.store.tx((d) => {
      const x = d.ops.changes[id];
      x.events.push({ at: this.clock(), by: user.username, type: to, from: c.status, note: note ?? null, via: via ?? null });
      Object.assign(x, { status, approvals, updatedAt: this.clock() });
      this.store.audit({ userId: user.id, event: `change.${to}`, change: id, status });
    });
    return this.d.changes[id];
  }

  editChange(user, id, patch) {
    const c = this.change(user, id);
    if (c.status !== 'draft') throw new HttpError(409, 'not_draft', 'Only a draft can be edited; send it back to draft first.');
    if (c.author !== user.username) throw new HttpError(403, 'not_author', 'Only the author edits a draft.');
    const allowed = {};
    for (const k of ['title', 'summary', 'plan', 'rollback']) if (patch[k] !== undefined) allowed[k] = String(patch[k]).slice(0, k === 'title' ? 200 : 20_000);
    if (patch.risk !== undefined) { if (!RISKS[patch.risk]) throw new HttpError(400, 'bad_risk', 'Bad risk.'); allowed.risk = patch.risk; allowed.requiredApprovals = RISKS[patch.risk]; }
    this.store.tx((d) => Object.assign(d.ops.changes[id], allowed, { updatedAt: this.clock() }));
    return this.d.changes[id];
  }

  changes(user, { status } = {}) {
    this.staff(user);
    return Object.values(this.d.changes).filter((c) => !status || c.status === status).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---- the kiosk's front page -------------------------------------------------------------------
  summary(user) {
    this.staff(user);
    const tickets = Object.values(this.d.tickets);
    const open = tickets.filter((t) => !['resolved', 'closed'].includes(t.status));
    const count = (xs, k) => xs.reduce((m, x) => ({ ...m, [x[k]]: (m[x[k]] ?? 0) + 1 }), {});
    const jobs = Object.values(this.store.data.jobs ?? {});
    const day = this.clock() - 86_400_000;
    const runners = Object.values(this.store.data.runners ?? {});
    const accounts = Object.entries(this.store.data.billing?.accounts ?? {});
    return {
      at: this.clock(),
      tickets: { open: open.length, byScope: count(open, 'scope'), byPriority: count(open, 'priority'), unassigned: open.filter((t) => !t.assignee).length, urgent: open.filter((t) => t.priority === 'urgent').map((t) => ({ id: t.id, title: t.title, scope: t.scope })) },
      changes: { byStatus: count(Object.values(this.d.changes), 'status'), awaitingApproval: Object.values(this.d.changes).filter((c) => c.status === 'submitted').map((c) => ({ id: c.id, title: c.title, risk: c.risk, approvals: c.approvals.length, required: c.requiredApprovals })) },
      runners: { total: runners.length, online: runners.filter((r) => this.clock() - r.lastSeen < 90_000).length },
      jobs: { queued: jobs.filter((j) => j.status === 'queued').length, running: jobs.filter((j) => j.status === 'running').length, failed24h: jobs.filter((j) => ['failed', 'timed_out'].includes(j.status) && (j.finishedAt ?? 0) > day).length },
      hosting: { sites: Object.keys(this.store.data.sites ?? {}).length, customDomains: Object.values(this.store.data.domains ?? {}).filter((x) => x.verified).length },
      billing: { enabled: this.billing.enabled, active: accounts.filter(([, a]) => a.subscription?.status === 'active').length, pastDue: accounts.filter(([, a]) => a.subscription?.status === 'past_due').map(([k]) => k) },
      ring: { members: this.ring.memberUrls().length, pending: this.ring.pending().length },
      users: Object.keys(this.store.data.users).length, agents: Object.keys(this.store.data.agents ?? {}).length,
    };
  }
}
