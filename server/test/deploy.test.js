// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
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

test('DEB-1: the full packaging never stops a service for an upgrade, and restarts one that runs', () => {
  const rules = read('debian/rules');
  for (const unit of ['gitcha', 'gitcha-runner']) {
    assert.match(rules, new RegExp(`dh_installsystemd -pinputloop-${unit} --name=${unit} --no-enable --no-start --no-stop-on-upgrade`), `${unit}: no stop in preinst, no enable or start by debhelper`);
    assert.match(read(`debian/inputloop-${unit}.postinst`), new RegExp(`try-restart ${unit}\\.service`), `${unit}: a running service gets the new code`);
  }
});

test('DEB-2: every debconf question is asked by config and used by postinst, and only those', () => {
  /** The questions a script names: "pkg/name" literally, or "pkg/prefix_$q" inside a "for q in a b c" loop. */
  const questions = (file) => {
    const text = read(file);
    const out = new Set([...text.matchAll(/"?(inputloop-[\w-]+\/\w+)(?!\w*\$)/g)].map((m) => m[1]));
    for (const m of text.matchAll(/for q in ([\w ]+); do[^\n]*\n?[^\n]*"(inputloop-[\w-]+\/\w*)\$q"/g)) {
      out.delete(m[2]);
      for (const q of m[1].trim().split(/\s+/)) out.add(m[2] + q);
    }
    return [...out].sort();
  };
  for (const pkg of ['inputloop-gitcha', 'inputloop-gitcha-runner']) {
    const templates = [...read(`debian/${pkg}.templates`).matchAll(/^Template: (\S+)$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(questions(`debian/${pkg}.config`), templates, `${pkg}: config asks each template`);
    assert.deepEqual(questions(`debian/${pkg}.postinst`), templates, `${pkg}: postinst reads each answer`);
  }
});

test('DEB-3: the debconf answers become settings the server reads, and the build option has its anchors', () => {
  const postinst = read('debian/inputloop-gitcha.postinst');
  const env = read('deploy/gitcha.env');
  const written = [...postinst.matchAll(/(GITCHA_[A-Z_]+)=/g)].map((m) => m[1]);
  for (const q of /for q in ([\w ]+); do/.exec(postinst)[1].trim().split(/\s+/)) written.push(`GITCHA_CASSANDRA_${q.toUpperCase()}`);
  for (const name of new Set(written)) assert.match(env, new RegExp(`^#?${name}=`, 'm'), `${name} is a setting in gitcha.env`);
  // lay-out.sh turns the option off and hands the debconf settings over by editing these exact lines.
  assert.match(env, /^GITCHA_STORE=cassandra$/m, 'the packaged default is Cassandra, as one line lay-out.sh can switch');
  for (const name of ['GITCHA_PUBLIC_URL', 'GITCHA_CASSANDRA_CONTACT_POINTS']) assert.match(env, new RegExp(`^${name}=`, 'm'));
  assert.match(read('deploy/gitcha.service'), /^EnvironmentFile=-\/etc\/inputloop\/gitcha\/debconf\.env$/m, 'debconf.env is optional, and read after gitcha.env');
  assert.match(read('debian/rules'), /pkg\.gitcha\.nocassandra/);
});

test('PROXY-1: every reverse proxy example keeps Host, sets the client address and https, and allows big, slow requests', () => {
  const need = {
    'deploy/nginx-gitcha.conf.example': [/proxy_set_header Host \$host;/, /proxy_set_header X-Forwarded-For \$remote_addr;/, /proxy_set_header X-Forwarded-Proto \$scheme;/, /client_max_body_size 200m;/, /proxy_read_timeout 120s;/],
    'deploy/apache-gitcha.conf.example': [/ProxyPreserveHost On/, /RequestHeader set X-Forwarded-Proto "https"/, /LimitRequestBody 209715200/, /timeout=120/],
    'deploy/haproxy-gitcha.cfg.example': [/http-request del-header X-Forwarded-For/, /option forwardfor/, /X-Forwarded-Proto https/, /timeout server 120s/],
    'deploy/Caddyfile.example': [/reverse_proxy 127\.0\.0\.1:4873/, /ask http:\/\/127\.0\.0\.1:4873\/api\/v1\/hosting\/tls-allowed/],
  };
  for (const [file, lines] of Object.entries(need)) {
    const text = read(file);
    for (const re of lines) assert.match(text, re, `${file} has ${re}`);
    if (!file.endsWith('Caddyfile.example')) assert.match(text, /:4873/, `${file} sends to Gitcha`);
    assert.ok(read('deploy/lay-out.sh').includes(path.basename(file)), `${file} is installed with the package docs`);
  }
});
