// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Decides how someone may read a project. It also leaves a record when a site
// administrator reads a project only because of their admin role. Outsiders get
// a 404 for a private project. An administrator does not count as a member, so
// the owner is told each time an administrator reads their project.
// TaskService (tasks.js) makes one of these, and the GraphQL API and the web
// pages reach it as `tasks.access`.
const HOUR = 3600_000;

export class ProjectAccess {
  constructor({ store, projects, teams, clock = Date.now }) {
    Object.assign(this, { store, projects, teams, clock });
    this.told = new Map(); // "admin|project" -> when the owner was last told. This only keeps the noise down; the audit rows are the real record.
  }

  /**
   * How this caller may read project `p`: 'public', 'member' (owner, team member,
   * collaborator, or an agent of one), 'admin' (only through the admin role) or
   * null (not at all). It tells nobody; use `read` when the caller really reads.
   */
  how(principal, p) {
    if (!this.projects.canRead(principal, p)) return null;
    if (p.visibility === 'public') return 'public';
    const u = principal?.kind === 'user' ? principal.user : null;
    if (u?.role === 'admin' && !this.projects.isMember(u, p) && !p.collaborators.users.includes(u.username)) return 'admin';
    return 'member';
  }

  /** Gives the same answer as `how`. When the answer is 'admin', it also tells the project's owners (at most once an hour for each administrator and project). */
  read(principal, p) {
    const how = this.how(principal, p);
    if (how === 'admin') this.tell(principal.user, p);
    return how;
  }

  /** The people to tell about an admin read: the owning user, or the members of the owning team that `teams.has` counts as maintainers. */
  owners(p) {
    if (p.owner.type === 'user') return [this.store.userByName(p.owner.name)].filter(Boolean);
    const team = this.store.team(p.owner.name);
    return team ? Object.keys(team.members).map((id) => this.store.userById(id)).filter((u) => u && this.teams.has(team, u, 'maintainer')) : [];
  }

  /** Writes a 'project.admin_read' audit row for each owner, unless this admin was already reported for this project in the last hour. */
  tell(admin, p) {
    const key = `${admin.id}|${this.projects.key(p.owner, p.name)}`;
    if (this.clock() - (this.told.get(key) ?? -Infinity) < HOUR) return;
    this.told.set(key, this.clock());
    const project = this.projects.key(p.owner, p.name);
    this.store.tx(() => {
      for (const o of this.owners(p)) this.store.audit({ userId: o.id, event: 'project.admin_read', project, by: admin.username, name: `${project} read by administrator ${admin.username}` });
    });
  }
}
