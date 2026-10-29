// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles, unpackFiles } from '../../extension/lib/tar.js';
import { END, base, entry, header, gz } from '../../extension/test/tarbuild.js';

const MIN = 60_000;
const tarball = (manifest, extra = []) => packFiles([{ path: 'gitcha.json', data: JSON.stringify(manifest) }, { path: 'README.md', data: `# ${manifest.name}\n\nHello.` }, ...extra]);
const publish = (srv, token, tgz) => api(srv.url, 'PUT', '/api/v1/packages', {
  token, body: { tarball: tgz.toString('base64'), integrity: `sha256-${crypto.createHash('sha256').update(tgz).digest('hex')}` },
});

test('publish, search, info and download with integrity', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const tgz = tarball({ name: 'left-pad', version: '1.0.0', description: 'Pads strings', license: 'MIT' }, [{ path: 'index.js', data: 'export default 1' }]);
    const pub = await publish(srv, token, tgz);
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    assert.match(pub.body.integrity, /^sha256-[a-f0-9]{64}$/);

    const dup = await publish(srv, token, tgz);
    assert.equal(dup.status, 409, 'versions are immutable');

    const s = await api(srv.url, 'GET', '/api/v1/packages?q=pad', { token });
    assert.equal(s.body.packages[0].name, 'left-pad');

    const info = await api(srv.url, 'GET', '/api/v1/packages/left-pad', { token });
    assert.equal(info.body.latest, '1.0.0');
    assert.match(info.body.readme, /Hello/);

    const dl = await api(srv.url, 'GET', '/api/v1/packages/left-pad/latest/tarball', { token });
    assert.equal(dl.headers.get('x-gitcha-integrity'), pub.body.integrity);
    assert.equal(`sha256-${crypto.createHash('sha256').update(dl.body).digest('hex')}`, pub.body.integrity);
    assert.equal(unpackFiles(dl.body).length, 3);
  } finally { await srv.close(); }
});

test('publishing is a sensitive action that needs a fresh code', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    srv.clock.advance(11 * MIN);
    const r = await publish(srv, token, tarball({ name: 'pkg', version: '1.0.0' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'sensitive_action');
    await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: u.nextCode() } });
    assert.equal((await publish(srv, token, tarball({ name: 'pkg', version: '1.0.0' }))).status, 201);
  } finally { await srv.close(); }
});

test('only maintainers may publish new versions or yank', async () => {
  const srv = await startServer();
  try {
    const a = createUser(srv, 'alice');
    const b = createUser(srv, 'mallory', 'evil twin passphrase');
    const ta = await deviceLogin(srv, a);
    const tb = await deviceLogin(srv, b);
    assert.equal((await publish(srv, ta, tarball({ name: 'owned', version: '1.0.0' }))).status, 201);
    assert.equal((await publish(srv, tb, tarball({ name: 'owned', version: '1.0.1' }))).status, 403);
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/owned/1.0.0/yank', { token: tb, body: {} })).status, 403);
    const y = await api(srv.url, 'POST', '/api/v1/packages/owned/1.0.0/yank', { token: ta, body: {} });
    assert.equal(y.body.yanked, true);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/owned/latest/tarball', { token: ta })).status, 404);
  } finally { await srv.close(); }
});

test('malicious tarballs are rejected', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    // Hand-craft a tar entry with a path-traversal name (a valid header, so only the path is wrong).
    const evil = Buffer.concat([header('package/../../etc/passwd', { size: 1 }), Buffer.alloc(1024)]);
    const r = await publish(srv, token, zlib.gzipSync(evil));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_tarball');
    const noManifest = await publish(srv, token, packFiles([{ path: 'index.js', data: 'x' }]));
    assert.equal(noManifest.body.error, 'no_manifest');
    const badName = await publish(srv, token, tarball({ name: '../evil', version: '1.0.0' }));
    assert.equal(badName.body.error, 'bad_manifest');
  } finally { await srv.close(); }
});

test('the registry reads a tarball the way every other tar reader does (PKG-F3, F4, F5, F7)', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const refused = async (tgz, pattern) => {
      const r = await publish(srv, token, tgz);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'bad_tarball');
      assert.match(r.body.message, pattern);
    };
    // a size GNU tar cannot read, then a symlink only GNU tar would see (the old reader stopped at the size)
    await refused(gz(base('t17b'), header('package/junk', { sizeRaw: 'zzzzzzzzzzz\0' }), entry('package/ln', '', { type: '2' }), END), /size is not a number/);
    await refused(gz(base('t11'), entry('package/gitcha.json', '{"name":"second","version":"9.9.9"}'), END), /duplicate entry/);
    await refused(gz(base('t13'), entry('package/.', ''), END), /unsafe path/);
    await refused(gz(base('t15'), entry('package/.git/config', '[core]\n\tfsmonitor = x\n'), END), /never part of a package/);
    await refused(gz(base('t15c'), entry('package/node_modules/x.js', ''), END), /never part of a package/);
    // nothing of that was stored
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages', { token })).body.packages.length, 0);
    // and the health route still answers
    assert.equal((await api(srv.url, 'GET', '/api/v1/health')).status, 200);
  } finally { await srv.close(); }
});

test('a small upload cannot expand past four times the upload limit (PKG-F14)', async () => {
  const srv = await startServer({ env: { GITCHA_MAX_PACKAGE_BYTES: String(64 * 1024) } });
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const bomb = gz(base('bomb'), entry('package/zeros', Buffer.alloc(4 * 1024 * 1024)), END);
    assert.ok(bomb.length < 64 * 1024, `the upload itself is small (${bomb.length} bytes)`);
    const r = await publish(srv, token, bomb);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'bad_tarball');
    assert.match(r.body.message, /expands to more than 262144 bytes/);
    const fine = await publish(srv, token, gz(base('fine'), entry('package/data', Buffer.alloc(100 * 1024)), END));
    assert.equal(fine.status, 201, 'a package that stays inside the cap is published');
  } finally { await srv.close(); }
});

test('names and versions that every object already has are refused, not a 500 (PKG-F11)', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const token = await deviceLogin(srv, u);
    const fine = await publish(srv, token, tarball({ name: 'fine', version: '1.0.0' }));
    assert.equal(fine.status, 201);
    const ctor = await publish(srv, token, tarball({ name: 'constructor', version: '1.0.0' }));
    assert.equal(ctor.status, 400, JSON.stringify(ctor.body));
    assert.equal(ctor.body.error, 'bad_manifest');
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/constructor', { token })).status, 400);
    for (const v of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '1.0']) {
      const dl = await api(srv.url, 'GET', `/api/v1/packages/fine/${v}/tarball`, { token });
      assert.equal(dl.status, 400, `${v}: ${JSON.stringify(dl.body)}`);
      assert.equal(dl.body.error, 'bad_version');
      assert.equal((await api(srv.url, 'POST', `/api/v1/packages/fine/${v}/yank`, { token, body: {} })).status, 400, v);
    }
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/fine/9.9.9/tarball', { token })).status, 404, 'a well-formed version that does not exist is still a 404');
    const team = await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'constructor' } });
    assert.equal(team.status, 400, JSON.stringify(team.body));
    assert.equal(team.body.error, 'bad_team_name');
    assert.equal((await api(srv.url, 'GET', '/api/v1/teams/constructor', { token })).status, 404);
    assert.equal((await publish(srv, token, tarball({ name: 'fine', version: '1.0.1', team: 'constructor' }))).status, 404);
    // the registry is still serving
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/fine', { token })).status, 200);
  } finally { await srv.close(); }
});
