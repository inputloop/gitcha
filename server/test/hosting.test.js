import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, api, deviceLogin, hostGet } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';

const MIN = 60_000;
const env = { GITCHA_HOSTING_DOMAINS: 'pages.test,apps.test' };
const site = (files) => packFiles(Object.entries(files).map(([path, data]) => ({ path, data })));
const deploy = (srv, token, name, files, extra = {}) => api(srv.url, 'PUT', `/api/v1/sites/${name}/deploys`, {
  token, body: { tarball: site(files).toString('base64'), ...extra },
});

async function setup(opts = {}) {
  const srv = await startServer({ env, ...opts });
  const alice = createUser(srv, 'alice', 'first long pass!');
  const token = await deviceLogin(srv, alice);
  return { srv, alice, token };
}

test('create a site, deploy, and serve it on its subdomains only', async () => {
  const { srv, token } = await setup();
  try {
    const c = await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'docs' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.deepEqual(c.body.urls, ['https://docs.pages.test/', 'https://docs.apps.test/']);

    const d = await deploy(srv, token, 'docs', {
      'index.html': '<h1>Hello</h1>', 'about.html': 'about', 'guide/index.html': 'guide', 'app.js': 'x()',
      'gitcha.site.json': JSON.stringify({ headers: { 'X-Frame-Options': 'DENY', 'Set-Cookie': 'evil=1' } }),
    });
    assert.equal(d.status, 201, JSON.stringify(d.body));

    const home = await hostGet(srv.url, 'docs.pages.test', '/');
    assert.equal(home.status, 200);
    assert.equal(home.body, '<h1>Hello</h1>');
    assert.match(home.headers['content-type'], /text\/html/);
    assert.equal(home.headers['x-frame-options'], 'DENY');
    assert.equal(home.headers['set-cookie'], undefined, 'sites cannot set cookie headers through config');
    assert.equal((await hostGet(srv.url, 'docs.apps.test:443', '/about')).body, 'about', 'pretty URLs');
    assert.equal((await hostGet(srv.url, 'docs.pages.test', '/guide/')).body, 'guide');
    assert.match((await hostGet(srv.url, 'docs.pages.test', '/app.js')).headers['content-type'], /javascript/);
    assert.equal((await hostGet(srv.url, 'docs.pages.test', '/missing')).status, 404);
    assert.equal((await hostGet(srv.url, 'nope.pages.test', '/')).status, 404);

    // Hosted names never reach the Gitcha API or UI, so user JS can't call it same-origin.
    assert.equal((await hostGet(srv.url, 'docs.pages.test', '/api/v1/health')).status, 404);
    assert.equal((await hostGet(srv.url, 'docs.pages.test', '/login')).status, 404);
    // And the Gitcha host doesn't serve site files.
    assert.equal((await hostGet(srv.url, new URL(srv.url).host, '/about.html')).status, 404);
  } finally { await srv.close(); }
});

test('path traversal and dotfiles outside the deploy are refused', async () => {
  const { srv, token } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'safe' } });
    await deploy(srv, token, 'safe', { 'index.html': 'ok' });
    for (const p of ['/../../db.json', '/%2e%2e/%2e%2e/db.json', '/..%2f..%2fsecret.key', '/%00']) {
      const r = await hostGet(srv.url, 'safe.pages.test', p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('users'), p);
    }
  } finally { await srv.close(); }
});

test('SPA fallback, custom 404 page, rollback and pruning', async () => {
  const { srv, token } = await setup({ overrides: { hosting: { keepDeploys: 2 } } });
  try {
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'app' } });
    await deploy(srv, token, 'app', { 'index.html': 'v1', '404.html': 'gone' });
    assert.equal((await hostGet(srv.url, 'app.pages.test', '/x/y')).body, 'gone');
    const v2 = await deploy(srv, token, 'app', { 'index.html': 'v2', 'gitcha.site.json': '{"spa": true}' });
    assert.equal((await hostGet(srv.url, 'app.pages.test', '/x/y')).body, 'v2', 'spa serves index.html');
    const info = await api(srv.url, 'GET', '/api/v1/sites/app', { token });
    const first = info.body.deploys.at(-1).id;
    assert.equal((await api(srv.url, 'POST', `/api/v1/sites/app/deploys/${first}/activate`, { token })).status, 200);
    assert.equal((await hostGet(srv.url, 'app.pages.test', '/')).body, 'v1', 'rollback');
    await deploy(srv, token, 'app', { 'index.html': 'v3' }, { activate: false });
    assert.equal((await hostGet(srv.url, 'app.pages.test', '/')).body, 'v1', 'inactive deploy not served');
    const after = await api(srv.url, 'GET', '/api/v1/sites/app', { token });
    assert.equal(after.body.deploys.length, 2, 'old deploys pruned');
    assert.ok(after.body.deploys.some((d) => d.id === first && d.active), 'active deploy is never pruned');
    assert.ok(!after.body.deploys.some((d) => d.id === v2.body.id));
  } finally { await srv.close(); }
});

test('deploying needs a fresh code; names are validated', async () => {
  const { srv, alice, token } = await setup();
  try {
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'Bad_Name' } })).body.error, 'bad_site_name');
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'admin' } })).body.error, 'site_reserved');
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'blog' } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'blog' } })).status, 409);
    srv.clock.advance(11 * MIN);
    const r = await deploy(srv, token, 'blog', { 'index.html': 'x' });
    assert.equal(r.body.reason, 'sensitive_action');
    await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: alice.nextCode() } });
    assert.equal((await deploy(srv, token, 'blog', { 'index.html': 'x' })).status, 201);
  } finally { await srv.close(); }
});

