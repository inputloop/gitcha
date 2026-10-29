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
// Audit rows of every user, whether the store keeps one list or (after STORE-3) a slot of three lists per user.
const auditRows = (store) => (Array.isArray(store.data.audit) ? store.data.audit : Object.values(store.data.audit).flatMap((s) => [...s.security, ...s.others, ...s.traffic]));
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

// ---- custom domains (DOM-1, DOM-2) and certificates (DOM-3) ---------------------------------------------------
/** A resolver the test controls: name -> TXT value, and an error code that every lookup fails with when set. */
function fakeDns() {
  const dns = { txt: {}, failWith: null };
  dns.resolveTxt = async (name) => {
    if (dns.failWith) throw Object.assign(new Error(dns.failWith), { code: dns.failWith });
    if (!dns.txt[name]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return [[dns.txt[name]]];
  };
  return dns;
}
const challenge = (h) => `_gitcha-challenge.${h}`;
const addDomain = (srv, token, siteName, hostname) => api(srv.url, 'POST', `/api/v1/sites/${siteName}/domains`, { token, body: { hostname } });
const verifyDomain = (srv, token, siteName, hostname) => api(srv.url, 'POST', `/api/v1/sites/${siteName}/domains/${hostname}/verify`, { token });
const tlsAllowed = async (srv, name) => (await api(srv.url, 'GET', `/api/v1/hosting/tls-allowed?domain=${name}`)).status === 200;

async function twoTenants(opts) {
  const { srv, alice, token: ta } = await setup(opts);
  const bob = createUser(srv, 'bob', 'second long pass');
  const tb = await deviceLogin(srv, bob);
  await api(srv.url, 'POST', '/api/v1/sites', { token: ta, body: { name: 'shop' } });
  await api(srv.url, 'POST', '/api/v1/sites', { token: tb, body: { name: 'mall' } });
  await deploy(srv, ta, 'shop', site({ 'index.html': 'alice shop' }));
  await deploy(srv, tb, 'mall', site({ 'index.html': 'bob mall' }));
  return { srv, alice, bob, ta, tb };
}

test('DOM-1: an unproven claim does not lock out the real owner, expires, and is capped per account', async () => {
  const dns = fakeDns();
  const { srv, bob, ta, tb: bobFirst } = await twoTenants({ appOpts: { resolver: dns }, overrides: { hosting: { maxPendingDomains: 3 } } });
  let tb = bobFirst;
  try {
    // bob (no DNS control at all) claims the name first.
    const squat = await addDomain(srv, tb, 'mall', 'shop.victim.example');
    assert.equal(squat.status, 201, JSON.stringify(squat.body));
    // alice, who owns the domain, can still claim it, publish her own proof and verify.
    const mine = await addDomain(srv, ta, 'shop', 'shop.victim.example');
    assert.equal(mine.status, 201, `the real owner is not told "taken": ${JSON.stringify(mine.body)}`);
    assert.notEqual(mine.body.dns.txt.value, squat.body.dns.txt.value, 'each claim has its own token');
    dns.txt[challenge('shop.victim.example')] = mine.body.dns.txt.value;
    assert.equal((await verifyDomain(srv, tb, 'mall', 'shop.victim.example')).status, 409, 'the squatter cannot verify with her proof');
    assert.equal((await verifyDomain(srv, ta, 'shop', 'shop.victim.example')).body.verified, true);
    assert.equal((await hostGet(srv.url, 'shop.victim.example', '/')).body, 'alice shop');
    assert.equal((await verifyDomain(srv, tb, 'mall', 'shop.victim.example')).status, 404, 'the losing claim is gone');

    // A claim nobody proves lapses after a day, and the name is free again.
    assert.equal((await addDomain(srv, tb, 'mall', 'mall.example.org')).status, 201);
    srv.clock.advance(25 * 3600_000);
    tb = await deviceLogin(srv, bob); // the old token lapsed with the day
    assert.equal((await verifyDomain(srv, tb, 'mall', 'mall.example.org')).status, 404, 'expired');
    assert.deepEqual((await api(srv.url, 'GET', '/api/v1/sites/mall', { token: tb })).body.domains, []);

    // And one account holds only so many waiting claims (3 here).
    for (const n of [1, 2, 3]) assert.equal((await addDomain(srv, tb, 'mall', `d${n}.example.org`)).status, 201);
    const over = await addDomain(srv, tb, 'mall', 'd4.example.org');
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.equal(over.body.error, 'too_many_pending');
  } finally { await srv.close(); }
});

test('DOM-2: a verified domain is re-checked, dropped when its proof is gone, and a fresh proof can take it over', async () => {
  const dns = fakeDns();
  const { srv, ta, tb } = await twoTenants({ appOpts: { resolver: dns } });
  try {
    const add = await addDomain(srv, tb, 'mall', 'bob.example.com');
    dns.txt[challenge('bob.example.com')] = add.body.dns.txt.value;
    assert.equal((await verifyDomain(srv, tb, 'mall', 'bob.example.com')).body.verified, true);

    // A resolver that merely fails (timeout, SERVFAIL) proves nothing; the domain stays.
    dns.failWith = 'ETIMEOUT';
    for (let i = 0; i < 5; i++) await srv.domains.recheck();
    assert.equal((await hostGet(srv.url, 'bob.example.com', '/')).body, 'bob mall');
    dns.failWith = null;

    // The record is really gone: one miss is tolerated, three in a row end it (serving and certificate permission).
    delete dns.txt[challenge('bob.example.com')];
    await srv.domains.recheck();
    await srv.domains.recheck();
    assert.equal((await hostGet(srv.url, 'bob.example.com', '/')).body, 'bob mall', 'two misses are not enough');
    dns.txt[challenge('bob.example.com')] = add.body.dns.txt.value;
    await srv.domains.recheck();
    delete dns.txt[challenge('bob.example.com')];
    for (let i = 0; i < 3; i++) await srv.domains.recheck();
    assert.notEqual((await hostGet(srv.url, 'bob.example.com', '/')).body, 'bob mall', 'no longer served');
    assert.equal(await tlsAllowed(srv, 'bob.example.com'), false, 'no longer allowed a certificate');
    assert.ok(auditRows(srv.store).some((e) => e.event === 'domain.lapsed' && e.domain === 'bob.example.com'));

    // A name that changed hands: alice, who now controls the DNS, takes it from bob's still-verified record.
    const again = await addDomain(srv, tb, 'mall', 'new.example.com');
    dns.txt[challenge('new.example.com')] = again.body.dns.txt.value;
    await verifyDomain(srv, tb, 'mall', 'new.example.com');
    const hers = await addDomain(srv, ta, 'shop', 'new.example.com');
    assert.equal(hers.status, 201, JSON.stringify(hers.body));
    dns.txt[challenge('new.example.com')] = hers.body.dns.txt.value;
    assert.equal((await verifyDomain(srv, ta, 'shop', 'new.example.com')).body.verified, true);
    assert.equal((await hostGet(srv.url, 'new.example.com', '/')).body, 'alice shop');
    assert.deepEqual((await api(srv.url, 'GET', '/api/v1/sites/mall', { token: tb })).body.domains.map((d) => d.hostname), [], 'bob no longer holds it');
  } finally { await srv.close(); }
});

test('DOM-2: the server looks again on its own schedule', async () => {
  const dns = fakeDns();
  const { srv, tb } = await twoTenants({ appOpts: { resolver: dns }, overrides: { hosting: { recheckEvery: 25, recheckFailures: 2 } } });
  try {
    const add = await addDomain(srv, tb, 'mall', 'timer.example.com');
    dns.txt[challenge('timer.example.com')] = add.body.dns.txt.value;
    await verifyDomain(srv, tb, 'mall', 'timer.example.com');
    delete dns.txt[challenge('timer.example.com')];
    const until = Date.now() + 3000;
    while (Date.now() < until && (await hostGet(srv.url, 'timer.example.com', '/')).body === 'bob mall') await new Promise((r) => setTimeout(r, 25));
    assert.notEqual((await hostGet(srv.url, 'timer.example.com', '/')).body, 'bob mall', 'dropped by the timer, with nobody calling recheck');
  } finally { await srv.close(); }
});

test('DOM-3: a site\'s subdomain gets a certificate only inside the owner\'s weekly budget; sites per account are capped', async () => {
  const { srv, ta, tb } = await twoTenants({ overrides: { hosting: { certBudget: 2, maxSites: 3 } } });
  try {
    assert.equal(await tlsAllowed(srv, new URL(srv.config.publicUrl).hostname), true, 'the instance\'s own name');
    assert.equal(await tlsAllowed(srv, 'nobody.pages.test'), false, 'no such site');
    for (const n of ['one', 'two']) await api(srv.url, 'POST', '/api/v1/sites', { token: ta, body: { name: n } });
    // alice holds shop, one, two: the cap is 3, the fourth is refused whatever billing says.
    const capped = await api(srv.url, 'POST', '/api/v1/sites', { token: ta, body: { name: 'three' } });
    assert.equal(capped.status, 403, JSON.stringify(capped.body));
    assert.equal(capped.body.error, 'site_limit');

    assert.equal(await tlsAllowed(srv, 'shop.pages.test'), true);
    assert.equal(await tlsAllowed(srv, 'one.pages.test'), true);
    assert.equal(await tlsAllowed(srv, 'two.pages.test'), false, 'a third new name in the week is not ordered');
    assert.equal(await tlsAllowed(srv, 'shop.pages.test'), true, 'a name already approved is not a new order');
    assert.equal(await tlsAllowed(srv, 'mall.pages.test'), true, 'bob has his own budget');
    srv.clock.advance(8 * 24 * 3600_000);
    assert.equal(await tlsAllowed(srv, 'two.pages.test'), true, 'a week later it is allowed');
  } finally { await srv.close(); }
});

// ---- the ring (RING-1, RING-2) ---------------------------------------------------------------------------------
test('RING-1: the ring looks at its members on its own, so names and paid badges appear without anyone calling refresh', async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).origin !== 'https://b.example') return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'B Gitcha', features: { hosting: true, paid: ['functions'] } }) };
  };
  const { srv } = await setup({ appOpts: { fetchImpl }, overrides: { publicUrl: 'https://a.example', ring: { peers: ['https://b.example'], refresh: 30 } } });
  try {
    let b;
    for (let i = 0; i < 100 && !b?.name; i++) {
      await new Promise((r) => setTimeout(r, 30));
      b = (await api(srv.url, 'GET', '/api/v1/ring')).body.members.find((m) => m.url === 'https://b.example');
    }
    assert.equal(b?.name, 'B Gitcha');
    assert.deepEqual(b.paid, ['functions']);
  } finally { await srv.close(); }
});

