// Download, verify and extract packages into ./gitcha_modules/, and keep
// gitcha-lock.json so later installs are pinned to the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unpackFiles, extractTo } from './tar.js';
import { MANIFEST_FILE, NAME_RE } from './manifest.js';

export const MODULES_DIR = 'gitcha_modules';
export const LOCK_FILE = 'gitcha-lock.json';

export function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'latest'];
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid package name.`);
  return { name, version: version || 'latest' };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export async function installOne(client, { name, version = 'latest' }, { dir = process.cwd(), save = true } = {}) {
  const root = path.resolve(dir);
  const lockFile = path.join(root, LOCK_FILE);
  const lock = readJson(lockFile, { lockfileVersion: 1, packages: {} });
  const locked = lock.packages[name];
  // Pin to the lockfile when the request matches it.
  const want = version === 'latest' && locked && !save ? locked.version : version;

  const { data, integrity, version: resolved } = await client.download(name, want);
  const actual = `sha256-${crypto.createHash('sha256').update(data).digest('hex')}`;
  if (integrity && actual !== integrity) throw new Error(`Integrity check failed for ${name}@${resolved}: server said ${integrity}, got ${actual}.`);
  if (locked && locked.version === resolved && locked.integrity !== actual) {
    throw new Error(`Integrity check failed for ${name}@${resolved}: does not match ${LOCK_FILE} (${locked.integrity}). The package may have been tampered with.`);
  }

  const files = unpackFiles(data);
  const target = path.join(root, MODULES_DIR, name);
  fs.rmSync(target, { recursive: true, force: true });
  extractTo(files, target);

  lock.packages[name] = { version: resolved, integrity: actual, resolved: `${client.server}/api/v1/packages/${name}/${resolved}/tarball` };
  writeJson(lockFile, lock);

  if (save) {
    const mf = path.join(root, MANIFEST_FILE);
    if (fs.existsSync(mf)) {
      const m = readJson(mf, null);
      if (m && m.name !== name) {
        m.dependencies = { ...(m.dependencies ?? {}), [name]: `^${resolved}` };
        writeJson(mf, m);
      }
    }
  }
  return { name, version: resolved, integrity: actual, path: target, files: files.length };
}

/** Install everything listed in gitcha.json "dependencies", honouring the lockfile. */
export async function installAll(client, { dir = process.cwd() } = {}) {
  const root = path.resolve(dir);
  const m = readJson(path.join(root, MANIFEST_FILE), {});
  const lock = readJson(path.join(root, LOCK_FILE), { packages: {} });
  const results = [];
  for (const name of Object.keys(m.dependencies ?? {})) {
    const version = lock.packages[name]?.version ?? 'latest';
    results.push(await installOne(client, { name, version }, { dir: root, save: false }));
  }
  return results;
}
