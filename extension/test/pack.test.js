// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What `gitcha publish` ships (EXT-9, EXT-9b, EXT-9c). A published version cannot be deleted, so the
// default is an allowlist and a deny list sits under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectFiles, pack } from '../lib/pack.js';
import { validateManifest } from '../lib/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'gitcha.js');
const MCP = path.join(here, '..', 'bin', 'gitcha-mcp.js');

function project(files, manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-pack-'));
  fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'demo', version: '1.0.0', ...manifest }));
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  return dir;
}
const shipped = (dir) => collectFiles(dir).files.map((f) => f.path).sort();

// the names the W3 review found shipping, plus the neighbours of each
const SECRETS = ['.env', '.env.local', '.env-prod', '.env_local', '.envrc', '.netrc', '.npmrc', '.pgpass', '.git-credentials', '.pypirc',
  '.aws/credentials', '.aws/config', '.ssh/id_ecdsa', '.ssh/config', '.ssh/authorized_keys', '.gnupg/private-keys-v1.d/abc.key',
  '.docker/config.json', '.config/gcloud/application_default_credentials.json', 'secret.key', 'server.key', 'private.key', 'key.pem',
  'cert.p12', 'cert.pfx', 'store.jks', 'id_rsa', 'id_ecdsa', 'id_dsa', 'gitcha-data/db.json', 'gitcha-data/secret.key', 'db.json',
  'terraform.tfstate', 'credentials.json', 'credentials.json.tmp', 'release.tgz', '.DS_Store', '.git/config', 'node_modules/x/index.js'];

test('EXT-9: by default only src, lib, bin, README*, LICENSE* and gitcha.json ship; no secret name does', () => {
  const dir = project({
    'src/index.js': 'x', 'lib/a/b.js': 'x', 'bin/run': 'x', 'README.md': 'x', 'LICENSE': 'x', 'LICENSE-MIT': 'x',
    'notes.txt': 'x', 'sub/other.js': 'x', '.hidden': 'x', 'src/.dotfile': 'x', 'src/.cache/c.js': 'x',
    ...Object.fromEntries(SECRETS.map((s) => [s, 'SECRET'])),
    ...Object.fromEntries(SECRETS.map((s) => [`src/${s}`, 'SECRET'])),
  });
  assert.deepEqual(shipped(dir), ['LICENSE', 'LICENSE-MIT', 'README.md', 'bin/run', 'gitcha.json', 'lib/a/b.js', 'src/index.js']);
});

test('EXT-9: naming a secret in "files" does not ship it; naming a dotfile that is not a secret does', () => {
  const dir = project({ ...Object.fromEntries(SECRETS.map((s) => [s, 'SECRET'])), '.well-known/security.txt': 'x', 'src/.keep': '', 'src/a.js': 'x', 'docs/guide.md': 'x', 'docs/.draft.md': 'x' },
    { files: [...SECRETS, '.aws/**', '.ssh/**', '.well-known', 'src/.keep', 'docs/*'] });
  assert.deepEqual(shipped(dir), ['.well-known/security.txt', 'docs/guide.md', 'gitcha.json', 'src/.keep']);
});

test('EXT-9: "*" and "**" in "files" do not reach dotfiles or dot-directories', () => {
  const dir = project({ 'a.js': 'x', '.b.js': 'x', 'src/c.js': 'x', 'src/.d/e.js': 'x', 'src/.f.js': 'x' }, { files: ['*.js', '**'] });
  assert.deepEqual(shipped(dir), ['a.js', 'gitcha.json', 'src/c.js']);
});

test('EXT-9c: a .gitchaignore pattern without a slash matches at any depth; with a slash it is anchored; the file itself does not ship', () => {
  const dir = project({
    '.gitchaignore': '# comment\nsecrets.txt\n*.log\n/only-root.txt\nsrc/gen/\n',
    'src/a.js': 'x', 'src/secrets.txt': 'x', 'src/deep/secrets.txt': 'x', 'src/debug.log': 'x', 'src/deep/er/trace.log': 'x',
    'only-root.txt': 'x', 'src/only-root.txt': 'x', 'src/gen/g.js': 'x', 'lib/gen/ok.js': 'x',
  }, { files: ['src', 'lib', 'only-root.txt'] });
  assert.deepEqual(shipped(dir), ['gitcha.json', 'lib/gen/ok.js', 'src/a.js', 'src/only-root.txt']);
});

test('EXT-9: "files" entries must stay inside the project', () => {
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'C:\\x']) {
    assert.match(validateManifest({ name: 'x', version: '1.0.0', files: [bad] }).join(), /inside the project/, bad);
  }
  assert.deepEqual(validateManifest({ name: 'x', version: '1.0.0', files: ['src/', '.well-known', '*.js'] }), []);
});

test('EXT-9b: pack() lists the files with sizes, the same ones that go in the tarball', () => {
  const dir = project({ 'src/index.js': 'hello' });
  const { files, entries, tarball } = pack(dir);
  assert.deepEqual(files, ['gitcha.json', 'src/index.js']);
  assert.deepEqual(entries.find((e) => e.path === 'src/index.js'), { path: 'src/index.js', size: 5 });
  assert.ok(tarball.length > 0);
});

const run = (args, cwd) => new Promise((resolve) => {
  // no credentials directory and no server: a dry run must not need either
  const env = { ...process.env, GITCHA_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-nocreds-')), GITCHA_SERVER: 'http://127.0.0.1:9', NO_COLOR: '1' };
  const p = spawn(process.execPath, args, { env, cwd });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (code) => resolve({ code, stdout, stderr }));
  p.stdin.end();
});

test('EXT-9b: gitcha publish --dry-run prints the files and uploads nothing, signed in or not', async () => {
  const dir = project({ 'src/index.js': 'hello', '.envrc': 'SECRET=1' });
  const r = await run([CLI, 'publish', '--dry-run', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /src\/index\.js {2}5 bytes/);
  assert.match(r.stdout, /Dry run: 2 files, \d+ bytes packed\. Nothing was uploaded/);
  assert.doesNotMatch(r.stdout + r.stderr, /envrc|not signed in/);
  const withFlagAfter = await run([CLI, 'publish', dir, '--dry-run', '--json'], dir);
  assert.deepEqual(JSON.parse(withFlagAfter.stdout).files.map((f) => f.path), ['gitcha.json', 'src/index.js']);
});

test('EXT-9b: the publish tool takes dry_run, returns the list, and its description tells Claude to show it first', async () => {
  const dir = project({ 'src/index.js': 'hello' });
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, GITCHA_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-nocreds-')), GITCHA_SERVER: 'http://127.0.0.1:9' } });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const ask = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    const tool = (await ask('tools/list', {})).result.tools.find((t) => t.name === 'gitcha_publish');
    assert.ok(tool.inputSchema.properties.dry_run, 'dry_run is declared');
    assert.match(tool.description, /ALWAYS call first with dry_run=true/);
    assert.match(tool.description, /show that list to the user/);
    const r = (await ask('tools/call', { name: 'gitcha_publish', arguments: { directory: dir, dry_run: true } })).result;
    assert.notEqual(r.isError, true, r.content[0].text);
    assert.match(r.content[0].text, /Dry run for demo@1\.0\.0: 2 files/);
    assert.match(r.content[0].text, /src\/index\.js \(5 bytes\)/);
    assert.match(r.content[0].text, /Nothing was uploaded/);
  } finally { p.kill(); }
});
