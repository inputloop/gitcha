// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The package registry: publish, list, search, fetch, yank (mark a version as "do not use"), and
// transfer. A package is owned either by a user (its maintainers) or by a team. For a team package,
// the team's maintainers and owners can publish, and a team-only package is visible only to team members.
// Package records live in the store's `packages` collection; the tarball bytes live in blobs.
import { sha256 } from './crypto.js';
import { HttpError } from './errors.js';
import { unpackFiles } from '../../extension/lib/tar.js';
import { MANIFEST_FILE, VERSION_RE, isPackageName, validateManifest, latestVersion, compareVersions } from '../../extension/lib/manifest.js';

const README_LIMIT = 64 * 1024; // only the first 64 KB of a README is kept

/** Package registry rules. Uses TeamService for team roles. */
export class PackageService {
  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
  }

  /** The stored package, or null. Never something every object inherits, so a name like "constructor" finds nothing. */
  own(name) {
    return Object.hasOwn(this.store.data.packages, name) ? this.store.pkg(name) : null;
  }

  // ---- permissions -----------------------------------------------------------
  /** Anyone may read a package unless it is team-only; then only team members may. */
  canRead(user, pkg) {
    if (pkg.visibility !== 'team') return true;
    const team = this.store.team(pkg.team);
    return Boolean(team && this.teams.has(team, user, 'member'));
  }

  /** Team packages: team maintainers and owners may change them. Other packages: their maintainers. */
  canWrite(user, pkg) {
    if (pkg.team) {
      const team = this.store.team(pkg.team);
      return Boolean(team && this.teams.has(team, user, 'maintainer'));
    }
    return pkg.maintainers.includes(user.id);
  }

  /** Throw a 403 error unless the user may change the package. */
  requireWrite(user, pkg) {
    if (!this.canWrite(user, pkg)) {
      throw new HttpError(403, 'not_maintainer', pkg.team
        ? `"${pkg.name}" belongs to team "${pkg.team}"; you must be a maintainer or owner of that team.`
        : `You are not a maintainer of "${pkg.name}".`);
    }
  }

  // ---- publishing ---------------------------------------------------------------
  /**
   * Publish a new version from a tarball. Checks the size and checksum, unpacks it, reads and checks
   * the manifest, checks who may publish, then saves the tarball as a blob and the version record.
   * Versions can never be replaced: the same version number twice is an error.
   */
  publish(user, { tarball, integrity, team: teamArg, private: privArg }, ip) {
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No package tarball was sent.');
    if (tarball.length > this.config.maxPackageBytes) throw new HttpError(413, 'too_large', 'Package is too large.');
    const digest = sha256(tarball);
    if (integrity && integrity !== `sha256-${digest}`) {
      throw new HttpError(400, 'integrity_mismatch', 'Tarball checksum does not match: upload corrupted?');
    }
    let files;
    try {
      // The unpacked size is capped at 4 times the packed limit (a careful default, keepers may tune it). This stops
      // a "zip bomb" (a small file that unpacks huge). strict = apply the package rules.
      files = unpackFiles(tarball, { maxBytes: this.config.maxPackageBytes * 4, strict: true });
    } catch (err) {
      throw new HttpError(400, 'bad_tarball', `Invalid package tarball: ${err.message}`);
    }
    const mf = files.find((f) => f.path === MANIFEST_FILE);
    if (!mf) throw new HttpError(400, 'no_manifest', `The package has no ${MANIFEST_FILE}.`);
    let manifest;
    try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { throw new HttpError(400, 'bad_manifest', `${MANIFEST_FILE} is not valid JSON.`); }
    const errors = validateManifest(manifest);
    if (errors.length) throw new HttpError(400, 'bad_manifest', errors.join('; '));

    const teamName = teamArg || manifest.team || null;
    const priv = privArg ?? manifest.private;
    if (priv && !teamName) throw new HttpError(400, 'private_needs_team', 'Private packages must belong to a team.');
    const team = teamName ? this.teams.get(teamName) : null;

    const existing = this.own(manifest.name);
    if (existing) {
      // Do not reveal who owns a package the publisher cannot even see.
      if (!this.canRead(user, existing)) throw new HttpError(409, 'name_unavailable', `The package name "${manifest.name}" is not available.`);
      this.requireWrite(user, existing);
      if (teamName && existing.team !== team.name) {
        throw new HttpError(409, 'owner_mismatch', `"${manifest.name}" is not owned by team "${team.name}". Use \`gitcha transfer\` to move it.`);
      }
      // Who can see a team package is changed on purpose, through the visibility route, which writes the audit event.
      // A publish may only repeat what is already so.
      if (existing.team && priv !== undefined && (priv ? 'team' : 'registry') !== (existing.visibility ?? 'registry')) {
        throw new HttpError(409, 'visibility_change', `"${manifest.name}" is ${existing.visibility === 'team' ? 'visible to team members only' : 'visible to every registry user'}; a publish cannot change that. Use \`gitcha access ${manifest.name} ${priv ? 'team-only' : 'public'}\`.`);
      }
      if (existing.versions[manifest.version]) {
        throw new HttpError(409, 'version_exists', `${manifest.name}@${manifest.version} already exists. Versions are immutable: bump the version.`);
      }
    } else if (team) {
      this.teams.require(team, user, 'maintainer');
    }

    const readme = files.find((f) => /^readme(\.md)?$/i.test(f.path));
    const now = this.clock();
    const record = {
      version: manifest.version,
      description: manifest.description ?? '',
      license: manifest.license ?? 'UNLICENSED',
      integrity: `sha256-${digest}`,
      size: tarball.length,
      fileCount: files.length,
      publishedAt: now,
      publishedBy: user.username,
      yanked: false,
    };
    this.store.writeBlob(digest, tarball);
    this.store.tx((d) => {
      const pkg = (Object.hasOwn(d.packages, manifest.name) ? d.packages[manifest.name] : null) ?? {
        name: manifest.name, createdAt: now, maintainers: [user.id], versions: {}, downloads: 0,
        owner: team ? team.name : user.username, team: team ? team.name : null, visibility: 'registry',
      };
      pkg.versions[manifest.version] = record;
      pkg.description = record.description;
      pkg.license = record.license;
      if (pkg.team && priv !== undefined && !existing) pkg.visibility = priv ? 'team' : 'registry'; // set once, when the package is created
      pkg.homepage = typeof manifest.homepage === 'string' ? manifest.homepage.slice(0, 300) : pkg.homepage;
      if (readme) pkg.readme = readme.data.toString('utf8').slice(0, README_LIMIT);
      pkg.updatedAt = now;
      d.packages[manifest.name] = pkg;
      this.store.audit({ userId: user.id, event: 'package.published', ip, package: manifest.name, version: manifest.version, team: pkg.team ?? undefined });
    });
    return { name: manifest.name, team: this.store.pkg(manifest.name).team, visibility: this.store.pkg(manifest.name).visibility, ...record };
  }

  // ---- reading --------------------------------------------------------------------
  /** The short public view of a package, used in lists. */
  summary(pkg) {
    const versions = Object.values(pkg.versions);
    return {
      name: pkg.name, description: pkg.description, license: pkg.license, owner: pkg.owner,
      team: pkg.team ?? null, visibility: pkg.visibility ?? 'registry',
      latest: latestVersion(versions), versions: versions.length, downloads: pkg.downloads, updatedAt: pkg.updatedAt,
    };
  }

  /**
   * Search packages the user may read. Every word must appear in the name, the description or the team
   * name. Newest first, at most 100 results. `team` limits results to one team.
   */
  search(q = '', user = null, { team } = {}) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.packages()
      .filter((p) => this.canRead(user, p) && (!team || p.team === team))
      .filter((p) => terms.every((t) => p.name.includes(t) || (p.description ?? '').toLowerCase().includes(t) || (p.team ?? '').includes(t)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((p) => this.summary(p));
  }

  /** The full view of one package: summary, homepage, README and every version (newest first). */
  info(name, user = null) {
    const pkg = this.get(name, user);
    return {
      ...this.summary(pkg), homepage: pkg.homepage ?? null, readme: pkg.readme ?? null,
      canPublish: user ? this.canWrite(user, pkg) : false,
      versions: Object.values(pkg.versions).sort((a, b) => compareVersions(b.version, a.version)),
    };
  }

  /** Fetch a package the user may read. Hidden packages look like missing ones (404), so their names stay secret. */
  get(name, user = null) {
    if (!isPackageName(name)) throw new HttpError(400, 'bad_name', 'Invalid package name.');
    const pkg = this.own(name);
    if (!pkg || !this.canRead(user, pkg)) throw new HttpError(404, 'not_found', `No package named "${name}".`);
    return pkg;
  }

  /** Find one version of a package ('latest' means the newest). Returns { pkg, rec }. */
  resolve(name, version = 'latest', user = null) {
    const pkg = this.get(name, user);
    if (version !== 'latest' && !VERSION_RE.test(version)) throw new HttpError(400, 'bad_version', 'Invalid version.');
    const v = version === 'latest' ? latestVersion(Object.values(pkg.versions)) : version;
    const rec = v && Object.hasOwn(pkg.versions, v) ? pkg.versions[v] : null;
    if (!rec) throw new HttpError(404, 'not_found', `${name}@${version} does not exist.`);
    return { pkg, rec };
  }

  /** Get a version's tarball bytes and count the download (with an audit row for a logged-in user). */
  download(name, version, user, ip) {
    const { rec } = this.resolve(name, version, user);
    const data = this.store.readBlob(rec.integrity.slice('sha256-'.length));
    this.store.tx((d) => {
      d.packages[name].downloads++;
      if (user) this.store.audit({ userId: user.id, event: 'package.downloaded', ip, package: name, version: rec.version });
    });
    return { rec, data };
  }

  // ---- managing ---------------------------------------------------------------------
  /** Mark a version as yanked (or not). The version stays stored; yanking does not delete it. */
  yank(user, name, version, yanked, ip) {
    const { pkg, rec } = this.resolve(name, version, user);
    this.requireWrite(user, pkg);
    this.store.tx((d) => {
      d.packages[name].versions[rec.version].yanked = yanked;
      this.store.audit({ userId: user.id, event: yanked ? 'package.yanked' : 'package.unyanked', ip, package: name, version: rec.version });
    });
    return { name, version: rec.version, yanked };
  }

  /** Move a package into a team (or between teams) to share it. Taking one out of a team is for that team's owners. */
  transfer(user, name, teamName, ip) {
    const pkg = this.get(name, user);
    this.requireWrite(user, pkg);
    const team = this.teams.get(teamName);
    this.teams.require(team, user, 'maintainer');
    if (pkg.team === team.name) throw new HttpError(409, 'already_owned', `"${name}" already belongs to team "${team.name}".`);
    const source = pkg.team ? this.store.team(pkg.team) : null;
    if (source) this.teams.require(source, user, 'owner');
    const from = pkg.owner;
    this.store.tx((d) => {
      Object.assign(d.packages[name], { team: team.name, owner: team.name, visibility: pkg.visibility ?? 'registry' });
      this.store.audit({ userId: user.id, event: 'package.transferred', ip, package: name, from, to: team.name });
      // The owners of both teams get an audit row too (without the actor's address, for privacy).
      const told = new Set([user.id]);
      for (const t of [source, team]) {
        for (const id of t ? this.teams.ownerIds(t) : []) {
          if (told.has(id)) continue;
          told.add(id);
          this.store.audit({ userId: id, event: 'package.transferred', package: name, from, to: team.name, by: user.username });
        }
      }
    });
    return this.summary(this.store.pkg(name));
  }

  /** Change who can see a team package: the whole registry or only the team. */
  setVisibility(user, name, priv, ip) {
    const pkg = this.get(name, user);
    this.requireWrite(user, pkg);
    if (!pkg.team) throw new HttpError(400, 'private_needs_team', 'Only team packages can be private. Transfer it to a team first.');
    this.store.tx((d) => {
      d.packages[name].visibility = priv ? 'team' : 'registry';
      this.store.audit({ userId: user.id, event: 'package.visibility', ip, package: name, visibility: priv ? 'team' : 'registry' });
    });
    return this.summary(this.store.pkg(name));
  }
}
