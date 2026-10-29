// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The installer against a registry that lies (PKG-F2, EXT-11, EXT-11b, PKG-F6) and against a real one that has
// yanked a version (PKG-F12). The stub registry is a loopback http server answering whatever each test tells it to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GitchaClient } from '../lib/client.js';
import { installOne, installAll, LOCK_FILE, MODULES_DIR } from '../lib/installer.js';
import { packFiles } from '../lib/tar.js';
import { END, base, entry, gz } from './tarbuild.js';
import { startServer, createUser, api, deviceLogin } from '../../server/test/helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-inst-'));
const sha = (b) => `sha256-${crypto.createHash('sha256').update(b).digest('hex')}`;
const pkg = (name, version, content) => packFiles([{ path: 'gitcha.json', data: JSON.stringify({ name, version }) }, { path: 'index.js', data: content }]);

/** A registry that serves `replies[url]` = { body, headers } and counts requests. */
async function stub(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const r = replies(req.url);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not_found"}'); }
    res.writeHead(200, r.headers ?? {});
    res.end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new GitchaClient({ server: `http://127.0.0.1:${server.address().port}` });
  return { client, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
const tarballReply = (tgz, version, { integrity = sha(tgz), omit = [] } = {}) => ({
  body: tgz,
  headers: Object.fromEntries(Object.entries({ 'x-gitcha-integrity': integrity, 'x-gitcha-version': version }).filter(([k]) => !omit.includes(k))),
});
const info = (...versions) => ({ body: JSON.stringify({ versions: versions.map((v) => ({ version: v, yanked: false })) }), headers: { 'Content-Type': 'application/json' } });
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('PKG-F2: a registry that answers another version than the lock pins is refused, and nothing changes', async () => {
  const good = pkg('foo', '1.0.0', 'export default "good"');
  const evil = pkg('foo', '1.0.1', 'export default "EVIL"');
  let mode = 'honest';
  const s = await stub((url) => {
    if (url === '/api/v1/packages/foo') return info('1.0.0', '1.0.1');
    if (mode === 'honest') return tarballReply(good, '1.0.0');
    return tarballReply(evil, '1.0.1'); // asked for 1.0.0, answers 1.0.1 with bytes and a header that agree
  });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { foo: '^1.0.0' } }));
    await installAll(s.client, { dir });
    const lockBefore = read(dir, LOCK_FILE);
    mode = 'lie';
    await assert.rejects(installAll(s.client, { dir }), /Asked the registry for foo@1\.0\.0 and it answered with 1\.0\.1/);
    assert.equal(read(dir, MODULES_DIR, 'foo', 'index.js'), 'export default "good"');
    assert.equal(read(dir, LOCK_FILE), lockBefore, 'the lock was not rewritten');
  } finally { await s.close(); }
});

test('PKG-F2: same version, other bytes: refused against the lockfile, before the header is believed', async () => {
  const good = pkg('foo', '1.0.0', 'export default "good"');
  const swapped = pkg('foo', '1.0.0', 'export default "SWAPPED"');
  let tarball = good;
  const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0') : tarballReply(tarball, '1.0.0')));
  try {
    const dir = tmp();
    await installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir });
    tarball = swapped; // the header integrity is recomputed for the new bytes: only the lock can tell
    await assert.rejects(installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir }), new RegExp(`does not match ${LOCK_FILE}`));
    await assert.rejects(installOne(s.client, { name: 'foo' }, { dir, save: false }), new RegExp(`does not match ${LOCK_FILE}`), 'latest with a lock and no save is pinned too');
    assert.equal(read(dir, MODULES_DIR, 'foo', 'index.js'), 'export default "good"');
  } finally { await s.close(); }
});

test('EXT-11b: a download without the integrity or version header, or with a malformed one, is refused', async () => {
  const good = pkg('foo', '1.0.0', 'x');
  for (const reply of [tarballReply(good, '1.0.0', { omit: ['x-gitcha-integrity'] }), tarballReply(good, '1.0.0', { omit: ['x-gitcha-version'] }), tarballReply(good, '1.0.0', { integrity: 'md5-nope' })]) {
    const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0') : reply));
    try {
      await assert.rejects(installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir: tmp() }), /without a valid integrity or version header/);
    } finally { await s.close(); }
  }
});

test('EXT-11b: bytes that do not match the header are refused', async () => {
  const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0') : tarballReply(pkg('foo', '1.0.0', 'x'), '1.0.0', { integrity: sha(Buffer.from('other')) })));
  try {
    await assert.rejects(installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir: tmp() }), /Integrity check failed/);
  } finally { await s.close(); }
});

