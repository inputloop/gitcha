// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Downloading a project: the Files page, one file (shown, raw, downloaded), and the whole project as a .zip
// or .tar.gz, from the web (session cookie) and the API (token). Real git, real pushes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startSocial, git, newRepo } from './social-helpers.js';
import { cleanPath } from '../src/git/browse.js';

let s, srv, alice, bob, cookieAlice;
const BIG = 600 * 1024;

const get = async (p, { token, cookie, headers = {} } = {}) => {
  const r = await fetch(srv.url + p, { redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};

before(async () => {
  // Public projects open to visitors who are not signed in (FILES-5 checks the default, where they are not).
  s = await startSocial({ people: ['alice', 'bob'], env: { GITCHA_PUBLIC_READ: 'true' } });
  srv = s.srv;
  alice = s.users.alice; bob = s.users.bob;
  const owner = srv.store.userByName('alice');
  srv.projects.create(owner, { name: 'pub', visibility: 'public' }, '127.0.0.1');
  srv.projects.create(owner, { name: 'secret', visibility: 'private' }, '127.0.0.1');
  srv.projects.create(owner, { name: 'empty', visibility: 'public' }, '127.0.0.1');
  const { token } = srv.auth.createSession(owner, { kind: 'web', name: 'test browser', ip: '127.0.0.1' });
  cookieAlice = `gitcha_sid=${token}`;

  const dir = await newRepo();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Pub\n\nA **small** project.\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1 < 2;\n');
  fs.writeFileSync(path.join(dir, 'evil.html'), '<script>alert(1)</script>\n');
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2, 3, 255, 0]));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(BIG));
  fs.mkdirSync(path.join(dir, 'with space'));
  fs.writeFileSync(path.join(dir, 'with space', 'né.txt'), 'accent\n');
  await git(dir, ['add', '.']);
  await git(dir, ['-c', 'user.name=A', '-c', 'user.email=a@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  await git(dir, ['tag', 'v1']);
  await git(dir, ['checkout', '-q', '-b', 'feature/x']);
  fs.writeFileSync(path.join(dir, 'only-on-feature.txt'), 'f\n');
  await git(dir, ['add', '.']);
  await git(dir, ['-c', 'user.name=A', '-c', 'user.email=a@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feature']);
  const port = new URL(srv.url).port;
  for (const proj of ['pub', 'secret']) {
    await git(dir, ['push', '-q', `http://alice:${s.tokens.alice}@127.0.0.1:${port}/git/alice/${proj}.git`, 'main', 'feature/x', 'v1']);
  }
});
after(() => srv.close());

