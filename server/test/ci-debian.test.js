// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Debian packages pipeline (deploy/ci): the staged source and its pipeline, publish starting the build,
// a runner's artifact (packed with ordinary tar, as gitcha-runner packs it) deployed to the "apt" site and
// downloadable from the run, and apt-site.sh's install page. The build step itself (deploy/build-debs.sh)
// is not run here: it needs the npm registry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, createUser, api, deviceLogin, hostGet } from './helpers.js';
import { pack } from '../../extension/lib/pack.js';
import { pipelineFromTarball } from '../src/compute/ci.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-ci-deb-'));
const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const inGit = (() => { try { execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { stdio: 'ignore' }); return true; } catch { return false; } })();

let srv, token, alice, stage;
before(async () => {
  srv = await startServer({ env: { GITCHA_HOSTING_DOMAINS: 'pages.test' } });
  alice = createUser(srv, 'alice', 'first long pass!');
  token = await deviceLogin(srv, alice);
  srv.sites.create(srv.store.userByName('alice'), { name: 'apt' }, '127.0.0.1');
  if (inGit) {
    stage = path.join(tmp(), 'stage');
    execFileSync('sh', [path.join(root, 'deploy/ci/stage.sh'), stage, '--url', 'https://apt.pages.test'], { stdio: 'ignore' });
  }
});
after(() => srv.close());

test('CIDEB-1: stage.sh gives a source a runner can build: version file, package, pipeline, and nothing it does not need', { skip: !inGit && 'not a git checkout' }, () => {
  const ver = fs.readFileSync(path.join(stage, 'deploy/VERSION'), 'utf8').trim();
  assert.match(ver, /^\d+\.\d+\.\d+\+git\d{14}\.[0-9a-f]{7}$/);
  const m = JSON.parse(fs.readFileSync(path.join(stage, 'gitcha.json'), 'utf8'));
  assert.equal(m.name, 'gitcha-debian');
  assert.equal(m.version, `${ver.split('.').slice(0, 2).join('.')}.${/\+git(\d{14})/.exec(ver)[1]}`, 'the package version is the commit time');
  const { tarball, files } = pack(stage);
  assert.ok(tarball.length < srv.config.maxPackageBytes, `${tarball.length} bytes`);
  for (const f of ['deploy/build-debs.sh', 'deploy/ci/apt-site.sh', 'deploy/VERSION', 'deploy/gitcha.env', 'server/src/index.js', 'package-lock.json', 'gitcha-ci.json']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('docs/screenshots/') || f.startsWith('node_modules/')));
  const { pipeline } = pipelineFromTarball(tarball, { defaultImage: 'x' });
  assert.deepEqual(pipeline.on, ['publish']);
  assert.deepEqual(pipeline.deploy, { site: 'apt' });
  assert.equal(pipeline.artifacts, 'site');
  assert.equal(pipeline.env.APT_URL, 'https://apt.pages.test');
  assert.deepEqual(pipeline.steps.map((s) => s.name), ['tools', 'packages', 'repository']);
  assert.match(fs.readFileSync(path.join(stage, 'README.md'), 'utf8'), /^# gitcha-debian/);
});

test('CIDEB-2: publishing the staged source starts the build; its artifact is deployed to the apt site and can be downloaded', { skip: !inGit && 'not a git checkout' }, async () => {
  const { tarball } = pack(stage);
  await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: alice.nextCode() } });
  const pub = await api(srv.url, 'PUT', '/api/v1/packages', { token, body: { tarball: tarball.toString('base64'), integrity: `sha256-${crypto.createHash('sha256').update(tarball).digest('hex')}` } });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.ok(pub.body.build?.id, 'the pipeline ran on publish');
  const job = srv.store.data.jobs[pub.body.build.id];
  assert.match(job.trigger, /^publish:gitcha-debian@/);

  // What a runner sends back: the "site" folder packed with tar, as gitcha-runner's script does.
  const out = tmp();
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>inputloop apt repository</title>');
  fs.writeFileSync(path.join(out, 'Packages'), 'Package: inputloop-gitcha\nVersion: 0.2.0+git20261101000000.abcdef0\n');
  const artifact = execFileSync('tar', ['czf', '-', '-C', out, '.']);
  await srv.jobs.complete(srv.jobs.get(job.id), { status: 'succeeded', exitCode: 0, artifact });
  for (let i = 0; i < 50 && !srv.store.data.jobs[job.id].deployed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.store.data.jobs[job.id].deployed?.site, 'apt');
  const served = await hostGet(srv.url, 'apt.pages.test', '/Packages');
  assert.equal(served.status, 200);
  assert.match(String(served.body), /Package: inputloop-gitcha/);

  const got = await fetch(`${srv.url}/api/v1/ci/runs/${job.id}/artifacts`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), artifact);
  assert.match(got.headers.get('content-disposition'), /-artifacts\.tar\.gz"$/);
  assert.equal((await fetch(`${srv.url}/api/v1/ci/runs/${job.id}/artifacts`)).status, 401);
});

