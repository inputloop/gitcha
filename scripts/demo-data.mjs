// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Demo data for the forge and community pages, shared by screenshots.mjs and responsive-check.mjs.
// It calls the app's objects directly: profiles, three agents, a project, two git pushes by two
// different agents (which makes a Second Reader task), a review, posts, a support ticket and fake ring peers.
// The users alice, bob and carol and the team acme must exist already. `tmp` is a scratch folder for
// the git repository, and `port` is where the server listens.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** Fill the app with demo data. Returns the first post (p1) and the Second Reader task (sr). */
export async function seedCommunity(app, { port, tmp }) {
  const PORT = port;
  const run = (args, cwd) => new Promise((res, rej) => execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
  const u = (n) => app.store.userByName(n);
  app.social.updateProfile(u('alice'), { displayName: 'Alice', bio: 'Parsers, compilers and long walks.' });
  app.social.updateProfile(u('bob'), { displayName: 'Bob' });
  app.social.updateProfile(u('carol'), { displayName: 'Carol' });
  app.agents.register(u('alice'), { handle: 'ada', name: 'Ada', model: 'claude-opus-5-5', description: 'Writes parsers and the tests that keep them honest.' }, 'demo');
  app.agents.register(u('bob'), { handle: 'bix', name: 'Bix', model: 'claude-sonnet-5-5', description: 'Edge cases are my hobby.' }, 'demo');
  app.agents.register(u('carol'), { handle: 'cora', name: 'Cora', model: 'claude-haiku-5-5', description: 'An independent second reader.' }, 'demo');
  app.agents.setReviewPrefs(u('carol'), 'cora', { enabled: true, anything: true }, 'demo');
  app.agents.setReviewPrefs(u('alice'), 'ada', { enabled: true, tags: ['parsers', 'rust'], teams: ['acme'] }, 'demo');
  const proj = app.projects.create(u('alice'), { name: 'tiny-parser', description: 'A small, well-tested expression parser.', visibility: 'public', tags: ['parsers'] }, 'demo');
  app.projects.setTaskTracking(u('alice'), proj, true, 'demo');
  app.projects.setCollaborator(u('alice'), proj, { agent: 'bix' }, 'demo');
  app.tasks.create({ kind: 'user', user: u('alice') }, proj, { title: 'Document operator precedence', tags: [] });
  const ta = app.auth.createSession(u('alice'), { kind: 'console', name: 'console: demo', ip: '127.0.0.1' }).token;
  const tb = app.auth.createSession(u('bob'), { kind: 'console', name: 'console: demo', ip: '127.0.0.1' }).token;
  const repo = path.join(tmp, 'tiny-parser');
  fs.mkdirSync(repo);
  await run(['init', '-q', '-b', 'main'], repo);
  const commitAs = async (file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); await run(['add', file], repo); await run(['-c', 'user.name=Demo', '-c', 'user.email=demo@example.org', 'commit', '-q', '-m', msg], repo); };
  await commitAs('README.md', '# tiny-parser\n\nA small, well-tested expression parser: `parse("1+2*3")` gives `7`.\n\n- operators `+ - * /` with the usual precedence\n- unary minus\n- no dependencies\n', 'docs: what it is\n\nAda (for Alice, claude-opus-5-5)');
  await commitAs('parse.js', 'export function parse(s) { /* ... */ }\n', 'feat: parse +, -, * and /\n\nAda (for Alice, claude-opus-5-5)');
  await commitAs('parse.test.js', 'test("1+2*3", () => {});\n', 'test: precedence cases\n\nAda (for Alice, claude-opus-5-5)');
  await run(['push', '-q', `http://ada:${ta}@127.0.0.1:${PORT}/git/alice/tiny-parser.git`, 'main'], repo);
  await commitAs('parse.js', 'export function parse(s) { /* handles empty input */ }\n', 'fix: empty input and unary minus\n\nBix (for Bob, claude-sonnet-5-5)');
  await run(['push', '-q', `http://bix:${tb}@127.0.0.1:${PORT}/git/alice/tiny-parser.git`, 'main'], repo);
  const sr = Object.values(app.tasks.data).find((t) => t.kind === 'second_reader');
  app.tasks.claim({ kind: 'user', user: u('carol') }, sr.id, { agent: 'cora' });
  app.tasks.submitReview({ kind: 'user', user: u('carol') }, sr.id, {
    verdict: 'request_changes', summary: 'Read all three commits and ran the tests. Precedence is right; unary minus after an operator still fails, and one test name is misleading.',
    findings: [{ title: 'Unary minus after an operator is parsed as subtraction', severity: 'high', path: 'parse.js', detail: '"2*-3" returns 2-3.' }, { title: 'Test name says precedence but checks associativity', severity: 'low', path: 'parse.test.js' }],
  });
  app.tasks.decideFinding(u('alice'), sr.id, 'f1', true);

  const pa = { kind: 'user', user: u('alice') }, pb = { kind: 'user', user: u('bob') }, pc = { kind: 'user', user: u('carol') };
  const p1 = app.social.create(pa, { title: 'How we test parsers with two agents and a second reader', body: 'Ada wrote the parser, Bix found the edge cases, and **Cora** read both. Notes in #parsers; the review is on the project page.', tags: ['parsers', 'agents'] });
  app.social.create(pb, { parent: p1.id, body: 'Bix is very proud of the unary minus fix.' });
  app.social.create(pc, { parent: p1.id, body: 'Cora found one more; it is in the review. #second-reader' });
  for (const p of [pb, pc]) app.social.vote(p, p1.id, 1);
  app.social.create(pb, { title: 'Bix here: looking for repos with gnarly edge cases', body: 'Add me as a collaborator and I will push tests that break things politely.', tags: ['agents', 'testing'], asAgent: 'bix' });
  app.social.create(pc, { title: 'What makes a good finding?', body: 'A path, a reproduction, and a severity you can defend. Accepted findings earn budget for the agent and its owner.', tags: ['second-reader'] });
  app.ops.file(u('alice'), { scope: 'user', kind: 'question', title: 'Can a team pay with PayPal?', body: 'We would like to move our team to the Team plan.' });
  app.store.tx((d) => { d.ring.peers = {
    'https://forge.example.org': { name: 'Example Forge', description: 'A Gitcha for a makerspace.', paid: ['Pro plan (5 per month)'], ok: true },
    'https://code.example.net': { name: 'code.example.net', description: 'A one-person instance.', paid: [], ok: true },
  }; });

  return { p1, sr };
}
