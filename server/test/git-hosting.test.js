// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Git hosting hardening: the smart-HTTP handler under bad requests, the SSH helper
// endpoints, push records, and signature checks (real git and gpg).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, createUser, deviceLogin, api } from './helpers.js';

let srv, ta, tb, port, alice, bob;
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
  alice = createUser(srv, 'alice', 'first long pass!');
  bob = createUser(srv, 'bob', 'second long pass');
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

// ---- SSH helper endpoints (what gitcha-git-shell asks) -----------------------------------------------------
const sshLine = () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const str = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  return `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')} test@host`;
};
const internal = (p, body) => fetch(`${srv.url}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitcha-Internal': fs.readFileSync(path.join(srv.config.dataDir, 'internal.key'), 'utf8').trim() }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

test('GIT-2: an SSH key is held to the same periodic 2FA check as an HTTPS token', async () => {
  const bobRec = srv.store.userByName('bob');
  const k = srv.keys.addSsh(bobRec, { kind: 'user', id: bobRec.id, name: 'bob' }, { key: sshLine() }, '127.0.0.1');
  srv.projects.create(bobRec, { name: 'sshrepo', visibility: 'private' }, '127.0.0.1');
  const ask = () => internal('/internal/git/authorize', { fingerprint: k.fingerprint, command: "git-receive-pack 'bob/sshrepo.git'" });
  assert.equal((await ask()).status, 200, 'a fresh check lets the push through');
  srv.clock.advance(13 * 3600_000); // past the 12 h interval
  const late = await ask();
  assert.equal(late.status, 403, JSON.stringify(late.body));
  assert.equal(late.body.error, 'stepup_due');
  assert.match(late.body.message, /gitcha verify/, 'the helper can print what to run');
  const read = await internal('/internal/git/authorize', { fingerprint: k.fingerprint, command: "git-upload-pack 'bob/sshrepo.git'" });
  assert.equal(read.status, 403, 'reads of a private repository are checked too');
  await api(srv.url, 'POST', '/api/v1/auth/step-up', { token: tb, body: { code: bob.nextCode() } });
  assert.equal((await ask()).status, 200, 'a new code on any of the person\'s devices opens the window again');
});

test('INT-1: /internal answers JSON and a 64-character non-ASCII header is a 404, not a 500', async () => {
  const wrong = await fetch(`${srv.url}/internal/ssh/keys?fingerprint=x`, { headers: { 'X-Gitcha-Internal': 'é'.repeat(64) } });
  assert.equal(wrong.status, 404);
  const none = await fetch(`${srv.url}/internal/git/authorize`, { method: 'POST', body: '{}' });
  assert.equal(none.status, 404);
  assert.match(none.headers.get('content-type'), /json/);
});