test('CIDEB-3: apt-site.sh makes a repository with checksums and an install page (no script, values escaped)', { skip: !(has('apt-ftparchive') && has('dpkg-deb')) && 'needs apt-ftparchive and dpkg-deb' }, () => {
  const dir = tmp();
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), 'Package: inputloop-gitcha\nVersion: 0.2.0+git20261101000000.abcdef0\nArchitecture: all\nMaintainer: t <t@example.org>\nDescription: test\n');
  fs.mkdirSync(path.join(dir, 'debs'));
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', pkg, path.join(dir, 'debs/inputloop-gitcha_0.2.0_all.deb')], { stdio: 'ignore' });
  execFileSync('sh', [path.join(root, 'deploy/ci/apt-site.sh'), path.join(dir, 'debs'), path.join(dir, 'site')], { env: { ...process.env, APT_URL: 'https://apt.example.net/"<x>' }, stdio: 'ignore' });
  const files = fs.readdirSync(path.join(dir, 'site'));
  for (const f of ['Packages', 'Packages.gz', 'Release', 'SHA256SUMS', 'index.html', 'inputloop-gitcha_0.2.0_all.deb']) assert.ok(files.includes(f), f);
  const html = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.match(html, /deb \[trusted=yes\] https:\/\/apt\.example\.net\/&quot;&lt;x&gt;\/ \.\//);
  assert.match(html, /0\.2\.0\+git20261101000000\.abcdef0/);
  assert.doesNotMatch(html, /<script/);
  assert.match(fs.readFileSync(path.join(dir, 'site/SHA256SUMS'), 'utf8'), /^[0-9a-f]{64}  \.\/inputloop-gitcha_0\.2\.0_all\.deb$/m);
});

test('CIDEB-4: with APT_SIGNING_KEY the repository is signed, only the public key is published, and gpgv accepts it', { skip: !(has('apt-ftparchive') && has('dpkg-deb') && has('gpg') && has('gpgv')) && 'needs apt-ftparchive, dpkg-deb, gpg and gpgv' }, () => {
  const dir = tmp();
  const home = path.join(dir, 'gnupg');
  fs.mkdirSync(home, { mode: 0o700 });
  const genv = { ...process.env, GNUPGHOME: home };
  execFileSync('gpg', ['--batch', '--quiet', '--passphrase', '', '--quick-gen-key', 'test apt <apt@example.org>', 'rsa2048', 'sign', 'never'], { env: genv, stdio: 'ignore' });
  const key = execFileSync('gpg', ['--batch', '--armor', '--export-secret-keys'], { env: genv }).toString();
  try { execFileSync('gpgconf', ['--kill', 'gpg-agent'], { env: genv, stdio: 'ignore' }); } catch { /* no agent */ }
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), 'Package: inputloop-gitcha\nVersion: 0.2.0\nArchitecture: all\nMaintainer: t <t@example.org>\nDescription: test\n');
  fs.mkdirSync(path.join(dir, 'debs'));
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', pkg, path.join(dir, 'debs/p_0.2.0_all.deb')], { stdio: 'ignore' });
  const env = { ...process.env, APT_URL: 'https://apt.example.net', APT_SIGNING_KEY: key };
  delete env.GNUPGHOME;
  execFileSync('sh', [path.join(root, 'deploy/ci/apt-site.sh'), path.join(dir, 'debs'), path.join(dir, 'site')], { env, stdio: 'ignore' });
  const site = path.join(dir, 'site');
  for (const f of ['InRelease', 'Release.gpg', 'inputloop-archive-keyring.gpg']) assert.ok(fs.existsSync(path.join(site, f)), f);
  for (const f of fs.readdirSync(site)) assert.ok(!fs.readFileSync(path.join(site, f)).includes('PRIVATE KEY'), `${f} holds no private key`);
  execFileSync('gpgv', ['--keyring', path.join(site, 'inputloop-archive-keyring.gpg'), path.join(site, 'InRelease')], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.match(html, /signed-by=\/usr\/share\/keyrings\/inputloop-archive-keyring\.gpg\] https:\/\/apt\.example\.net\/ \.\//);
  assert.doesNotMatch(html, /trusted=yes/);
  assert.throws(() => execFileSync('sh', [path.join(root, 'deploy/ci/apt-site.sh'), path.join(dir, 'debs'), path.join(dir, 'bad')], { env: { ...env, APT_SIGNING_KEY: 'not a key' }, stdio: 'ignore' }), 'a broken key stops the step');
});

test('CIDEB-5: stage.sh --sign makes the pipeline ask for the signing key (and --passphrase for its passphrase)', { skip: !inGit && 'not a git checkout' }, () => {
  const out = path.join(tmp(), 's');
  execFileSync('sh', [path.join(root, 'deploy/ci/stage.sh'), out, '--sign', '--passphrase', '--site', 'none'], { stdio: 'ignore' });
  const ci = JSON.parse(fs.readFileSync(path.join(out, 'gitcha-ci.json'), 'utf8'));
  assert.deepEqual(ci.secrets, ['APT_SIGNING_KEY', 'APT_SIGNING_PASSPHRASE']);
  assert.equal(ci.deploy, undefined);
  assert.match(ci.steps.find((s) => s.name === 'packages').run, /^unset APT_SIGNING_KEY APT_SIGNING_PASSPHRASE;/, 'the build step never sees the key');
});
