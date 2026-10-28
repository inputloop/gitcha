// Package registry logic: publish, list, search, fetch, yank.
import { sha256 } from './crypto.js';
import { HttpError } from './errors.js';
import { unpackFiles } from '../../extension/lib/tar.js';
import { MANIFEST_FILE, NAME_RE, validateManifest, latestVersion, compareVersions } from '../../extension/lib/manifest.js';

const README_LIMIT = 64 * 1024;

export class PackageService {
  constructor({ store, config, clock = Date.now }) {
    Object.assign(this, { store, config, clock });
  }

  publish(user, { tarball, integrity }, ip) {
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

    const existing = this.store.pkg(manifest.name);
    if (existing && !existing.maintainers.includes(user.id)) {
      throw new HttpError(403, 'not_maintainer', `You are not a maintainer of "${manifest.name}".`);
    }
    if (existing?.versions[manifest.version]) {
      throw new HttpError(409, 'version_exists', `${manifest.name}@${manifest.version} already exists. Versions are immutable: bump the version.`);
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
        name: manifest.name, createdAt: now, maintainers: [user.id], owner: user.username, versions: {}, downloads: 0,
      };
      pkg.versions[manifest.version] = record;
      pkg.description = record.description;
      pkg.license = record.license;
      pkg.homepage = typeof manifest.homepage === 'string' ? manifest.homepage.slice(0, 300) : pkg.homepage;
      if (readme) pkg.readme = readme.data.toString('utf8').slice(0, README_LIMIT);
      pkg.updatedAt = now;
      d.packages[manifest.name] = pkg;
      this.store.audit({ userId: user.id, event: 'package.published', ip, package: manifest.name, version: manifest.version });
    });
    return { name: manifest.name, ...record };
  }

  summary(pkg) {
    const versions = Object.values(pkg.versions);
    return {
      name: pkg.name, description: pkg.description, license: pkg.license, owner: pkg.owner,
      latest: latestVersion(versions), versions: versions.length, downloads: pkg.downloads, updatedAt: pkg.updatedAt,
    };
  }

  search(q = '') {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.packages()
      .filter((p) => terms.every((t) => p.name.includes(t) || (p.description ?? '').toLowerCase().includes(t)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((p) => this.summary(p));
  }

  info(name) {
    const pkg = this.get(name);
    return {
      ...this.summary(pkg), homepage: pkg.homepage ?? null, readme: pkg.readme ?? null,
      versions: Object.values(pkg.versions).sort((a, b) => compareVersions(b.version, a.version)),
    };
  }

  get(name) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'bad_name', 'Invalid package name.');
    const pkg = this.store.pkg(name);
    if (!pkg) throw new HttpError(404, 'not_found', `No package named "${name}".`);
    return pkg;
  }

  resolve(name, version = 'latest') {
    const pkg = this.get(name);
    const v = version === 'latest' ? latestVersion(Object.values(pkg.versions)) : version;
    const rec = v && pkg.versions[v];
    if (!rec) throw new HttpError(404, 'not_found', `${name}@${version} does not exist.`);
    return { pkg, rec };
  }

  download(name, version, user, ip) {
    const { rec } = this.resolve(name, version);
    const data = this.store.readBlob(rec.integrity.slice('sha256-'.length));
    this.store.tx((d) => {
      d.packages[name].downloads++;
      if (user) this.store.audit({ userId: user.id, event: 'package.downloaded', ip, package: name, version: rec.version });
    });
    return { rec, data };
  }

  yank(user, name, version, yanked, ip) {
    const { pkg, rec } = this.resolve(name, version);
    if (!pkg.maintainers.includes(user.id)) throw new HttpError(403, 'not_maintainer', `You are not a maintainer of "${name}".`);
    this.store.tx((d) => {
      d.packages[name].versions[rec.version].yanked = yanked;
      this.store.audit({ userId: user.id, event: yanked ? 'package.yanked' : 'package.unyanked', ip, package: name, version: rec.version });
    });
    return { name, version: rec.version, yanked };
  }
}