test('EXT-11: dependency names are checked on the client, before any request or any delete', async () => {
  const s = await stub(() => tarballReply(pkg('x', '1.0.0', 'x'), '1.0.0'));
  try {
    for (const bad of ['..', '../../escape', 'a/b', '.hidden', 'UPPER']) {
      const parent = tmp();
      const dir = path.join(parent, 'project');
      fs.mkdirSync(dir);
      fs.mkdirSync(path.join(parent, 'escape'));
      fs.writeFileSync(path.join(parent, 'escape', 'keep.txt'), 'keep');
      fs.writeFileSync(path.join(dir, 'important.txt'), 'keep');
      fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { [bad]: '1' } }));
      await assert.rejects(installAll(s.client, { dir }), /is not a valid package name/, bad);
      await assert.rejects(installOne(s.client, { name: bad }, { dir }), /is not a valid package name/, bad);
      assert.ok(fs.existsSync(path.join(parent, 'escape', 'keep.txt')) && fs.existsSync(path.join(dir, 'important.txt')), bad);
    }
    assert.deepEqual(s.seen, [], 'no request was made');
  } finally { await s.close(); }
});

test('PKG-F6: gitcha_modules that is a link out of the project is refused, and what it points at is left alone', async () => {
  const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0') : tarballReply(pkg('foo', '1.0.0', 'x'), '1.0.0')));
  try {
    const parent = tmp();
    const dir = path.join(parent, 'project');
    const outside = path.join(parent, 'outside-config');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(outside, 'foo'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'foo', 'KEEP.txt'), 'keep');
    fs.symlinkSync(outside, path.join(dir, MODULES_DIR));
    await assert.rejects(installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir }), /points outside the project/);
    assert.equal(read(outside, 'foo', 'KEEP.txt'), 'keep');
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false, 'no lock was written');
  } finally { await s.close(); }
});

test('PKG-F6: a link planted at the package folder itself is replaced, not followed', async () => {
  const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0') : tarballReply(pkg('foo', '1.0.0', 'new'), '1.0.0')));
  try {
    const parent = tmp();
    const dir = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(path.join(dir, MODULES_DIR), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'KEEP.txt'), 'keep');
    fs.symlinkSync(outside, path.join(dir, MODULES_DIR, 'foo'));
    await installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir });
    assert.equal(read(outside, 'KEEP.txt'), 'keep');
    assert.equal(fs.existsSync(path.join(outside, 'index.js')), false);
    assert.equal(read(dir, MODULES_DIR, 'foo', 'index.js'), 'new');
    assert.equal(fs.lstatSync(path.join(dir, MODULES_DIR, 'foo')).isSymbolicLink(), false);
  } finally { await s.close(); }
});

test('PKG-F5: a tarball the reader refuses leaves the installed copy in place (the old order deleted it first)', async () => {
  const good = pkg('foo', '1.0.0', 'old');
  const bad = gz(base('foo'), entry('package/.', ''), END);
  let tarball = good;
  let version = '1.0.0';
  const s = await stub((url) => (url === '/api/v1/packages/foo' ? info('1.0.0', '1.0.1') : tarballReply(tarball, version)));
  try {
    const dir = tmp();
    await installOne(s.client, { name: 'foo', version: '1.0.0' }, { dir });
    tarball = bad; version = '1.0.1';
    await assert.rejects(installOne(s.client, { name: 'foo', version: '1.0.1' }, { dir }), /unsafe path/);
    assert.equal(read(dir, MODULES_DIR, 'foo', 'index.js'), 'old');
    assert.deepEqual(fs.readdirSync(path.join(dir, MODULES_DIR)), ['foo'], 'no staging folder left behind');
  } finally { await s.close(); }
});

test('PKG-F12: a yanked version installs only with allowYanked, and then with a warning; latest never picks it', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const put = (tgz) => api(srv.url, 'PUT', '/api/v1/packages', { token, body: { tarball: tgz.toString('base64') } });
    assert.equal((await put(pkg('imm', '1.0.0', 'one'))).status, 201);
    assert.equal((await put(pkg('imm', '1.1.0', 'two'))).status, 201);
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/imm/1.1.0/yank', { token, body: {} })).status, 200);
    const client = new GitchaClient({ server: srv.url, token });

    const dir = tmp();
    await assert.rejects(installOne(client, { name: 'imm', version: '1.1.0' }, { dir }), /was yanked.*gitcha install imm@1\.1\.0 --allow-yanked/);
    assert.equal(fs.existsSync(path.join(dir, MODULES_DIR)), false, 'nothing installed');

    const latest = await installOne(client, { name: 'imm' }, { dir });
    assert.equal(latest.version, '1.0.0');
    assert.deepEqual(latest.warnings, []);

    const forced = await installOne(client, { name: 'imm', version: '1.1.0' }, { dir, allowYanked: true });
    assert.equal(forced.version, '1.1.0');
    assert.match(forced.warnings[0], /imm@1\.1\.0 was yanked by its maintainers; installed because you asked for it/);

    // the lock now pins the yanked version; installing from the lock asks again
    fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { imm: '^1.0.0' } }));
    await assert.rejects(installAll(client, { dir }), /was yanked/);
    assert.equal((await installAll(client, { dir, allowYanked: true }))[0].warnings.length, 1);
  } finally { await srv.close(); }
});

