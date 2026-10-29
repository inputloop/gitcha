// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Runs unpackFiles on a file (or every .tgz in a directory) in its own process, so a reader that loops forever
// fails a test (by timeout) instead of hanging it. Prints one JSON line: { ok, files: [[path, bytes]] } or
// { ok: false, error } for a file; for a directory, a JSON object keyed by file name.
import fs from 'node:fs';
import path from 'node:path';
import { unpackFiles } from '../lib/tar.js';

const [target, options] = process.argv.slice(2);
const opts = options ? JSON.parse(options) : {};
const one = (file) => {
  try {
    return { ok: true, files: unpackFiles(fs.readFileSync(file), opts).map((f) => [f.path, f.data.length]) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};
if (fs.statSync(target).isDirectory()) {
  const out = {};
  for (const name of fs.readdirSync(target).sort()) if (name.endsWith('.tgz')) out[name] = one(path.join(target, name));
  console.log(JSON.stringify(out));
} else console.log(JSON.stringify(one(target)));