test('FILES-1: anyone (with public reads on) downloads a public project as a zip and a tar.gz, at the default branch, a tag or a branch', async () => {
  const zip = await get('/projects/alice/pub/archive.zip');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition'), /attachment; filename="pub-main\.zip"/);
  assert.equal(zip.body.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  for (const f of ['pub-main/README.md', 'pub-main/src/a.js', 'pub-main/data.bin']) assert.ok(zip.body.includes(f), `the zip holds ${f}`);
  assert.ok(!zip.body.includes('only-on-feature.txt'), 'main does not have the feature branch file');

  const tgz = await get('/projects/alice/pub/archive.tar.gz?ref=feature/x');
  assert.equal(tgz.status, 200);
  assert.match(tgz.headers.get('content-disposition'), /filename="pub-feature-x\.tar\.gz"/);
  const tar = zlib.gunzipSync(tgz.body);
  assert.ok(tar.includes('pub-feature-x/only-on-feature.txt') && tar.includes('pub-feature-x/src/a.js'));

  const tag = await get('/api/v1/projects/alice/pub/archive?ref=v1&format=tar.gz');
  assert.equal(tag.status, 200);
  assert.match(tag.headers.get('content-disposition'), /filename="pub-v1\.tar\.gz"/);
  const sha = tag.headers.get('x-gitcha-commit');
  const byCommit = await get(`/projects/alice/pub/archive.zip?ref=${sha}`);
  assert.match(byCommit.headers.get('content-disposition'), new RegExp(`filename="pub-${sha.slice(0, 7)}\\.zip"`));
});

test('FILES-2: one file is shown as plain text or downloaded, never served as HTML', async () => {
  const a = await get('/projects/alice/pub/raw?path=src/a.js');
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(a.headers.get('content-disposition'), /^inline; filename="a\.js"/);
  assert.equal(a.body.toString(), 'export const a = 1 < 2;\n');
  const d = await get('/projects/alice/pub/raw?path=src/a.js&download=1');
  assert.match(d.headers.get('content-disposition'), /^attachment; filename="a\.js"/);

  const evil = await get('/projects/alice/pub/raw?path=evil.html');
  assert.equal(evil.headers.get('content-type'), 'text/plain; charset=utf-8', 'an HTML file is text, not a page');
  assert.equal(evil.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(evil.headers.get('x-content-type-options'), 'nosniff');

  const bin = await get('/projects/alice/pub/raw?path=data.bin');
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.match(bin.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual([...bin.body], [0, 1, 2, 3, 255, 0]);

  const big = await get('/api/v1/projects/alice/pub/raw?path=big.txt');
  assert.equal(big.status, 200);
  assert.equal(big.body.length, BIG, 'a file too big to show still downloads whole');

  const named = await get(`/projects/alice/pub/raw?path=${encodeURIComponent('with space/né.txt')}&download=1`);
  assert.equal(named.status, 200);
  assert.match(named.headers.get('content-disposition'), /filename\*=UTF-8''n%C3%A9\.txt/);
});

test('FILES-3: paths and refs from the address cannot leave the repository or reach git as options', async () => {
  for (const p of ['../secret', 'src/../README.md', './README.md', 'a\u0000b']) assert.throws(() => cleanPath(p), /path/);
  assert.equal(cleanPath('/src//a.js/'), 'src/a.js');
  assert.equal((await get('/projects/alice/pub/raw?path=src/../README.md')).status, 400);
  assert.equal((await get('/projects/alice/pub/raw?path=src')).status, 400, 'a folder is not a file');
  assert.equal((await get('/projects/alice/pub/raw?path=nope.txt')).status, 404);
  for (const ref of ['--output=/tmp/x', '-h', 'main..feature/x', 'main@{1}', 'a b']) {
    assert.equal((await get(`/projects/alice/pub/archive.zip?ref=${encodeURIComponent(ref)}`)).status, 400, ref);
  }
  assert.equal((await get('/projects/alice/pub/archive.zip?ref=no-such-branch')).status, 404);
  assert.equal((await get('/api/v1/projects/alice/pub/archive?format=rar')).status, 400);
});

test('FILES-4: the Files page lists folders and files, renders the README, and shows a file with its text escaped', async () => {
  const root = await get('/projects/alice/pub/files');
  assert.equal(root.status, 200);
  const html = root.body.toString();
  for (const x of ['src/', 'README.md', 'Download ZIP', '/projects/alice/pub/archive.zip?ref=main', 'raw?ref=main&amp;path=data.bin&amp;download=1', '<strong>small</strong>']) assert.ok(html.includes(x), x);
  assert.ok(html.indexOf('src/') < html.indexOf('README.md'), 'folders come first');

  const file = (await get('/projects/alice/pub/files?path=evil.html')).body.toString();
  assert.ok(file.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !file.includes('<script>alert(1)'), 'file text is escaped');
  assert.match((await get('/projects/alice/pub/files?path=big.txt')).body.toString(), /too big to show here/);
  assert.match((await get('/projects/alice/pub/files?path=data.bin')).body.toString(), /not text/);
  const feature = (await get('/projects/alice/pub/files?ref=feature/x')).body.toString();
  assert.ok(feature.includes('only-on-feature.txt') && feature.includes('ref=feature%2Fx'), 'a chosen branch is kept in the links');

  const empty = await get('/projects/alice/empty/files');
  assert.equal(empty.status, 200);
  assert.match(empty.body.toString(), /Nothing has been pushed/);
  assert.equal((await get('/projects/alice/empty/archive.zip')).status, 404);
  assert.match((await get('/projects/alice/pub')).body.toString(), /Browse files/);
});

test('FILES-5: a private project: hidden from strangers, open to its owner with a passed 2FA check', async () => {
  for (const p of ['/projects/alice/secret/files', '/projects/alice/secret/archive.zip', '/projects/alice/secret/raw?path=README.md']) {
    assert.equal((await get(p)).status, 404, `anonymous ${p}`);
  }
  assert.equal((await get('/api/v1/projects/alice/secret/archive', { token: s.tokens.bob })).status, 404, 'another person sees nothing');
  assert.equal((await get('/api/v1/projects/alice/secret/archive')).status, 404);
  assert.equal((await get('/api/v1/projects/alice/secret/archive', { token: 'not-a-token' })).status, 401);

  assert.equal((await get('/api/v1/projects/alice/secret/archive', { token: s.tokens.alice })).status, 200);
  const basic = `Basic ${Buffer.from(`alice:${s.tokens.alice}`).toString('base64')}`;
  assert.equal((await get('/api/v1/projects/alice/secret/raw?path=README.md', { headers: { Authorization: basic } })).status, 200, 'Basic, as git and curl -u send it');
  assert.equal((await get('/projects/alice/secret/files', { cookie: cookieAlice })).status, 200);
  assert.equal((await get('/projects/alice/secret/archive.zip', { cookie: cookieAlice })).status, 200);

  // Thirteen hours on, the periodic check is due: the API says so, the web sends her to /verify first.
  srv.clock.advance(13 * 3600_000);
  const due = await get('/api/v1/projects/alice/secret/archive', { token: s.tokens.alice });
  assert.equal(due.status, 403);
  assert.equal(JSON.parse(due.body).error, 'mfa_required');
  const web = await get('/projects/alice/secret/archive.zip', { cookie: cookieAlice });
  assert.equal(web.status, 303);
  assert.match(web.headers.get('location'), /^\/verify\?reason=interval&next=%2Fprojects%2Falice%2Fsecret%2Farchive\.zip/);
  assert.equal((await get('/projects/alice/pub/archive.zip', { cookie: cookieAlice })).status, 200, 'a public project needs no check');
});

test('FILES-5b: with public reads off (the default), a public project downloads only for someone signed in, as git clone does', async () => {
  srv.config.publicRead = false;
  try {
    assert.equal((await get('/projects/alice/pub/archive.zip')).status, 404);
    assert.equal((await get('/api/v1/projects/alice/pub/raw?path=README.md')).status, 404);
    assert.equal((await get('/api/v1/projects/alice/pub/raw?path=README.md', { token: s.tokens.bob })).status, 200);
  } finally { srv.config.publicRead = true; }
});

test('FILES-6: the API lists a folder as JSON, with the branches and tags', async () => {
  const r = await get('/api/v1/projects/alice/pub/tree?path=src');
  assert.equal(r.status, 200);
  const t = JSON.parse(r.body);
  assert.equal(t.ref, 'main');
  assert.equal(t.defaultBranch, 'main');
  assert.deepEqual(t.branches.sort(), ['feature/x', 'main']);
  assert.deepEqual(t.tags, ['v1']);
  assert.deepEqual(t.entries, [{ name: 'a.js', path: 'src/a.js', type: 'blob', size: 24 }]);
  const f = JSON.parse((await get('/api/v1/projects/alice/pub/tree?path=big.txt')).body);
  assert.equal(f.type, 'blob');
  assert.equal(f.size, BIG);
  assert.equal(JSON.parse((await get('/api/v1/projects/alice/empty/tree')).body).empty, true);
});
