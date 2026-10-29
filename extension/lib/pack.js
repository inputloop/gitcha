// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Turns a project folder into a Gitcha package tarball (a .tgz archive) for `gitcha publish` and `gitcha pack`.
// It decides which files go in, then hands them to tar.js.
import fs from 'node:fs';
import path from 'node:path';
import { packFiles } from './tar.js';
import { MANIFEST_FILE, validateManifest } from './manifest.js';

// What ships: the paths that "files" names (default: src, lib, bin), plus gitcha.json and top-level README* and
// LICENSE* files. A name that starts with a dot ships only when a "files" entry names it exactly.
// A "*" never matches a leading dot.
export const DEFAULT_FILES = ['src', 'lib', 'bin'];
const ALWAYS = /^(readme|license)/i;

// A second safety net under "files" and .gitchaignore: these names never ship, whatever either says.
// They are mostly secrets (keys, cloud logins, .env files) and big folders. The check runs on every part of
// the path, so a denied folder blocks everything inside it.
const DENIED_NAMES = new Set(['.git', 'node_modules', 'gitcha_modules', '.aws', '.ssh', '.gnupg', '.docker', 'gitcha-data',
  '.kube', '.azure', '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.pypirc', '.ds_store', '.gitchaignore', 'db.json', 'secret.key']);
const DENIED_PATTERNS = [/^\.env/, /^id_/, /\.(key|pem|p12|pfx|jks|tgz|tfstate)$/i, /^credentials\.json/, /^terraform\.tfstate/, /^application_default_credentials/];
export const isDenied = (rel) => rel.split('/').some((seg) => DENIED_NAMES.has(seg.toLowerCase()) || DENIED_PATTERNS.some((re) => re.test(seg)));

// The patterns in .gitchaignore, one per line. Blank lines and "#" comment lines are skipped.
function readIgnore(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.gitchaignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

/**
 * Match one part of a path against one part of a glob (a pattern where "*" means any characters and "?" one).
 * A leading "*" or "?" skips names that start with a dot, unless `dot` is true.
 */
function segmentMatches(glob, seg, dot) {
  if (!glob.includes('*') && !glob.includes('?')) return glob === seg;
  if (!dot && seg.startsWith('.') && /^[*?]/.test(glob)) return false;
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`).test(seg);
}

/**
 * Do the glob's parts match the first parts of the path? That way a pattern that names a folder takes
 * everything inside it. "**" matches any number of path parts.
 */
function prefixMatches(glob, segs, dot, g = 0, i = 0) {
  if (g === glob.length) return dot || segs.slice(i).every((seg) => !seg.startsWith('.')); // a dot-name below a named directory must be named too
  if (glob[g] === '**') {
    for (let k = i; k <= segs.length; k++) {
      if (k > i && !dot && segs[k - 1].startsWith('.')) return false;
      if (prefixMatches(glob, segs, dot, g + 1, k)) return true;
    }
    return false;
  }
  return i < segs.length && segmentMatches(glob[g], segs[i], dot) && prefixMatches(glob, segs, dot, g + 1, i + 1);
}

// Drop a leading "./" or "/" and any trailing "/", then split the pattern into parts.
const toGlob = (pattern) => pattern.replace(/^\.?\//, '').replace(/\/+$/, '').split('/');

/**
 * Is this path in .gitchaignore? A pattern with no slash matches a name at any depth (as in .gitignore).
 * A pattern with a slash is matched from the project root.
 */
function ignored(patterns, rel) {
  const segs = rel.split('/');
  return patterns.some((pattern) => {
    const anchored = pattern.replace(/\/+$/, '').includes('/');
    const glob = toGlob(pattern);
    return anchored ? prefixMatches(glob, segs, true) : segs.some((seg) => segmentMatches(glob[0], seg, true));
  });
}

// Read and check gitcha.json. Throws an error that lists every problem.
export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new Error(`No ${MANIFEST_FILE} found in ${dir}. Create one with at least "name" and "version".`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${MANIFEST_FILE} is not valid JSON: ${e.message}`); }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Invalid ${MANIFEST_FILE}:\n  - ${errors.join('\n  - ')}`);
  return manifest;
}

// Walk the project and gather the files that ship, with their bytes.
// Symbolic links are skipped, so a link cannot pull in a file from outside the project.
export function collectFiles(dir) {
  const root = path.resolve(dir);
  const manifest = readManifest(root);
  const ignores = readIgnore(root);
  const includes = (manifest.files ?? DEFAULT_FILES).map(toGlob);
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (isDenied(p) || ignored(ignores, p)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const segs = p.split('/');
        const always = p === MANIFEST_FILE || (segs.length === 1 && ALWAYS.test(p));
        if (always || includes.some((glob) => prefixMatches(glob, segs, false))) out.push({ path: p, data: fs.readFileSync(path.join(root, p)) });
      }
    }
  };
  walk('');
  return { manifest, files: out };
}

/**
 * Build the tarball for a project. `entries` is the list with sizes that a dry run shows.
 * `files` is just the paths.
 */
export function pack(dir) {
  const { manifest, files } = collectFiles(dir);
  return { manifest, files: files.map((f) => f.path), entries: files.map((f) => ({ path: f.path, size: f.data.length })), tarball: packFiles(files) };
}
