// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Turn a project directory into a Gitcha package tarball.
import fs from 'node:fs';
import path from 'node:path';
import { packFiles } from './tar.js';
import { MANIFEST_FILE, validateManifest } from './manifest.js';

// Never shipped, whatever "files" or .gitchaignore says.
const ALWAYS_IGNORE = [/^\.git$/, /^node_modules$/, /^gitcha_modules$/, /^\.env(\..*)?$/, /^\.DS_Store$/, /\.tgz$/, /^credentials\.json$/, /\.pem$/, /^id_(rsa|ed25519)/];

function readIgnore(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.gitchaignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

const globToRe = (g) => new RegExp('^' + g.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '(/.*)?$');

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
  const ignores = readIgnore(root).map(globToRe);
  const includes = manifest.files?.map(globToRe);
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (ALWAYS_IGNORE.some((re) => re.test(entry.name)) || ignores.some((re) => re.test(p))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const always = p === MANIFEST_FILE || /^(readme|license|licence|copying)(\.\w+)?$/i.test(p);
        if (!includes || always || includes.some((re) => re.test(p))) out.push({ path: p, data: fs.readFileSync(path.join(root, p)) });
      }
    }
  };
  walk('');
  return { manifest, files: out };
}

export function pack(dir) {
  const { manifest, files } = collectFiles(dir);
  return { manifest, files: files.map((f) => f.path), tarball: packFiles(files) };
}
