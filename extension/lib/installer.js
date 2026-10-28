// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
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

/** The most a package may expand to on disk: 4 x the registry's 25 MiB upload limit (a conservative default). */
export const MAX_INSTALL_BYTES = 100 * 1024 * 1024;

const lockedEntry = (lock, name) => (Object.hasOwn(lock.packages, name) ? lock.packages[name] : null);

/** gitcha_modules must be a real directory inside the project; a link that leaves it would take the install (and the delete) with it. */
function modulesDir(root) {
  const modules = path.join(root, MODULES_DIR);
  fs.mkdirSync(modules, { recursive: true });
  const real = fs.realpathSync(modules);
  const inside = path.relative(fs.realpathSync(root), real);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`${MODULES_DIR} points outside the project (${real}). Refusing to install into it.`);
  }
  return real;
}

export async function installOne(client, { name, version = 'latest' }, { dir = process.cwd(), save = true, allowYanked = false } = {}) {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid package name.`);
  const root = path.resolve(dir);
  const lockFile = path.join(root, LOCK_FILE);
  const lock = readJson(lockFile, { lockfileVersion: 1, packages: {} });
  const locked = lockedEntry(lock, name);
  // Pin to the lockfile when the request matches it.
  const want = version === 'latest' && locked && !save ? locked.version : version;

  // A version asked for by name (or pinned by the lock) is installed only if it has not been yanked, unless the user says so.
  const warnings = [];
  if (want !== 'latest') {
    const rec = (await client.info(name)).versions.find((v) => v.version === want);
    if (rec?.yanked) {
      if (!allowYanked) {
        throw new Error(`${name}@${want} was yanked by its maintainers, which usually means it is broken or unsafe. If you really want it, run: gitcha install ${name}@${want} --allow-yanked`);
      }
      warnings.push(`${name}@${want} was yanked by its maintainers; installed because you asked for it.`);
    }
  }

  const { data, integrity, version: resolved } = await client.download(name, want);
  const actual = `sha256-${crypto.createHash('sha256').update(data).digest('hex')}`;
  // The lockfile first: it is the one reference the registry did not just write.
  if (locked && locked.version === resolved && locked.integrity !== actual) {
    throw new Error(`Integrity check failed for ${name}@${resolved}: does not match ${LOCK_FILE} (${locked.integrity}). The package may have been tampered with.`);
  }
  if (actual !== integrity) throw new Error(`Integrity check failed for ${name}@${resolved}: server said ${integrity}, got ${actual}.`);

  const files = unpackFiles(data, { maxBytes: MAX_INSTALL_BYTES, strict: true });
  const modules = modulesDir(root);
  const target = path.join(modules, name);
  // Extract beside the old copy and swap, so a failure never leaves the project without the package it had.
  const stage = fs.mkdtempSync(path.join(modules, `.${name}-`));
  try {
    extractTo(files, stage);
    fs.rmSync(target, { recursive: true, force: true }); // a link at the target is removed, not followed
    fs.renameSync(stage, target);
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }

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
  return { name, version: resolved, integrity: actual, path: target, files: files.length, warnings };
}

/** Install everything listed in gitcha.json "dependencies", honouring the lockfile. */
export async function installAll(client, { dir = process.cwd(), allowYanked = false } = {}) {
  const root = path.resolve(dir);
  const m = readJson(path.join(root, MANIFEST_FILE), {});
  const lock = readJson(path.join(root, LOCK_FILE), { packages: {} });
  const names = Object.keys(m.dependencies ?? {});
  for (const name of names) if (!NAME_RE.test(name)) throw new Error(`"${name}" in ${MANIFEST_FILE} is not a valid package name.`);
  const results = [];
  for (const name of names) {
    const version = lockedEntry(lock, name)?.version ?? 'latest';
    results.push(await installOne(client, { name, version }, { dir: root, save: false, allowYanked }));
  }
  return results;
}
