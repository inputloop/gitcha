// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// How the CLI and the SessionStart hook treat the registry and the device token: EXT-5 (the hook), EXT-6 and EXT-6b
// (the token on disk and logout), EXT-10 (the hidden prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { GitchaClient } from '../lib/client.js';
import { saveCredentials, getCredentials, readAll } from '../lib/credentials.js';
import { ask } from '../lib/prompt.js';
import { HOSTILE, cli, json, signedIn, stub, tmp } from './harness.js';

// ---- EXT-5: the SessionStart hook ----------------------------------------------------------------------------

test('EXT-5: the hook prints fixed words and the server address, never the registry\'s text', async () => {
  const reg = await stub((req, res) => json(res, 200, { user: { username: HOSTILE, role: 'user' }, device: { name: HOSTILE }, mfa: { ok: false, reason: HOSTILE, next_check_at: HOSTILE } }));
  try {
    const env = signedIn(reg.url);
    const r = await cli(env, ['status', '--hook']);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /IGNORE|evil|ssh/);
    assert.match(r.stdout, /^Gitcha: signed in to http:\/\/127\.0\.0\.1:\d+; the two-factor check is due/);
  } finally { await reg.close(); }
});

test('EXT-5: when the registry errors, the hook says so in fixed words', async () => {
  const reg = await stub((req, res) => json(res, 500, { error: 'boom', message: HOSTILE }));
  try {
    const env = signedIn(reg.url);
    const r = await cli(env, ['status', '--hook']);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /IGNORE|ssh/);
    assert.match(r.stdout, /^Gitcha: status unavailable \(/);
  } finally { await reg.close(); }
});

test('EXT-5: a registry that never answers cannot hold the hook past its own timeout', async () => {
  const reg = await stub(() => { /* never answers */ });
  try {
    const env = signedIn(reg.url);
    const t0 = Date.now();
    const r = await cli(env, ['status', '--hook'], { timeoutMs: 9000 });
    assert.notEqual(r.code, 'timeout', 'the hook must end by itself');
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    assert.match(r.stdout, /status unavailable \(the registry could not be reached\)/);
  } finally { await reg.close(); }
});

test('EXT-5: the client gives up on a stalled registry with a timeout error, headers or body', async () => {
  const stall = await stub(() => { /* never answers */ });
  const half = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"a":'); /* never ends */ });
  try {
    for (const reg of [stall, half]) {
      const client = new GitchaClient({ server: reg.url, timeoutMs: 200 });
      const outcome = await Promise.race([
        client.health().then(() => 'answered', (err) => err),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2500)),
      ]);
      assert.notEqual(outcome, 'still waiting', 'the request must end');
      assert.equal(outcome.code, 'timeout');
      assert.equal(outcome.status, 0);
    }
  } finally { await stall.close(); await half.close(); }
});

// ---- EXT-6, EXT-6b: the device token on disk ----------------------------------------------------------------

test('EXT-6: a planted credentials.json.tmp (symlink or loose file) is never written through, and the result is mode 600', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const env = { GITCHA_CONFIG_DIR: dir };
  const victim = path.join(tmp(), 'victim.txt');
  fs.writeFileSync(victim, 'VICTIM');
  fs.symlinkSync(victim, path.join(dir, 'credentials.json.tmp'));
  const first = saveCredentials('http://localhost:1', { token: 'secret-1' }, env);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM', 'the planted symlink was written through');
  assert.equal(first.private, true);
  assert.equal(first.warning, null);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  // a loose file at the old fixed temp name is not reused either
  fs.rmSync(path.join(dir, 'credentials.json.tmp'));
  fs.writeFileSync(path.join(dir, 'credentials.json.tmp'), 'old', { mode: 0o644 });
  saveCredentials('http://localhost:2', { token: 'secret-2' }, env);
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json.tmp'), 'utf8'), 'old');
  assert.equal(getCredentials('http://localhost:2', env).token, 'secret-2');
  assert.equal(getCredentials('http://localhost:1', env).token, 'secret-1');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') && f !== 'credentials.json.tmp'), [], 'no temp file is left behind');
});

test('EXT-6: a file that was group-readable before is private after a save', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const env = { GITCHA_CONFIG_DIR: dir };
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"default":null,"servers":{}}', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'credentials.json'), 0o644);
  const r = saveCredentials('http://localhost:1', { token: 't' }, env);
  assert.equal(r.private, true);
  assert.equal(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
});