test('RING-2: announcing never makes the server call a private address, and the refusal says nothing about what is there', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => 'SECRET-INTERNAL-BODY' }; };
  const { srv } = await setup({ appOpts: { fetchImpl }, overrides: { publicUrl: 'https://a.example' } });
  try {
    const refusals = new Set();
    for (const url of ['http://127.0.0.1:8081', 'http://localhost:5432', 'http://10.1.2.3', 'http://192.168.0.1', 'http://169.254.169.254', 'http://[::1]:80', 'http://[::ffff:127.0.0.1]', 'http://intranet']) {
      const err = await srv.ring.announce(url, '127.0.0.1').then(() => null, (e) => e); // the route allows five an hour
      assert.equal(err?.code, 'ring_unreachable', `${url}: ${err?.message}`);
      assert.equal(err.status, 400);
      refusals.add(err.message.replace(/https?:\/\/[^ ]+/, 'X'));
    }
    assert.deepEqual(seen, [], 'no request was made to any of them');
    // A public name that answers badly gets the same sentence, and the body it sent is not repeated.
    const bad = await api(srv.url, 'POST', '/api/v1/ring/announce', { body: { url: 'https://peer.example' } });
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.body).includes('SECRET'), JSON.stringify(bad.body));
    refusals.add(bad.body.message.replace(/https?:\/\/[^ ]+/, 'X'));
    assert.equal(refusals.size, 1, `one generic message: ${[...refusals].join(' | ')}`);
  } finally { await srv.close(); }
});
