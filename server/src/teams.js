// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Teams: groups of users that own packages together. Teams live in the store's `teams` collection,
// keyed by their lowercase name, and each lists its members and their roles. Roles, highest first:
//   owner      manage members and roles, delete the team, plus everything below
//   maintainer publish, yank and transfer packages owned by the team
//   member     read the team's private packages
import { HttpError } from './errors.js';

export const ROLES = ['member', 'maintainer', 'owner']; // lowest to highest
// 2 to 32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.
const TEAM_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const rank = (role) => ROLES.indexOf(role); // a bigger number is a higher role

/** Team rules: who holds which role, and changes to members. */
export class TeamService {
  constructor({ store, clock = Date.now }) {
    Object.assign(this, { store, clock });
  }

  /** Find a team by name (not case sensitive), or throw a 404 error. */
  get(name) {
    const key = String(name).toLowerCase();
    const team = Object.hasOwn(this.store.data.teams, key) ? this.store.team(key) : null; // "constructor" is not a team
    if (!team) throw new HttpError(404, 'team_not_found', `No team named "${name}".`);
    return team;
  }

  /** The user's role in the team, or null if they are not in it. */
  roleOf(team, user) {
    return user ? team.members[user.id]?.role ?? null : null;
  }

  /** True when `user` holds at least `role` in `team`. */
  has(team, user, role) {
    const r = this.roleOf(team, user);
    return r !== null && rank(r) >= rank(role);
  }

  /** Throw a 403 error unless `user` holds at least `role` in `team`. */
  require(team, user, role) {
    if (!this.has(team, user, role)) {
      throw new HttpError(403, 'team_forbidden', `You need to be ${role === 'owner' ? 'an owner' : `a ${role}`} of team "${team.name}" to do that.`);
    }
  }

  /** The ids of a team's owners, who get an audit row when its packages move. */
  ownerIds(team) {
    return Object.entries(team.members).filter(([, m]) => m.role === 'owner').map(([id]) => id);
  }

  /** Every team the user belongs to, as summaries. */
  forUser(user) {
    return this.store.teams().filter((t) => t.members[user.id]).map((t) => this.summary(t, user));
  }

  /** A short view of a team: counts of members and packages, and the user's own role. */
  summary(team, user) {
    return {
      name: team.name, description: team.description, createdAt: team.createdAt,
      members: Object.keys(team.members).length,
      packages: this.store.packages().filter((p) => p.team === team.name).length,
      role: this.roleOf(team, user),
    };
  }

  /** The full view of a team (members and package names). Only members may see it. */
  view(team, user) {
    this.require(team, user, 'member');
    const members = Object.entries(team.members).map(([id, m]) => ({
      username: this.store.userById(id)?.username ?? '(deleted)', role: m.role, addedAt: m.addedAt, addedBy: m.addedBy,
    })).sort((a, b) => rank(b.role) - rank(a.role) || a.username.localeCompare(b.username));
    const packages = this.store.packages().filter((p) => p.team === team.name).map((p) => p.name).sort();
    return { ...this.summary(team, user), members, packageNames: packages };
  }

  /**
   * Create a team with `user` as its first owner. The name must be free among users, teams and agents,
   * and must not be a name every JavaScript object already has (like "constructor").
   */
  create(user, { name, description = '' }, ip) {
    name = String(name ?? '').trim().toLowerCase();
    if (!TEAM_RE.test(name) || name in Object.prototype) throw new HttpError(400, 'bad_team_name', 'Team names are 2-32 lowercase letters, digits, "-" or "_", and not a word every JavaScript object already has.');
    if (this.store.team(name)) throw new HttpError(409, 'team_exists', `The team "${name}" already exists.`);
    if (this.store.userByName(name) || this.store.data.agents?.[name]) throw new HttpError(409, 'team_exists', `"${name}" is already a user or agent name.`);
    const now = this.clock();
    const team = {
      name, description: String(description).slice(0, 300), createdAt: now, createdBy: user.username,
      members: { [user.id]: { role: 'owner', addedAt: now, addedBy: user.username } },
    };
    this.store.tx((d) => {
      d.teams[name] = team;
      this.store.audit({ userId: user.id, event: 'team.created', ip, team: name });
    });
    return team;
  }

  /** Add a member or change their role (owners only). Both the owner and the member get an audit row. */
  setMember(actor, teamName, username, role, ip) {
    const team = this.get(teamName);
    this.require(team, actor, 'owner');
    if (!ROLES.includes(role)) throw new HttpError(400, 'bad_role', `Role must be one of: ${ROLES.join(', ')}.`);
    const target = this.store.userByName(username ?? '');
    if (!target || target.status !== 'active') throw new HttpError(404, 'user_not_found', `No active user named "${username}".`);
    const before = team.members[target.id]?.role ?? null;
    if (before === 'owner' && role !== 'owner') this.assertAnotherOwner(team, target);
    this.store.tx((d) => {
      const m = d.teams[team.name].members;
      m[target.id] = { ...(m[target.id] ?? { addedAt: this.clock(), addedBy: actor.username }), role };
      const entry = { event: before ? 'team.role_changed' : 'team.member_added', ip, team: team.name, member: target.username, role, by: actor.username };
      this.store.audit({ userId: actor.id, ...entry });
      if (target.id !== actor.id) this.store.audit({ userId: target.id, ...entry });
    });
    return this.view(this.get(team.name), actor);
  }

  /** Owners can remove anyone; any member can remove themselves (leave). */
  removeMember(actor, teamName, username, ip) {
    const team = this.get(teamName);
    const target = this.store.userByName(username ?? '');
    if (!target || !team.members[target.id]) throw new HttpError(404, 'not_a_member', `"${username}" is not in team "${team.name}".`);
    if (target.id !== actor.id) this.require(team, actor, 'owner');
    if (team.members[target.id].role === 'owner') this.assertAnotherOwner(team, target);
    this.store.tx((d) => {
      delete d.teams[team.name].members[target.id];
      const entry = { event: target.id === actor.id ? 'team.left' : 'team.member_removed', ip, team: team.name, member: target.username, by: actor.username };
      this.store.audit({ userId: actor.id, ...entry });
      if (target.id !== actor.id) this.store.audit({ userId: target.id, ...entry });
    });
    return { team: team.name, removed: target.username };
  }

  /** Throw unless someone other than `leaving` is still an owner, so a team never ends up with no owner. */
  assertAnotherOwner(team, leaving) {
    const owners = Object.entries(team.members).filter(([id, m]) => m.role === 'owner' && id !== leaving.id);
    if (!owners.length) throw new HttpError(409, 'last_owner', `Team "${team.name}" must keep at least one owner. Promote someone else first.`);
  }

  /** Delete a team (owners only). A team that still owns packages cannot be deleted. */
  delete(actor, teamName, ip) {
    const team = this.get(teamName);
    this.require(team, actor, 'owner');
    const owned = this.store.packages().filter((p) => p.team === team.name);
    if (owned.length) {
      throw new HttpError(409, 'team_has_packages', `Team "${team.name}" still owns ${owned.length} package(s): ${owned.map((p) => p.name).join(', ')}. Transfer them first.`);
    }
    this.store.tx((d) => {
      delete d.teams[team.name];
      this.store.audit({ userId: actor.id, event: 'team.deleted', ip, team: team.name });
    });
    return { deleted: team.name };
  }
}
