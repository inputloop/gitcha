// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Skills as files: listing and reading over stand-in roots, the front-matter description, and that a name
// cannot walk out of its root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, listSkills, readSkill } from '../lib/skills.js';
import { buildHub } from '../lib/hub.js';

const files = {
  '/vbs/skills/candor-gate/SKILL.md': '---\nname: candor-gate\ndescription: >-\n  Say the uncomfortable thing first,\n  then the rest.\nversion: "1"\n---\n# candor\nbody',
  '/vbs/skills/rolls/SKILL.md': '---\nname: rolls\ndescription: "Dice, plainly."\n---\n# rolls',
  '/plain/hand-test/SKILL.md': '# hand-test\n\nno front matter here',
};
const dirs = { '/vbs/skills': ['candor-gate', 'rolls', '..', 'not-a-skill'], '/plain': ['hand-test'] };
const io = {
  exists: (p) => p in files || p in dirs || p === '/vbs' || p === '/plain',
  readdir: (p) => { if (p in dirs) return dirs[p]; throw new Error('ENOENT'); },
  readFile: (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); },
};

test('describe: the front-matter description, folded, or the first heading', () => {
  assert.equal(describe(files['/vbs/skills/candor-gate/SKILL.md']), 'Say the uncomfortable thing first, then the rest.');
  assert.equal(describe(files['/vbs/skills/rolls/SKILL.md']), 'Dice, plainly.');
  assert.equal(describe(files['/plain/hand-test/SKILL.md']), 'hand-test');
});

test('listSkills: a plugin checkout (root/skills) and a bare tree, sorted, without non-skills', () => {
  const rows = listSkills(['/vbs', '/plain'], io);
  assert.deepEqual(rows.map((r) => `${r.name}@${r.root}`), ['candor-gate@/vbs', 'hand-test@/plain', 'rolls@/vbs']);
});

test('readSkill: the first root that has it wins; a bad name or a path is refused, not joined', () => {
  assert.equal(readSkill(['/plain', '/vbs'], 'rolls', io).root, '/vbs');
  assert.equal(readSkill(['/vbs'], '../etc', io), null);
  assert.equal(readSkill(['/vbs'], 'rolls/../candor-gate', io), null);
  assert.equal(readSkill(['/vbs'], 'nope', io), null);
});

test('through the hub: skill_list filters, skill_read labels the text as other people\'s', async () => {
  const out = [];
  const hub = await buildHub({ skillsRoots: ['/vbs', '/plain'], io, output: { write: (s) => out.push(JSON.parse(s)) } });
  await hub.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_list', arguments: { match: 'dice' } } });
  assert.equal(out.at(-1).result.content[0].text, 'rolls\tDice, plainly.\t/vbs');
  await hub.server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skill_read', arguments: { name: 'candor-gate' } } });
  const text = out.at(-1).result.content[0].text;
  assert.match(text, /^\[Third-party text from the skill candor-gate in \/vbs\./);
  assert.match(text, /# candor\nbody/);
  await hub.server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skill_read', arguments: { name: '../x' } } });
  assert.match(out.at(-1).error.message, /not in the form/);
});
