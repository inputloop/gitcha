// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Git hosting hardening: the smart-HTTP handler under bad requests, the SSH helper
// endpoints, push records, and signature checks (real git and gpg).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, createUser, deviceLogin, api } from './helpers.js';

let srv, ta, tb, port;
// An uncaught exception ends the real server, so a test that sees one has seen the outage.
const crashes = [];
process.on('uncaughtException', (err) => { crashes.push(err); });

const basic = (user, token) => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** A raw request with a body, so the content type can be anything. */
function raw(method, p, { headers = {}, body, abortAfter } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    req.on('close', () => resolve({ error: 'closed' }));
    if (abortAfter !== undefined) { req.write(body.subarray(0, abortAfter)); setTimeout(() => req.destroy(), 50); } else req.end(body);
  });
}

before(async () => {
  srv = await startServer({ env: { GITCHA_HOSTING_DOMAINS: 'pages.test' } });
  port = new URL(srv.url).port;
  const alice = createUser(srv, 'alice', 'first long pass!');
  const bob = createUser(srv, 'bob', 'second long pass');
  ta = await deviceLogin(srv, alice);
  tb = await deviceLogin(srv, bob);
  srv.projects.create(srv.store.userByName('alice'), { name: 'epipe', visibility: 'public' }, '127.0.0.1');
});
after(() => srv.close());

test('GIT-1: a POST with the wrong content type is refused and the server stays up', async () => {
  crashes.length = 0;
  const big = Buffer.alloc(256 * 1024, 0x41);
  const r = await raw('POST', '/git/alice/epipe.git/git-upload-pack', {
    headers: { Authorization: basic('bob', tb), 'Content-Type': 'text/plain', 'Content-Length': big.length }, body: big,
  });
  assert.ok([400, 415].includes(r.status), `answered ${JSON.stringify(r)}`);
  const owner = await raw('POST', '/git/alice/epipe.git/git-receive-pack', {
    headers: { Authorization: basic('alice', ta), 'Content-Type': 'application/json', 'Content-Length': 8 * 1024 * 1024 }, body: Buffer.alloc(8 * 1024 * 1024, 0x42),
  });
  assert.ok([400, 415].includes(owner.status) || owner.error, `owner variant ${JSON.stringify(owner)}`);
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(crashes.map((e) => e.code ?? e.message), [], 'no uncaught exception (EPIPE) in the send path');
  assert.equal((await api(srv.url, 'GET', '/api/v1/health')).status, 200, 'the server answers after the bad request');
});

test('GIT-1: a client that closes early does not stop the server', async () => {
  crashes.length = 0;
  const big = Buffer.alloc(4 * 1024 * 1024, 0x43);
  const r = await raw('POST', '/git/alice/epipe.git/git-upload-pack', {
    headers: { Authorization: basic('bob', tb), 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Length': big.length }, body: big, abortAfter: 64 * 1024,
  });
  assert.ok(r.error, 'the client went away');
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(crashes.map((e) => e.code ?? e.message), []);
  assert.equal((await api(srv.url, 'GET', '/api/v1/health')).status, 200);
});
