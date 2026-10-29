// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Behind a reverse proxy the client address is the one the proxy saw, never one the client typed (AUTH-3 / OPS-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, createUser, tmpDir } from './helpers.js';
import { clientIp } from '../src/http.js';
import { loadConfig } from '../src/config.js';

const KEY = crypto.randomBytes(32).toString('base64');
const cfg = (env) => loadConfig({ GITCHA_SECRET_KEY: KEY, GITCHA_DATA_DIR: tmpDir(), ...env });
const req = (xff, peer = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } });

test('AUTH-3: one proxy in front: the rightmost entry is the client, whatever the client sent before it', () => {
  // nginx appends ($proxy_add_x_forwarded_for): the client's own header stays on the left.
  assert.equal(clientIp(req('1.2.3.4, 203.0.113.7'), true), '203.0.113.7');
  // Caddy replaces: a single entry.
  assert.equal(clientIp(req('203.0.113.7'), true), '203.0.113.7');
  // No header at all: the peer. Trust off: the peer, always.
  assert.equal(clientIp(req(undefined), true), '10.0.0.1');
  assert.equal(clientIp(req('1.2.3.4, 203.0.113.7'), false), '10.0.0.1');
});

test('AUTH-3: an entry that is not an address is never used, however long', () => {
  assert.equal(clientIp(req('<script>alert(1)</script>'), true), '10.0.0.1');
  assert.equal(clientIp(req('x'.repeat(7000)), true), '10.0.0.1');
  assert.equal(clientIp(req('203.0.113.7, not-an-ip'), true), '10.0.0.1');
  assert.equal(clientIp(req('[2001:db8::7]:5000'), true), '2001:db8::7');
  assert.equal(clientIp(req('203.0.113.7:4444'), true), '203.0.113.7');
});

test('AUTH-3: GITCHA_TRUSTED_PROXIES as a hop count and as a list of addresses', () => {
  assert.deepEqual(cfg({ GITCHA_TRUST_PROXY: 'yes' }).trustedProxies, { hops: 1 });
  // Two hops (a CDN, then nginx): chain is client, cdn, peer.
  assert.equal(clientIp(req('198.51.100.9, 203.0.113.7', '10.0.0.1'), true, { hops: 2 }), '198.51.100.9');
  // A list: walk from the right past addresses we trust; stop at the first stranger.
  const trusted = cfg({ GITCHA_TRUST_PROXY: 'on', GITCHA_TRUSTED_PROXIES: '10.0.0.0/8, 203.0.113.7, 2001:db8::/32' }).trustedProxies;
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.9, 203.0.113.7', '10.0.0.1'), true, trusted), '198.51.100.9');
  // A peer that is not a trusted proxy is a direct client: its header is ignored.
  assert.equal(clientIp(req('6.6.6.6', '192.0.2.50'), true, trusted), '192.0.2.50');
  assert.equal(clientIp(req('2001:db8::5', '10.1.2.3'), true, trusted), '2001:db8::5');
  assert.throws(() => cfg({ GITCHA_TRUSTED_PROXIES: '10.0.0.0/99' }), /GITCHA_TRUSTED_PROXIES/);
  assert.throws(() => cfg({ GITCHA_TRUSTED_PROXIES: 'proxy.example' }), /GITCHA_TRUSTED_PROXIES/);
});

test('AUTH-18: GITCHA_TRUST_PROXY takes the same yes/on/true/1 as the other switches', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'On']) assert.equal(cfg({ GITCHA_TRUST_PROXY: v }).trustProxy, true, v);
  for (const v of ['', '0', 'false', 'no', 'off', undefined]) assert.equal(cfg({ GITCHA_TRUST_PROXY: v }).trustProxy, false, String(v));
});

test('AUTH-3: the password limiter keys on the address the proxy saw, so a typed header does not reset it', async () => {
  const srv = await startServer({ overrides: { trustProxy: true } });
  try {
    createUser(srv);
    let last;
    const statuses = [];
    for (let i = 0; i < 14; i++) {
      // A different "client" every time on the left, the same real address (what the proxy appended) on the right.
      const r = await fetch(`${srv.url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${i}, 198.51.100.4` },
        body: JSON.stringify({ username: 'alice', password: `guess-${i}-xxxxxx` }),
      });
      last = r.status; statuses.push(r.status);
    }
    assert.equal(last, 429, `the 11th wrong password from one real address is refused: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    // The address kept for the audit log is the validated one, not the typed one.
    const rows = srv.store.auditFor(srv.store.userByName('alice').id, 50).filter((e) => e.event === 'login.bad_password');
    assert.ok(rows.every((e) => e.ip === '198.51.100.4'), JSON.stringify(rows.map((e) => e.ip)));
  } finally { await srv.close(); }
});

test('AUTH-16: cookies are Secure when a trusted proxy says the request came in over https, and not otherwise', async () => {
  const setCookies = async (srv, headers) => (await fetch(srv.url + '/login', { headers })).headers.getSetCookie().join('\n');
  const behind = await startServer({ env: { GITCHA_TRUST_PROXY: 'true' } }); // PUBLIC_URL is http: the proxy is the only sign of https
  try {
    assert.match(await setCookies(behind, { 'X-Forwarded-Proto': 'https' }), /gitcha_csrf=[^\n]*; Secure/);
    assert.match(await setCookies(behind, { 'X-Forwarded-Proto': 'http, https' }), /gitcha_csrf=[^\n]*; Secure/, 'a chain is read from the proxy nearest us');
    assert.doesNotMatch(await setCookies(behind, { 'X-Forwarded-Proto': 'https, http' }), /Secure/);
    assert.doesNotMatch(await setCookies(behind, { 'X-Forwarded-Proto': 'http' }), /Secure/);
    assert.doesNotMatch(await setCookies(behind, {}), /Secure/);
  } finally { await behind.close(); }
  const direct = await startServer(); // trust off: the header is a stranger's word
  try {
    assert.doesNotMatch(await setCookies(direct, { 'X-Forwarded-Proto': 'https' }), /Secure/);
  } finally { await direct.close(); }
  const https = await startServer({ overrides: { publicUrl: 'https://registry.example', secureCookies: true } });
  try {
    assert.match(await setCookies(https, {}), /gitcha_csrf=[^\n]*; Secure/);
  } finally { await https.close(); }
});

test('AUTH-17: every spelling of one IPv6 network gets one label, and v4-mapped addresses are v4', async () => {
  const { networkOf } = await import('../src/auth.js');
  const spellings = ['2001:db8:0:1::5', '2001:0db8:0000:0001:0:0:0:9', '2001:DB8:0:1:ffff::1', '[2001:db8:0:1::7]:443'];
  assert.equal(new Set(spellings.map(networkOf)).size, 1, spellings.map(networkOf).join(' '));
  assert.equal(networkOf('2001:db8:0:1::5'), '2001:db8:0::/48');
  assert.notEqual(networkOf('2001:db8:1::5'), networkOf('2001:db8:0:1::5'), 'a different /48 is a different network');
  assert.equal(networkOf('::ffff:203.0.113.9'), '203.0.113.0/24');
  assert.equal(networkOf('203.0.113.9'), '203.0.113.0/24');
  assert.equal(networkOf('x'), 'x');
  assert.equal(networkOf(''), 'unknown');
});
