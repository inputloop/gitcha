// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A setting the server cannot honour stops it with one clear line (AUTH-9). The key and data-file rules (AUTH-14,
// STORE-1) are in the same file because they are the same kind of promise: refuse to start rather than start wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { spawnServer } from './spawn.js';

const KEY = crypto.randomBytes(32).toString('base64');
const cfg = (env) => loadConfig({ GITCHA_SECRET_KEY: KEY, GITCHA_DATA_DIR: tmpDir(), ...env });

test('AUTH-9: GITCHA_LOCKED_CHECKS refuses a name that locks nothing', () => {
  assert.deepEqual(cfg({ GITCHA_LOCKED_CHECKS: 'new_network, Interval' }).policy.lockedChecks, ['new_network', 'interval']);
  assert.deepEqual(cfg({}).policy.lockedChecks, []);
  assert.throws(() => cfg({ GITCHA_LOCKED_CHECKS: 'new-network' }), /unknown check.*new-network.*Valid names: interval, new_network, sensitive/);
  assert.throws(() => cfg({ GITCHA_LOCKED_CHECKS: 'interval,sensetive' }), /sensetive/);
});

test('AUTH-9: the real entry point prints one line and exits 1 on a bad setting', async () => {
  const srv = await spawnServer({ env: { GITCHA_LOCKED_CHECKS: 'new-network', GITCHA_SECRET_KEY: KEY } });
  try {
    assert.equal(srv.started, false);
    assert.equal(await srv.exited, 1);
    const lines = srv.err().trim().split('\n');
    assert.equal(lines.length, 1, `one line, got: ${srv.err()}`);
    assert.match(lines[0], /^gitcha: cannot start: GITCHA_LOCKED_CHECKS names unknown check/);
  } finally { await srv.stop(); }
});

const fresh = () => ({ dir: tmpDir() });
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const withUser = JSON.stringify({ version: 1, users: { u1: { id: 'u1', username: 'alice' } } });

test('AUTH-14: no key is made over a database that holds accounts', () => {
  const { dir } = fresh();
  write(dir, 'db.json', withUser);
  assert.throws(() => loadConfig({ GITCHA_DATA_DIR: dir }), /holds 1 account.*no .*secret\.key.*lock every account out/s);
  assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false, 'no key file was written');
  // With the key restored (file or environment) it starts; the key is the one that was restored.
  write(dir, 'secret.key', KEY + '\n');
  assert.equal(loadConfig({ GITCHA_DATA_DIR: dir }).secretKey, KEY);
  const { dir: other } = fresh();
  write(other, 'db.json', withUser);
  assert.equal(loadConfig({ GITCHA_DATA_DIR: other, GITCHA_SECRET_KEY: KEY }).secretKey, KEY);
});

test('AUTH-14: a database that cannot be read is not a reason to make a key either', () => {
  const { dir } = fresh();
  write(dir, 'db.json', '{"users": {"u1"');
  assert.throws(() => loadConfig({ GITCHA_DATA_DIR: dir }), /cannot be read/);
  assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false);
});

test('AUTH-14: a fresh install, or a database with no accounts, gets one key (0600) that later starts reuse', () => {
  const { dir } = fresh();
  write(dir, 'db.json', JSON.stringify({ version: 1, users: {} }));
  const first = loadConfig({ GITCHA_DATA_DIR: dir }).secretKey;
  assert.equal(Buffer.from(first, 'base64').length, 32);
  assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777, 0o600);
  assert.equal(loadConfig({ GITCHA_DATA_DIR: dir }).secretKey, first);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary key file is left behind');
});

test('AUTH-14: an empty, short or mistyped key stops the server instead of running with it', () => {
  const { dir } = fresh();
  write(dir, 'secret.key', '');
  assert.throws(() => loadConfig({ GITCHA_DATA_DIR: dir }), /secret\.key is not a 32-byte key/);
  write(dir, 'secret.key', 'c2hvcnQ=\n');
  assert.throws(() => loadConfig({ GITCHA_DATA_DIR: dir }), /not a 32-byte key/);
  assert.throws(() => loadConfig({ GITCHA_DATA_DIR: tmpDir(), GITCHA_SECRET_KEY: 'hunter2' }), /GITCHA_SECRET_KEY is not a 32-byte key/);
});

test('AUTH-14: starting twice at once agrees on one key (several real processes, one data directory)', async () => {
  const { dir } = fresh();
  const script = `import { loadConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; process.stdout.write(loadConfig({ GITCHA_DATA_DIR: ${JSON.stringify(dir)} }).secretKey);`;
  const run = () => new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], (err, out) => resolve(err ? `ERR ${err.message}` : out));
  });
  const keys = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(new Set(keys).size, 1, `every start used the same key, got ${keys.map((k) => k.slice(0, 8)).join(' ')}`);
  assert.equal(keys[0], fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim());
});

test('AUTH-14: the real entry point says so in one line and exits 1', async () => {
  const dir = tmpDir();
  write(dir, 'db.json', withUser);
  const srv = await spawnServer({ dataDir: dir });
  try {
    assert.equal(srv.started, false);
    assert.equal(await srv.exited, 1);
    const lines = srv.err().trim().split('\n');
    assert.equal(lines.length, 1, `one line, got: ${srv.err()}`);
    assert.match(lines[0], /^gitcha: cannot start: .*holds 1 account/);
    assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false);
  } finally { await srv.stop(); }
});
