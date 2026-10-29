// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Builds HOW-IT-WORKS.md from docs/how-it-works.src.md.
//
// The guide points into the code by name, not by line number, because line
// numbers change every time someone edits a file. In the source, a reference is
// written in double square brackets:
//
//   [[server/src/auth.js]]                   a link to the file
//   [[server/src/auth.js#beginLogin]]        a function, class, method or constant by name
//   [[server/src/web.js#"router.post('/login'"]]   the first line holding that exact text
//
// This script finds the line each name is on today and writes a normal
// Markdown link such as [`auth.js:212`](server/src/auth.js#L212). If a name
// cannot be found, it stops with an error, so the guide can never point at
// code that is not there.
//
//   node scripts/how-it-works.mjs           write HOW-IT-WORKS.md
//   node scripts/how-it-works.mjs --check   fail if HOW-IT-WORKS.md is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'docs', 'how-it-works.src.md');
const OUT = path.join(root, 'HOW-IT-WORKS.md');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a name can be defined in our JavaScript, tried in this order. */
function definitionPatterns(name) {
  const n = escape(name);
  return [
    new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\*?\\s+${n}\\b`),
    new RegExp(`^\\s*(export\\s+)?class\\s+${n}\\b`),
    new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${n}\\b`),
    new RegExp(`^\\s*(static\\s+)?(async\\s+)?(get\\s+|set\\s+)?${n}\\s*\\([^;]*\\)\\s*\\{\\s*(//.*)?$`),
    new RegExp(`^\\s*${n}\\s*:`),
    new RegExp(`^\\s*(static\\s+)?(async\\s+)?${n}\\s*\\(`),
    new RegExp(`^\\s*(const|let)\\s+\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=`),
    new RegExp(`^\\s*def\\s+${n}\\b`),
    new RegExp(`^\\s*${n}\\s*\\(\\)\\s*\\{`),
  ];
}

/** Find the 1-based line of `target` in `file`, or throw. */
function lineOf(file, target) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${file}`);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (target.startsWith('"') && target.endsWith('"')) {
    const text = target.slice(1, -1);
    const i = lines.findIndex((l) => l.includes(text));
    if (i < 0) throw new Error(`${file}: no line contains ${target}`);
    return i + 1;
  }
  for (const re of definitionPatterns(target)) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  throw new Error(`${file}: cannot find a definition of ${target}`);
}

/** Replace every [[...]] reference in `text` with a Markdown link. */
export function render(text) {
  const errors = [];
  const out = text.replace(/\[\[([^\]#]+?)(?:#((?:"[^"]*")|[^\]]+))?\]\]/g, (_, file, target) => {
    try {
      if (!target) {
        if (!fs.existsSync(path.join(root, file))) throw new Error(`no such file: ${file}`);
        return `[\`${file}\`](${file})`;
      }
      const line = lineOf(file, target);
      return `[\`${path.basename(file)}:${line}\`](${file}#L${line})`;
    } catch (err) {
      errors.push(err.message);
      return '??';
    }
  });
  if (errors.length) throw new Error(`how-it-works: ${errors.length} reference(s) not found:\n  ${errors.join('\n  ')}`);
  return out;
}

const header = '<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->\n<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->\n<!-- Made by scripts/how-it-works.mjs from docs/how-it-works.src.md. Edit that file, then run: npm run docs -->\n\n';
const src = fs.readFileSync(SRC, 'utf8').replace(/^<!--[\s\S]*?-->\n(<!--[\s\S]*?-->\n)*\n?/, '');
const built = header + render(src);
if (process.argv.includes('--check')) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (now !== built) { console.error('HOW-IT-WORKS.md is out of date: run npm run docs'); process.exit(1); }
  console.log('HOW-IT-WORKS.md is up to date');
} else {
  fs.writeFileSync(OUT, built);
  console.log(`wrote ${path.relative(root, OUT)}`);
}
