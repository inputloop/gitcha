// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Turn a project directory into a Gitcha package tarball.
import fs from 'node:fs';
import path from 'node:path';
import { packFiles } from './tar.js';
import { MANIFEST_FILE, validateManifest } from './manifest.js';

// What ships is what "files" names (default: src lib bin), plus gitcha.json, README* and LICENSE*. A name that
// starts with a dot ships only when a "files" entry names it exactly; "*" never matches a leading dot.
export const DEFAULT_FILES = ['src', 'lib', 'bin'];
const ALWAYS = /^(readme|license)/i;

// A second net under "files" and .gitchaignore: these never ship, whatever either says. Matched on every path
// segment, so a directory takes everything under it.
const DENIED_NAMES = new Set(['.git', 'node_modules', 'gitcha_modules', '.aws', '.ssh', '.gnupg', '.docker', 'gitcha-data',
  '.kube', '.azure', '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.pypirc', '.ds_store', '.gitchaignore', 'db.json', 'secret.key']);
const DENIED_PATTERNS = [/^\.env/, /^id_/, /\.(key|pem|p12|pfx|jks|tgz|tfstate)$/i, /^credentials\.json/, /^terraform\.tfstate/, /^application_default_credentials/];
export const isDenied = (rel) => rel.split('/').some((seg) => DENIED_NAMES.has(seg.toLowerCase()) || DENIED_PATTERNS.some((re) => re.test(seg)));

function readIgnore(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.gitchaignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

/** One path segment against one glob segment. A leading "*" or "?" skips dotfiles unless `dot`. */
function segmentMatches(glob, seg, dot) {
  if (!glob.includes('*') && !glob.includes('?')) return glob === seg;
  if (!dot && seg.startsWith('.') && /^[*?]/.test(glob)) return false;
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`).test(seg);
}

/** Do the glob's segments match the first segments of the path (so a pattern naming a directory takes its contents)? "**" is any run of segments. */
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

const toGlob = (pattern) => pattern.replace(/^\.?\//, '').replace(/\/+$/, '').split('/');

/** .gitchaignore: a pattern with no slash matches a name at any depth (as in .gitignore); one with a slash is anchored at the project root. */
function ignored(patterns, rel) {
  const segs = rel.split('/');
  return patterns.some((pattern) => {
    const anchored = pattern.replace(/\/+$/, '').includes('/');
    const glob = toGlob(pattern);
    return anchored ? prefixMatches(glob, segs, true) : segs.some((seg) => segmentMatches(glob[0], seg, true));
  });
}

export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new Error(`No ${MANIFEST_FILE} found in ${dir}. Create one with at least "name" and "version".`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${MANIFEST_FILE} is not valid JSON: ${e.message}`); }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Invalid ${MANIFEST_FILE}:\n  - ${errors.join('\n  - ')}`);
  return manifest;
}

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

/** `entries` is the list with sizes that a dry run shows; `files` is just the paths. */
export function pack(dir) {
  const { manifest, files } = collectFiles(dir);
  return { manifest, files: files.map((f) => f.path), entries: files.map((f) => ({ path: f.path, size: f.data.length })), tarball: packFiles(files) };
}
