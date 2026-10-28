import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles, unpackFiles } from '../../extension/lib/tar.js';

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
    // Hand-craft a tar entry with a path-traversal name.
    const evil = Buffer.alloc(1536);
    evil.write('package/../../etc/passwd', 0);
    evil.write('0000644\0', 100); evil.write('00000000001\0', 124); evil.write('0', 156); evil.write('ustar\0', 257);
    const r = await publish(srv, token, zlib.gzipSync(evil));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_tarball');
    const noManifest = await publish(srv, token, packFiles([{ path: 'index.js', data: 'x' }]));
    assert.equal(noManifest.body.error, 'no_manifest');
    const badName = await publish(srv, token, tarball({ name: '../evil', version: '1.0.0' }));
    assert.equal(badName.body.error, 'bad_manifest');
  } finally { await srv.close(); }
});
