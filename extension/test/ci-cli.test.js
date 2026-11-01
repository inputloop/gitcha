// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// `gitcha ci`: start a build from a folder, list builds, show one with its log, and download its artifacts,
// against a live server (the runner's part is played by the server's own job service).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, createUser } from '../../server/test/helpers.js';
import { saveCredentials } from '../lib/credentials.js';
import { cli, tmp } from './harness.js';

let srv, env, dir;
before(async () => {
  srv = await startServer();
  createUser(srv, 'alice', 'first long pass!');
  env = { ...process.env, GITCHA_CONFIG_DIR: tmp(), GITCHA_SERVER: srv.url, NO_COLOR: '1' };
  delete env.NODE_USE_ENV_PROXY;
  saveCredentials(srv.url, { username: 'alice', token: srv.auth.createSession(srv.store.userByName('alice'), { kind: 'device', name: 'cli', ip: '127.0.0.1' }).token, device: 'cli' }, env);
  dir = tmp();
  fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'demo', version: '1.0.0', files: ['gitcha-ci.json', 'build.sh'] }));
  fs.writeFileSync(path.join(dir, 'gitcha-ci.json'), JSON.stringify({ image: 'local', steps: [{ name: 'build', run: 'sh build.sh' }], artifacts: 'out' }));
  fs.writeFileSync(path.join(dir, 'build.sh'), 'mkdir -p out && echo hi > out/hello.txt\n');
});
after(() => srv.close());

test('gitcha ci run, list, show and artifacts', async () => {
  const run = await cli(env, ['ci', 'run', dir]);
  assert.equal(run.code, 0, run.stderr);
  const id = /Queued (\S+)/.exec(run.stdout)?.[1];
  assert.ok(id, run.stdout);
  assert.match((await cli(env, ['ci', 'list'])).stdout, new RegExp(`${id}\\s+queued`));
  assert.match((await cli(env, ['ci', 'show', id])).stdout, /Waiting for a runner/);

  const out = tmp();
  fs.writeFileSync(path.join(out, 'hello.txt'), 'hi\n');
  const artifact = execFileSync('tar', ['czf', '-', '-C', out, '.']);
  await srv.jobs.complete(srv.jobs.get(id), { status: 'succeeded', exitCode: 0, artifact });
  assert.match((await cli(env, ['ci', 'show', id])).stdout, new RegExp(`${id}\\s+succeeded[\\s\\S]*gitcha ci artifacts ${id}`));
  const file = path.join(tmp(), 'a.tgz');
  const got = await cli(env, ['ci', 'artifacts', id, '--out', file]);
  assert.equal(got.code, 0, got.stderr);
  assert.deepEqual(fs.readFileSync(file), artifact);
  assert.notEqual((await cli(env, ['ci', 'artifacts', id, '--out', file])).code, 0, 'an existing file is not replaced without --force');
  assert.match((await cli(env, ['ci', 'nope'])).stderr, /Usage: gitcha ci/);
  const made = await cli(env, ['site', 'create', 'apt']);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /Site apt made/);
  assert.match((await cli(env, ['site', 'list'])).stdout, /apt[\s\S]*no hosting domains/);
});
