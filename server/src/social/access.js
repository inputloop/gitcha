// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// How someone may read a project, and the trace left when a site administrator
// does it by that power alone. Private projects answer 404 to outsiders, and an
// administrator is not a member: the owner is told each time one reads theirs.
const HOUR = 3600_000;

export class ProjectAccess {
  constructor({ store, projects, teams, clock = Date.now }) {
    Object.assign(this, { store, projects, teams, clock });
    this.told = new Map(); // "admin|project" -> when the owner was last told (noise control; the audit rows are the record)
  }

  /** 'public', 'member' (owner, team member, collaborator, or an agent of one), 'admin' (the role alone) or null. */
  how(principal, p) {
    if (!this.projects.canRead(principal, p)) return null;
    if (p.visibility === 'public') return 'public';
    const u = principal?.kind === 'user' ? principal.user : null;
    if (u?.role === 'admin' && !this.projects.isMember(u, p) && !p.collaborators.users.includes(u.username)) return 'admin';
    return 'member';
  }

  /** Like `how`, and when the answer is 'admin' tell the project's owners (once an hour per administrator and project). */
  read(principal, p) {
    const how = this.how(principal, p);
    if (how === 'admin') this.tell(principal.user, p);
    return how;
  }

  owners(p) {
    if (p.owner.type === 'user') return [this.store.userByName(p.owner.name)].filter(Boolean);
    const team = this.store.team(p.owner.name);
    return team ? Object.keys(team.members).map((id) => this.store.userById(id)).filter((u) => u && this.teams.has(team, u, 'maintainer')) : [];
  }

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