test('custom domains are served only after DNS TXT verification', async () => {
  const txt = {};
  const resolver = { resolveTxt: async (name) => { if (!txt[name]) { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; } return [[txt[name]]]; } };
  const { srv, token } = await setup({ appOpts: { resolver } });
  try {
    await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 'shop' } });
    await deploy(srv, token, 'shop', { 'index.html': 'shop' });
    const add = await api(srv.url, 'POST', '/api/v1/sites/shop/domains', { token, body: { hostname: 'Shop.Example.COM.' } });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(add.body.hostname, 'shop.example.com');
    assert.equal(add.body.dns.txt.name, '_gitcha-challenge.shop.example.com');
    assert.equal(add.body.dns.cname.value, 'shop.pages.test');

    assert.equal((await hostGet(srv.url, 'shop.example.com', '/')).status, 404, 'unverified domain not served');
    assert.equal((await api(srv.url, 'GET', '/api/v1/hosting/tls-allowed?domain=shop.example.com')).status, 404);
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites/shop/domains/shop.example.com/verify', { token })).body.error, 'dns_not_ready');
    txt['_gitcha-challenge.shop.example.com'] = 'wrong';
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites/shop/domains/shop.example.com/verify', { token })).body.error, 'dns_mismatch');
    txt['_gitcha-challenge.shop.example.com'] = add.body.dns.txt.value;
    const v = await api(srv.url, 'POST', '/api/v1/sites/shop/domains/shop.example.com/verify', { token });
    assert.equal(v.body.verified, true);
    assert.equal((await hostGet(srv.url, 'shop.example.com', '/')).body, 'shop');
    assert.equal((await api(srv.url, 'GET', '/api/v1/hosting/tls-allowed?domain=shop.example.com')).status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/v1/hosting/tls-allowed?domain=shop.pages.test')).status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/v1/hosting/tls-allowed?domain=random.pages.test')).status, 404);

    for (const bad of ['localhost', '127.0.0.1', 'x.pages.test', 'a..b.com', 'localhost:4873']) {
      assert.equal((await api(srv.url, 'POST', '/api/v1/sites/shop/domains', { token, body: { hostname: bad } })).status, 400, bad);
    }
  } finally { await srv.close(); }
});

test('team sites: maintainers deploy, members see, outsiders do not', async () => {
  const { srv, token } = await setup();
  try {
    const bob = createUser(srv, 'bob', 'second long pass');
    const tb = await deviceLogin(srv, bob);
    const carol = createUser(srv, 'carol', 'third long pass!');
    const tc = await deviceLogin(srv, carol);
    await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token, body: { role: 'maintainer' } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token: tc, body: { name: 'acme-site', team: 'acme' } })).status, 403);
    assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token: tb, body: { name: 'acme-site', team: 'acme' } })).status, 201);
    assert.equal((await deploy(srv, token, 'acme-site', { 'index.html': 'team' })).status, 201, 'team owner can deploy');
    assert.equal((await deploy(srv, tc, 'acme-site', { 'index.html': 'no' })).status, 404, 'outsider cannot');
    assert.equal((await api(srv.url, 'GET', '/api/v1/sites/acme-site', { token: tc })).status, 404);
  } finally { await srv.close(); }
});

test('the ring: manifest, prev/next/random, announcements need admin approval', async () => {
  const peers = {
    'https://b.example': { name: 'B Gitcha', description: 'Community instance', features: { hosting: true, paid: ['functions', 'private sites'] } },
    'https://c.example': { name: '<script>alert(1)</script>', features: {} },
  };
  const fetchImpl = async (url) => {
    const origin = new URL(url).origin;
    if (!peers[origin]) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(peers[origin]) };
  };
  const { srv, token } = await setup({
    appOpts: { fetchImpl },
    overrides: { publicUrl: 'https://a.example', ring: { peers: ['https://b.example', 'ftp://bad', 'https://a.example'], name: 'A', operator: 'inputloop' } },
  });
  try {
    const m = await api(srv.url, 'GET', '/.well-known/gitcha-ring.json');
    assert.equal(m.status, 200);
    assert.equal(m.body.format, 'gitcha-ring');
    assert.deepEqual(m.body.ring.members, ['https://b.example'], 'bad and self entries dropped');
    assert.equal(m.body.features.hosting, true);

    const next = await fetch(`${srv.url}/ring/next`, { redirect: 'manual' });
    assert.equal(next.headers.get('location'), 'https://b.example');

    const ann = await api(srv.url, 'POST', '/api/v1/ring/announce', { body: { url: 'https://c.example/some/path' } });
    assert.equal(ann.status, 202);
    assert.equal(ann.body.status, 'pending');
    assert.equal((await api(srv.url, 'POST', '/api/v1/ring/announce', { body: { url: 'https://unknown.example' } })).body.error, 'ring_unreachable');
    assert.deepEqual((await api(srv.url, 'GET', '/.well-known/gitcha-ring.json')).body.ring.members, ['https://b.example'], 'pending peers are not listed');

    const dec = await api(srv.url, 'POST', '/api/v1/ring/decide', { token, body: { url: 'https://c.example', approve: true } });
    assert.equal(dec.body.status, 'approved');
    assert.deepEqual((await api(srv.url, 'GET', '/.well-known/gitcha-ring.json')).body.ring.members, ['https://b.example', 'https://c.example']);

    await srv.ring.refresh();
    const members = (await api(srv.url, 'GET', '/api/v1/ring')).body.members;
    const b = members.find((x) => x.url === 'https://b.example');
    assert.deepEqual(b.paid, ['functions', 'private sites']);
    assert.equal(b.ok, true);
  } finally { await srv.close(); }
});
