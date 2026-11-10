// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// `gitcha messages`: encrypted messages from the command line, with the keys in a mode-600 file and the
// encryption code from this package, against a live server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, createUser } from '../../server/test/helpers.js';
import { saveCredentials } from '../lib/credentials.js';
import { messagesFile } from '../lib/dm-store.js';
import { cli, tmp } from './harness.js';

let srv;
const envs = {};
/** A terminal for `name`: its own config folder, signed in with a device token. */
function terminal(name) {
  const env = { ...process.env, GITCHA_CONFIG_DIR: tmp(), GITCHA_SERVER: srv.url, NO_COLOR: '1' };
  delete env.NODE_USE_ENV_PROXY;
  const token = srv.auth.createSession(srv.store.userByName(name), { kind: 'device', name: 'cli', ip: '127.0.0.1' }).token;
  saveCredentials(srv.url, { username: name, token, device: 'cli' }, env);
  return env;
}

before(async () => {
  srv = await startServer({ clock: Date.now });
  createUser(srv, 'alice', 'first long pass!');
  createUser(srv, 'bob', 'second long pass');
  envs.alice = terminal('alice');
  envs.bob = terminal('bob');
});
after(() => srv.close());

test('two people message each other from the command line; the keys stay in a file only they can read', async () => {
  const a = await cli(envs.alice, ['messages', 'setup'], { input: 'alice backup words\nalice backup words\n' });
  assert.equal(a.code, 0, a.stderr);
  const file = messagesFile(srv.url, 'alice', envs.alice);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await cli(envs.bob, ['messages', 'setup'], { input: '\n' })).code, 0);

  const sent = await cli(envs.alice, ['messages', 'send', 'bob', 'The', 'tide', 'turns', 'at', 'four.']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /Sent to bob, encrypted end to end/);
  const list = await cli(envs.bob, ['messages']);
  assert.match(list.stdout, /alice\s+1 new/);
  const read = await cli(envs.bob, ['messages', 'read', 'alice']);
  assert.match(read.stdout, /The tide turns at four\./);
  assert.ok(!fs.readFileSync(`${srv.config.dataDir}/db.json`, 'utf8').includes('tide turns'), 'the server never had the words');

  const piped = await cli(envs.bob, ['messages', 'send', 'alice'], { input: 'Got it.\nSee you there.\n' });
  assert.equal(piped.code, 0, piped.stderr);
  assert.match((await cli(envs.alice, ['messages', 'read', 'bob'])).stdout, /Got it\.\n\s+See you there\./);
  const s1 = (await cli(envs.alice, ['messages', 'safety', 'bob'])).stdout.match(/(\d{5} ){11}\d{5}/)[0];
  const s2 = (await cli(envs.bob, ['messages', 'safety', 'alice'])).stdout.match(/(\d{5} ){11}\d{5}/)[0];
  assert.equal(s1, s2, 'both see the same safety number');
});

test('a new computer unlocks the keys from the backup and reads the conversation', async () => {
  const laptop = terminal('alice');
  const locked = await cli(laptop, ['messages']);
  assert.notEqual(locked.code, 0);
  assert.match(locked.stderr, /gitcha messages unlock/);
  assert.notEqual((await cli(laptop, ['messages', 'unlock'], { input: 'not the words\n' })).code, 0);
  assert.equal((await cli(laptop, ['messages', 'unlock'], { input: 'alice backup words\n' })).code, 0);
  assert.match((await cli(laptop, ['messages', 'read', 'bob'])).stdout, /The tide turns at four\.[\s\S]*Got it\./);
});

test('check-page: the server sends the same encryption code as this package', async () => {
  const r = await cli(envs.alice, ['messages', 'check-page']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /same\s+dm-protocol\.js/);
  assert.match(r.stdout, /same\s+dm-client\.js/);
});

test('check-page says so loudly when the server sends different encryption code', async () => {
  const { stub, signedIn } = await import('./harness.js');
  const evil = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('export const leak = true;\n'); });
  try {
    const r = await cli(signedIn(evil.url), ['messages', 'check-page']);
    assert.match(r.stdout, /DIFFERENT\s+dm-protocol\.js/);
    assert.match(r.stdout, /do not trust the web page with secrets/);
  } finally { await evil.close(); }
});
