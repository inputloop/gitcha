// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// `gitcha files` and `gitcha download`: a project's folders, one file, and the whole project as an archive,
// against a live server with a real pushed repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, createUser } from '../../server/test/helpers.js';
import { git, newRepo } from '../../server/test/social-helpers.js';
import { saveCredentials } from '../lib/credentials.js';
import { cli, tmp } from './harness.js';

let srv, env;

before(async () => {
  srv = await startServer({ clock: Date.now });
  createUser(srv, 'alice', 'first long pass!');
  const owner = srv.store.userByName('alice');
  srv.projects.create(owner, { name: 'tool', visibility: 'private' }, '127.0.0.1');
  env = { ...process.env, GITCHA_CONFIG_DIR: tmp(), GITCHA_SERVER: srv.url, NO_COLOR: '1' };
  delete env.NODE_USE_ENV_PROXY;
  const token = srv.auth.createSession(owner, { kind: 'device', name: 'cli', ip: '127.0.0.1' }).token;
  saveCredentials(srv.url, { username: 'alice', token, device: 'cli' }, env);
  const dir = await newRepo();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# tool\n');
  await git(dir, ['add', '.']);
  await git(dir, ['-c', 'user.name=A', '-c', 'user.email=a@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  await git(dir, ['push', '-q', `http://alice:${token}@127.0.0.1:${new URL(srv.url).port}/git/alice/tool.git`, 'main']);
});
after(() => srv.close());

test('gitcha files lists a folder; gitcha download saves the project and one file', async () => {
  const ls = await cli(env, ['files', 'alice/tool']);
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout, /alice\/tool\s+at main/);
  assert.match(ls.stdout, /src\/\n\s+README\.md/);

  const out = tmp();
  const zip = await cli(env, ['download', 'alice/tool', '--out', path.join(out, 'tool.zip')]);
  assert.equal(zip.code, 0, zip.stderr);
  const bytes = fs.readFileSync(path.join(out, 'tool.zip'));
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.includes('tool-main/src/main.js'));
  assert.ok(!fs.existsSync(path.join(out, 'tool.zip.part')));

  const tgz = await cli(env, ['download', 'alice/tool', '--format', 'tar.gz', '--out', path.join(out, 't.tar.gz')]);
  assert.equal(tgz.code, 0, tgz.stderr);
  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(out, 't.tar.gz'))).includes('tool-main/README.md'));

  const one = await cli(env, ['download', 'alice/tool', '--path', 'src/main.js', '--out', '-']);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout, 'console.log("hi");\n');

  const again = await cli(env, ['download', 'alice/tool', '--out', path.join(out, 'tool.zip')]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /already exists/);
  const bad = await cli(env, ['download', 'not-a-project']);
  assert.match(bad.stderr, /owner\/name/);
});
