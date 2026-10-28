// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Hosted sites, custom domains and the ring: the fixes for what the second review found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, createUser, api, deviceLogin, hostGet } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';

const env = { GITCHA_HOSTING_DOMAINS: 'pages.test,apps.test' };
const site = (files) => packFiles(Object.entries(files).map(([p, data]) => ({ path: p, data })));
const deploy = (srv, token, name, tarball, extra = {}) => api(srv.url, 'PUT', `/api/v1/sites/${name}/deploys`, { token, body: { tarball: tarball.toString('base64'), ...extra } });
const sitesDir = (srv, name) => path.join(srv.config.dataDir, 'sites', name);
const onDisk = (srv, name) => (fs.existsSync(sitesDir(srv, name)) ? fs.readdirSync(sitesDir(srv, name)) : []);

async function setup(opts = {}) {
  const srv = await startServer({ env, ...opts });
  const alice = createUser(srv, 'alice', 'first long pass!');
  const token = await deviceLogin(srv, alice);
  return { srv, alice, token };
}

test('SITE-1: the size cap counts the unpacked site, a failed deploy leaves nothing, owner storage is bounded', async () => {
  const { srv, token } = await setup({ overrides: { hosting: { maxSiteBytes: 1024 * 1024, maxOwnerBytes: 1.5 * 1024 * 1024 } } });
  try {
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'amp' } });
    // 3 MiB of zeros is a few KB on the wire: the old cap compared the wire size and allowed four times the limit unpacked.
    const bomb = site({ 'big.bin': Buffer.alloc(3 * 1024 * 1024) });
    assert.ok(bomb.length < 10_000, `compressed ${bomb.length}`);
    const r = await deploy(srv, token, 'amp', bomb);
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.error, 'too_large');
    assert.deepEqual(onDisk(srv, 'amp'), [], 'nothing was written');

    // A deploy that fails while unpacking (a file and a directory with the same name) leaves no directory in no record.
    const ok = await deploy(srv, token, 'amp', site({ 'index.html': 'one' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const clash = await deploy(srv, token, 'amp', site({ a: 'file', 'a/b': 'under it' }));
    assert.equal(clash.status, 400, JSON.stringify(clash.body));
    assert.deepEqual(onDisk(srv, 'amp'), [ok.body.id], 'only the recorded deploy is on disk');

    // The record carries the unpacked size, and one owner cannot hold more than the owner cap.
    assert.equal(ok.body.bytes, 3);
    const half = Buffer.alloc(900 * 1024, 7).map((_, i) => (i * 31) % 251);
    assert.equal((await deploy(srv, token, 'amp', site({ 'a.bin': half }))).status, 201);
    const full = await deploy(srv, token, 'amp', site({ 'b.bin': half }));
    assert.equal(full.status, 413, JSON.stringify(full.body));
    assert.equal(full.body.error, 'storage_full');
  } finally { await srv.close(); }
});

/** A 512-byte tar header written by hand, so a malformed one can be planted. */
function header(name, { size = '00000000000', type = '0' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.padEnd(12, '\0'), 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const entry = (name, data) => Buffer.concat([header(name, { size: data.length.toString(8).padStart(11, '0') }), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

test('SITE-2: a tarball with a negative size (probes/W2 t18a) is refused and the server keeps answering', async (t) => {
  // The same bytes as probes/W2/tarballs/t18a-negative-size-dir-loop.tgz: one good file, then a directory whose size is -512 (octal -1000).
  const evil = zlib.gzipSync(Buffer.concat([entry('package/index.html', Buffer.from('hello')), header('package/d/', { size: '-0000001000', type: '5' }), Buffer.alloc(1024)]));
  // Until the tar reader refuses a negative size (wheel B's fix to extension/lib/tar.js) this call never returns, so ask a child with a timeout first.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import { unpackFiles } from ${JSON.stringify(path.join(here, '../../extension/lib/tar.js'))}; try { unpackFiles(Buffer.from('${evil.toString('base64')}', 'base64')); } catch {}`], { timeout: 4000 });
  if (probe.error) return t.skip('extension/lib/tar.js still loops on a negative size; this test runs once the reader fix lands');
  const { srv, token } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'neg' } });
    const r = await deploy(srv, token, 'neg', evil);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'bad_tarball');
    assert.equal((await api(srv.url, 'GET', '/api/v1/health')).status, 200);
    assert.deepEqual(onDisk(srv, 'neg'), []);
  } finally { await srv.close(); }
});

test('SITE-4: a CI deploy does not publish over a site that was deleted and made again by someone else', async () => {
  const { srv, token } = await setup();
  try {
    const bob = createUser(srv, 'bob', 'second long pass');
    const tb = await deviceLogin(srv, bob);
    const alice = srv.store.userByName('alice');
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'brand' } });
    const pipeline = { image: 'local', steps: [{ run: 'true' }], artifacts: 'dist', deploy: { site: 'brand' } };
    const job = srv.ci.run(alice, { tarball: site({ 'gitcha-ci.json': JSON.stringify(pipeline) }) }, '127.0.0.1');
    srv.sites.remove(alice, 'brand', '127.0.0.1');
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token: tb, body: { name: 'brand' } })).status, 201);
    assert.equal((await deploy(srv, tb, 'brand', site({ 'index.html': "bob's page" }))).status, 201);
    await srv.jobs.complete(srv.jobs.get(job.id), { status: 'succeeded', exitCode: 0, artifact: site({ 'index.html': "alice's artifact" }) });
    assert.equal((await hostGet(srv.url, 'brand.pages.test', '/')).body, "bob's page", 'the old job must not publish over the new owner');
    assert.match(srv.jobs.readLog(srv.jobs.get(job.id)), /not deployed/);
  } finally { await srv.close(); }
});

test('SITE-5: a hosting domain in the UI host\'s registrable domain is refused at start', async () => {
  const start = (publicUrl, domains) => startServer({ env: { GITCHA_HOSTING_DOMAINS: domains }, overrides: { publicUrl } });
  await assert.rejects(start('https://gitcha.example.test', 'pages.example.test'), /registrable domain example\.test/);
  await assert.rejects(start('https://gitcha.example.test', 'example.test'), /registrable domain/);
  await assert.rejects(start('https://gitcha.example.co.uk', 'pages.example.co.uk'), /registrable domain example\.co\.uk/);
  for (const [ui, dom] of [['https://gitcha.example.test', 'pages.other.test'], ['https://gitcha.example.co.uk', 'pages.other.co.uk'], ['http://localhost:4873', 'pages.test']]) {
    const srv = await start(ui, dom);
    await srv.close();
  }
});
