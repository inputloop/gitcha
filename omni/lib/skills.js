// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Skills as files: a root is a folder holding skills/NAME/SKILL.md (a plugin checkout such as vibrobeast-skills or
// jarvis), or a folder of NAME/SKILL.md directly. Read only; a name is never joined into a path it could escape.
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const defaultIo = {
  readdir: (p) => fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  exists: (p) => fs.existsSync(p),
};

/** The folders that hold NAME/SKILL.md under a root: root/skills when it exists, else the root itself. */
function skillDirs(root, io) {
  const under = path.join(root, 'skills');
  return io.exists(under) ? [under] : io.exists(root) ? [root] : [];
}

/** The first non-empty description line of a SKILL.md's front matter, or the first heading. */
export function describe(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const lines = fm[1].split(/\r?\n/);
    const i = lines.findIndex((l) => /^description:/.test(l));
    if (i >= 0) {
      let value = lines[i].replace(/^description:\s*/, '').trim();
      if (value === '' || /^[>|]-?$/.test(value)) {
        // A block scalar: the indented lines that follow, folded into one.
        const parts = [];
        for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
        value = parts.join(' ');
      }
      return value.replace(/^["']|["']$/g, '').slice(0, 200);
    }
  }
  const h = /^#\s+(.+)$/m.exec(text);
  return h ? h[1].trim().slice(0, 200) : '';
}

export function listSkills(roots, io = {}) {
  const f = { ...defaultIo, ...io };
  const out = [];
  for (const root of roots) {
    for (const dir of skillDirs(root, f)) {
      let names = [];
      try { names = f.readdir(dir); } catch { continue; }
      for (const name of names.filter((n) => NAME.test(n))) {
        const file = path.join(dir, name, 'SKILL.md');
        if (!f.exists(file)) continue;
        let text = ''; try { text = f.readFile(file); } catch { continue; }
        out.push({ name, root, description: describe(text) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(roots, name, io = {}) {
  const f = { ...defaultIo, ...io };
  if (!NAME.test(name)) return null;
  for (const root of roots) {
    for (const dir of skillDirs(root, f)) {
      const file = path.join(dir, name, 'SKILL.md');
      if (f.exists(file)) { try { return { name, root, text: f.readFile(file) }; } catch { /* next root */ } }
    }
  }
  return null;
}