test('EXT-6: a chmod that fails is reported, not swallowed', { skip: process.platform === 'win32' }, () => {
  const real = fs.fchmodSync;
  fs.fchmodSync = () => { const e = new Error('no'); e.code = 'EPERM'; throw e; };
  try {
    const r = saveCredentials('http://localhost:1', { token: 't' }, { GITCHA_CONFIG_DIR: tmp() });
    assert.match(r.warning, /could not set mode 600 \(EPERM\)/);
  } finally { fs.fchmodSync = real; }
});

test('EXT-6: the CLI says "(mode 600)" only after reading the mode back', { skip: process.platform === 'win32' }, async () => {
  // a real login against the real server is in e2e.test.js; here the claim is checked on the saved file itself
  const dir = tmp();
  const r = saveCredentials('http://localhost:1', { token: 't' }, { GITCHA_CONFIG_DIR: dir });
  assert.equal(typeof r.private, 'boolean');
  assert.equal(r.private, (fs.statSync(r.path).mode & 0o077) === 0);
  assert.deepEqual(Object.keys(readAll({ GITCHA_CONFIG_DIR: dir }).servers), ['http://localhost:1']);
});

test('EXT-6b: logout keeps the token when the registry could not confirm, and drops it when it did', async () => {
  // 1. unreachable registry: exit 1, token still there, the words say so
  const dead = await stub((req, res) => res.end());
  const deadUrl = dead.url;
  await dead.close();
  let env = signedIn(deadUrl);
  let r = await cli(env, ['logout']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /revoked/);
  assert.match(r.stderr, /still saved here/);
  assert.equal(getCredentials(deadUrl, env).token, 'tok-alice');

  // 2. an error from the registry is not a confirmation either
  const sick = await stub((req, res) => json(res, 500, { error: 'boom', message: 'sick' }));
  try {
    env = signedIn(sick.url);
    r = await cli(env, ['logout']);
    assert.equal(r.code, 1);
    assert.equal(getCredentials(sick.url, env).token, 'tok-alice');
  } finally { await sick.close(); }

  // 3. a 200 is: the token goes and the words say revoked
  const ok = await stub((req, res) => json(res, 200, { ok: true }));
  try {
    env = signedIn(ok.url);
    r = await cli(env, ['logout']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /revoked/);
    assert.equal(getCredentials(ok.url, env), null);
    assert.deepEqual(ok.seen, ['POST /api/v1/auth/logout']);
  } finally { await ok.close(); }

  // 4. a 401 means the token was already dead: nothing is lost by dropping it, and the words do not claim a revoke
  const gone = await stub((req, res) => json(res, 401, { error: 'unauthenticated', message: 'no' }));
  try {
    env = signedIn(gone.url);
    r = await cli(env, ['logout']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already revoked/);
    assert.equal(getCredentials(gone.url, env), null);
  } finally { await gone.close(); }
});

test('EXT-6b: logout --local-only forgets the token without asking the registry, and says it did only that', async () => {
  const reg = await stub((req, res) => json(res, 200, { ok: true }));
  try {
    const env = signedIn(reg.url);
    const r = await cli(env, ['logout', '--local-only']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /this machine only/);
    assert.doesNotMatch(r.stdout, /revoked\./);
    assert.deepEqual(reg.seen, []);
    assert.equal(getCredentials(reg.url, env), null);
  } finally { await reg.close(); }
});

// ---- EXT-10: the hidden prompt ------------------------------------------------------------------------------

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (on) => { input.rawCalls.push(on); input.isRaw = on; return input; };
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, written: () => written };
}

test('EXT-10: a hidden prompt echoes nothing, not even after Backspace, and leaves the terminal as it found it', async () => {
  const tty = fakeTty();
  const answer = ask('Password: ', { hidden: true, input: tty.input, output: tty.output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tty.input.write('abc\x7f\x7f');
  tty.input.write('xy\x1b[A\x1b[Dz\r');
  assert.equal(await answer, 'axyz');
  const shown = tty.written();
  assert.equal(shown, 'Password: \n');
  assert.deepEqual(tty.input.rawCalls, [true, false]);
});

test('EXT-10: Ctrl-C cancels a hidden prompt and Ctrl-U clears the line', async () => {
  const tty = fakeTty();
  const a = ask('Password: ', { hidden: true, input: tty.input, output: tty.output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tty.input.write('wrong\x15right\n');
  assert.equal(await a, 'right');
  const tty2 = fakeTty();
  const b = ask('Password: ', { hidden: true, input: tty2.input, output: tty2.output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tty2.input.write('ab\x03');
  await assert.rejects(b, /Cancelled/);
  assert.deepEqual(tty2.input.rawCalls, [true, false]);
  assert.equal(tty2.written(), 'Password: \n');
});
