// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The files an operator deploys from say what the code needs (the second review's DEP findings): nothing here starts a service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));

test('DEP-6: gitcha.env has a line for every setting the server reads', () => {
  const seen = new Set();
  for (const f of [...walk('server/src'), ...walk('server/bin')]) for (const m of read(f).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) seen.add(m[1]);
  for (const own of ['PATH', 'SSH_ORIGINAL_COMMAND']) seen.delete(own); // not settings
  const env = read('deploy/gitcha.env');
  const missing = [...seen].filter((name) => !new RegExp(`^#?${name}=`, 'm').test(env)).sort();
  assert.deepEqual(missing, [], 'settings the server reads with no line in gitcha.env');
});

test('DEP-2, DEP-3: both units bound memory, tasks and address families; the runner has the server\'s protections too', () => {
  const server = read('deploy/gitcha.service');
  const runner = read('deploy/gitcha-runner.service');
  for (const [name, unit] of [['gitcha.service', server], ['gitcha-runner.service', runner]]) {
    for (const d of ['MemoryMax', 'TasksMax', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes']) {
      assert.ok(unit.includes(d), `${name} has ${d}`);
    }
  }
  assert.match(runner, /^CapabilityBoundingSet=\s*$/m, 'the runner binds capabilities as the server does');
});

test('DEP-6, DEP-7: DEPLOY.md says what the operator must know and cannot find elsewhere', () => {
  const doc = read('DEPLOY.md');
  assert.match(doc, /GITCHA_TRUST_PROXY/, 'when to trust the proxy');
  assert.match(doc, /firewall[^.]*\b22\b|\b22\b[^.]*firewall/i, 'port 22 for git over SSH');
  assert.match(doc, /systemctl restart gitcha|try-restart/, 'restart after an upgrade');
  assert.match(doc, /one process[^.]*(data directory|database)/i, 'one process per data directory');
  assert.match(doc, /GITCHA_LOCKED_CHECKS/, 'the locked two-factor checks');
});

test('DEP-7: the server package restarts a running service when it is upgraded', () => {
  const build = read('deploy/build-debs.sh');
  const postinst = build.slice(build.indexOf('cat > "$S/DEBIAN/postinst"'), build.indexOf('finish inputloop-gitcha "'));
  assert.match(postinst, /try-restart gitcha\.service/);
});

test('DEP-12: building the part does not remove the staging directory other alphaOS parts share', () => {
  const build = read('deploy/build-debs.sh');
  assert.ok(!/rm -rf "\$OUT\/\.stage"/.test(build), 'no rm -rf of $OUT/.stage');
  assert.match(build, /\.stage-gitcha/, 'a stage directory of its own');
});

test('DEP-10: the Docker image has the git and gpg the server runs', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /apk add[^\n]*\bgit\b/);
  assert.match(docker, /apk add[^\n]*\bgnupg\b/);
});
