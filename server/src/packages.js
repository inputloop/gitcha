// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Package registry logic: publish, list, search, fetch, yank, transfer.
// A package is owned either by a user (its maintainers) or by a team, in which
// case team maintainers/owners can publish and team-private packages are only
// visible to team members.
import { sha256 } from './crypto.js';
import { HttpError } from './errors.js';
import { unpackFiles } from '../../extension/lib/tar.js';
import { MANIFEST_FILE, NAME_RE, validateManifest, latestVersion, compareVersions } from '../../extension/lib/manifest.js';

const README_LIMIT = 64 * 1024;

export class PackageService {
  constructor({ store, config, teams, clock = Date.now }) {
    Object.assign(this, { store, config, teams, clock });
  }

  // ---- permissions -----------------------------------------------------------
  canRead(user, pkg) {
    if (pkg.visibility !== 'team') return true;
    const team = this.store.team(pkg.team);
    return Boolean(team && this.teams.has(team, user, 'member'));
  }

  canWrite(user, pkg) {
    if (pkg.team) {
      const team = this.store.team(pkg.team);
      return Boolean(team && this.teams.has(team, user, 'maintainer'));
    }
    return pkg.maintainers.includes(user.id);
  }

  requireWrite(user, pkg) {
    if (!this.canWrite(user, pkg)) {
      throw new HttpError(403, 'not_maintainer', pkg.team
        ? `"${pkg.name}" belongs to team "${pkg.team}"; you must be a maintainer or owner of that team.`
        : `You are not a maintainer of "${pkg.name}".`);
    }
  }

  // ---- publishing ---------------------------------------------------------------
  publish(user, { tarball, integrity, team: teamArg, private: privArg }, ip) {
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No package tarball was sent.');
    if (tarball.length > this.config.maxPackageBytes) throw new HttpError(413, 'too_large', 'Package is too large.');
    const digest = sha256(tarball);
    if (integrity && integrity !== `sha256-${digest}`) {
      throw new HttpError(400, 'integrity_mismatch', 'Tarball checksum does not match: upload corrupted?');
    }
    let files;
    try {
      files = unpackFiles(tarball);
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

    const existing = this.store.pkg(manifest.name);
    if (existing) {
      // Don't reveal who owns a package the publisher can't even see.
      if (!this.canRead(user, existing)) throw new HttpError(409, 'name_unavailable', `The package name "${manifest.name}" is not available.`);
      this.requireWrite(user, existing);
      if (teamName && existing.team !== team.name) {
        throw new HttpError(409, 'owner_mismatch', `"${manifest.name}" is not owned by team "${team.name}". Use \`gitcha transfer\` to move it.`);
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
      const pkg = d.packages[manifest.name] ?? {
        name: manifest.name, createdAt: now, maintainers: [user.id], versions: {}, downloads: 0,
        owner: team ? team.name : user.username, team: team ? team.name : null, visibility: 'registry',
      };
      pkg.versions[manifest.version] = record;
      pkg.description = record.description;
      pkg.license = record.license;
      if (pkg.team && priv !== undefined) pkg.visibility = priv ? 'team' : 'registry';
      pkg.homepage = typeof manifest.homepage === 'string' ? manifest.homepage.slice(0, 300) : pkg.homepage;
      if (readme) pkg.readme = readme.data.toString('utf8').slice(0, README_LIMIT);
      pkg.updatedAt = now;
      d.packages[manifest.name] = pkg;
      this.store.audit({ userId: user.id, event: 'package.published', ip, package: manifest.name, version: manifest.version, team: pkg.team ?? undefined });
    });
    return { name: manifest.name, team: this.store.pkg(manifest.name).team, visibility: this.store.pkg(manifest.name).visibility, ...record };
  }

  // ---- reading --------------------------------------------------------------------
  summary(pkg) {
    const versions = Object.values(pkg.versions);
    return {
      name: pkg.name, description: pkg.description, license: pkg.license, owner: pkg.owner,
      team: pkg.team ?? null, visibility: pkg.visibility ?? 'registry',
      latest: latestVersion(versions), versions: versions.length, downloads: pkg.downloads, updatedAt: pkg.updatedAt,
    };
  }

  search(q = '', user = null, { team } = {}) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.packages()
      .filter((p) => this.canRead(user, p) && (!team || p.team === team))
      .filter((p) => terms.every((t) => p.name.includes(t) || (p.description ?? '').toLowerCase().includes(t) || (p.team ?? '').includes(t)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((p) => this.summary(p));
  }

  info(name, user = null) {
    const pkg = this.get(name, user);
    return {
      ...this.summary(pkg), homepage: pkg.homepage ?? null, readme: pkg.readme ?? null,
      canPublish: user ? this.canWrite(user, pkg) : false,
      versions: Object.values(pkg.versions).sort((a, b) => compareVersions(b.version, a.version)),
    };
  }

  /** Fetch a package the user may read. Hidden packages look like missing ones. */
  get(name, user = null) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'bad_name', 'Invalid package name.');
    const pkg = this.store.pkg(name);
    if (!pkg || !this.canRead(user, pkg)) throw new HttpError(404, 'not_found', `No package named "${name}".`);
    return pkg;
  }

  resolve(name, version = 'latest', user = null) {
    const pkg = this.get(name, user);
    const v = version === 'latest' ? latestVersion(Object.values(pkg.versions)) : version;
    const rec = v && pkg.versions[v];
    if (!rec) throw new HttpError(404, 'not_found', `${name}@${version} does not exist.`);
    return { pkg, rec };
  }

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
  yank(user, name, version, yanked, ip) {
    const { pkg, rec } = this.resolve(name, version, user);
    this.requireWrite(user, pkg);
    this.store.tx((d) => {
      d.packages[name].versions[rec.version].yanked = yanked;
      this.store.audit({ userId: user.id, event: yanked ? 'package.yanked' : 'package.unyanked', ip, package: name, version: rec.version });
    });
    return { name, version: rec.version, yanked };
  }

  /** Move a package into a team (or between teams) to share it. */
  transfer(user, name, teamName, ip) {
    const pkg = this.get(name, user);
    this.requireWrite(user, pkg);
    const team = this.teams.get(teamName);
    this.teams.require(team, user, 'maintainer');
    if (pkg.team === team.name) throw new HttpError(409, 'already_owned', `"${name}" already belongs to team "${team.name}".`);
    const from = pkg.owner;
    this.store.tx((d) => {
      Object.assign(d.packages[name], { team: team.name, owner: team.name, visibility: pkg.visibility ?? 'registry' });
      this.store.audit({ userId: user.id, event: 'package.transferred', ip, package: name, from, to: team.name });
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
