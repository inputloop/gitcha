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
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

// ---- what a push records (GIT-3, GIT-4, GIT-5): real git and gpg, the push read by the service ------------------
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fs.chmodSync(d, 0o700); return d; };
const GIT = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...GIT, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A signing key that lives in its own gnupg home; `armored` is the public half. */
function gpgKey(label) {
  const home = tmp('gitcha-gk-');
  execFileSync('gpg', ['--homedir', home, '--batch', '--passphrase', '', '--quick-gen-key', `${label} <${label}@example.test>`, 'ed25519', 'sign', 'never'], { stdio: 'ignore' });
  const fpr = execFileSync('gpg', ['--homedir', home, '--with-colons', '--list-keys'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('fpr:')).split(':')[9];
  return { home, fpr, armored: execFileSync('gpg', ['--homedir', home, '--armor', '--export', fpr], { encoding: 'utf8' }) };
}

/** A work tree to commit in; commit() can sign, and push() sends it to the project's repository and reads the push. */
function work(project) {
  const dir = tmp('gitcha-work-');
  git(dir, ['init', '-q', '-b', 'main']);
  return {
    dir,
    commit(message, { key, as = 'Linus Torvalds' } = {}) {
      fs.writeFileSync(path.join(dir, 'f.txt'), crypto.randomUUID());
      git(dir, ['add', '-A']);
      git(dir, ['-c', `user.name=${as}`, '-c', 'user.email=l@example.test', 'commit', '-q', '--cleanup=verbatim', ...(key ? [`-S${key.fpr}`] : []), '-m', message], key ? { GNUPGHOME: key.home } : {});
      return git(dir, ['rev-parse', 'HEAD']);
    },
    async push(principal) {
      const before = srv.projects.refs(project);
      git(dir, ['push', '-q', '--force', srv.projects.repoDir(project), 'main:refs/heads/main']);
      return srv.projects.afterPush(project, principal, before);
    },
  };
}
const asUser = (name) => ({ kind: 'user', user: srv.store.userByName(name) });
const holder = (name) => ({ kind: 'user', id: srv.store.userByName(name).id, name });

test('GIT-3: a key someone else registered does not make the pusher\'s commit "verified" as that someone', async () => {
  const carol = createUser(srv, 'carol', 'third long pass!');
  void carol;
  const p = srv.projects.create(srv.store.userByName('bob'), { name: 'signed', visibility: 'public' }, '127.0.0.1');
  const bobKey = gpgKey('bob');
  // mallory registers bob's PUBLIC key before bob does; nothing asks her to prove she holds it.
  createUser(srv, 'mallory', 'fourth long pass');
  srv.keys.addGpg(srv.store.userByName('mallory'), holder('mallory'), { key: bobKey.armored }, '127.0.0.1');

  const w = work(p);
  w.commit('signed by bob, authored as someone else', { key: bobKey });
  const pushed = await w.push(asUser('bob'));
  assert.equal(pushed.commits.length, 1);
  assert.equal(pushed.commits[0].verified, false, `bob's push is not credited to the squatter: ${JSON.stringify(pushed.commits[0])}`);
  assert.equal(pushed.commits[0].signer, null);

  // The one who registered the key is who it counts for: carol registers her own key and her signed commit verifies.
  const carolKey = gpgKey('carol');
  srv.keys.addGpg(srv.store.userByName('carol'), holder('carol'), { key: carolKey.armored }, '127.0.0.1');
  const pc = srv.projects.create(srv.store.userByName('carol'), { name: 'hers', visibility: 'public' }, '127.0.0.1');
  const wc = work(pc);
  wc.commit('signed by carol', { key: carolKey });
  const hers = await wc.push(asUser('carol'));
  assert.equal(hers.commits[0].verified, true, JSON.stringify(hers.commits[0]));
  assert.equal(hers.commits[0].signer, 'user:carol');
});

test('GIT-4: a message with the old record separators adds no records and no agent credit', async () => {
  const aliceRec = srv.store.userByName('alice');
  srv.agents.register(aliceRec, { handle: 'ada', name: 'Ada', model: 'claude-opus-5-5' }, '127.0.0.1');
  const p = srv.projects.create(aliceRec, { name: 'forged', visibility: 'public' }, '127.0.0.1');
  const byline = 'Ada (for alice, claude-opus-5-5)';
  const fake = `\x1e${'d'.repeat(40)}\x1fLinus Torvalds\x1ft@x.test\x1fN\x1f\x1fFORGED: Merge tag 'v9.9'\n\n${byline}`;
  const w = work(p);
  const sha = w.commit(`innocent subject\n\n${fake.repeat(40)}\n\n${byline}`);
  const pushed = await w.push(asUser('alice'));
  assert.deepEqual(pushed.commits.map((c) => c.sha), [sha], 'the one commit pushed is the one commit recorded');
  assert.equal(pushed.commits[0].subject, 'innocent subject');
  assert.equal(srv.store.data.agents.ada.stats.commits, 1, 'the counter moved by the commits actually pushed');
});

test('GIT-5: reading a push of many signed commits does not stop the event loop', async () => {
  const p = srv.projects.create(srv.store.userByName('alice'), { name: 'loop', visibility: 'public' }, '127.0.0.1');
  // 150 commits that carry a (junk) gpgsig header: every one is "signed" and has to be looked at.
  const dir = srv.projects.repoDir(p);
  const empty = git(dir, ['hash-object', '-t', 'tree', '-w', '/dev/null']);
  let parent = null;
  for (let i = 0; i < 150; i++) {
    const body = `tree ${empty}\n${parent ? `parent ${parent}\n` : ''}author A <a@x.test> 1700000000 +0000\ncommitter A <a@x.test> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n junk${i}\n -----END PGP SIGNATURE-----\n\nc${i}\n`;
    parent = execFileSync('git', ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, encoding: 'utf8', env: GIT }).trim();
  }
  git(dir, ['update-ref', 'refs/heads/main', parent]);
  // alice needs a registered key of her own, or there is nothing to check a signature against.
  srv.keys.addGpg(srv.store.userByName('alice'), holder('alice'), { key: gpgKey('alice').armored }, '127.0.0.1');
  let longest = 0;
  let last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  const t0 = Date.now();
  last = t0;
  const pushed = await srv.projects.afterPush(p, asUser('alice'), {});
  const took = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 30)); // one turn of the loop, so a stall is seen by the ticker
  clearInterval(ticker);
  assert.equal(pushed.commits.length, 50, 'the record keeps the newest 50 of them');
  assert.ok(took > 300, `the work was big enough to matter (${took} ms)`);
  assert.ok(longest * 4 < took, `the loop stalled for ${longest} ms of a ${took} ms push`);
});
