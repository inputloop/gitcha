// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Secret settings for CI pipelines: set and listed but never read back, sealed at rest, a fresh code to
// change; a build gets only the secrets its pipeline names, only for someone who may use them, never in a
// sandbox run, handed to the runner that takes the job and masked in the log; the runner's side too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { secretMasker } from '../../extension/lib/log-mask.js';
import { prepare } from '../../runner/lib/script.js';

const KEY = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQVYBGc0c2VjcmV0LWtleS1saW5lLW9uZQ\nc2Vjb25kLWxpbmUtb2YtdGhlLWtleQ==\n-----END PGP PRIVATE KEY BLOCK-----\n';
const pipeline = (extra = {}) => packFiles([{ path: 'gitcha-ci.json', data: JSON.stringify({ image: 'local', steps: [{ name: 's', run: 'true' }], timeout: '1m', ...extra }) }]);

async function setup() {
  const srv = await startServer();
  const alice = createUser(srv, 'alice', 'first long pass!');
  const bob = createUser(srv, 'bob', 'second long pass');
  const ta = await deviceLogin(srv, alice);
  const tb = await deviceLogin(srv, bob);
  const reg = srv.jobs.register({ token: srv.jobs.createRegistration(srv.store.userByName('alice'), {}, '127.0.0.1').token, name: 'r' }, '127.0.0.1');
  const fresh = (u, t) => api(srv.url, 'POST', '/api/v1/auth/step-up', { token: t, body: { code: u.nextCode() } });
  return { srv, alice, bob, ta, tb, runner: srv.jobs.authRunner(reg.token), fresh };
}

test('SEC-1: set, list and delete; the value is never sent back, is sealed at rest, and changing it needs a fresh code', async () => {
  const { srv, alice, ta, fresh } = await setup();
  try {
    srv.clock.advance(11 * 60_000); // past the ten-minute window of the sign-in's code
    const stale = await api(srv.url, 'PUT', '/api/v1/ci/secrets/APT_SIGNING_KEY', { token: ta, body: { value: KEY } });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, 'mfa_required');
    await fresh(alice, ta);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/ci/secrets/APT_SIGNING_KEY', { token: ta, body: { value: KEY } })).status, 200);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/ci/secrets/lower', { token: ta, body: { value: 'x' } })).body.error, 'bad_name');
    const list = await api(srv.url, 'GET', '/api/v1/ci/secrets', { token: ta });
    assert.deepEqual(list.body.secrets.map((s) => s.name), ['APT_SIGNING_KEY']);
    assert.ok(!JSON.stringify(list.body).includes('PGP'), 'the list holds no value');
    const db = fs.readFileSync(path.join(srv.config.dataDir, 'db.json'), 'utf8');
    assert.ok(db.includes('APT_SIGNING_KEY') && !db.includes('c2Vjb25kLWxpbmUtb2YtdGhlLWtleQ'), 'sealed on disk');
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/ci/secrets/APT_SIGNING_KEY', { token: ta })).status, 200);
    assert.deepEqual((await api(srv.url, 'GET', '/api/v1/ci/secrets', { token: ta })).body.secrets, []);
  } finally { await srv.close(); }
});

test('SEC-2: a build gets the named secrets only when every one is set, for someone who may use them, and never in a sandbox run', async () => {
  const { srv, alice, bob, ta, tb, fresh } = await setup();
  try {
    const queue = (t, tar) => api(srv.url, 'POST', '/api/v1/ci/runs', { token: t, body: { tarball: tar.toString('base64') } });
    const missing = await queue(ta, pipeline({ secrets: ['APT_SIGNING_KEY'] }));
    assert.equal(missing.status, 400);
    assert.match(missing.body.message, /needs the secret APT_SIGNING_KEY[\s\S]*gitcha secret set APT_SIGNING_KEY/);
    await fresh(alice, ta);
    await api(srv.url, 'PUT', '/api/v1/ci/secrets/APT_SIGNING_KEY', { token: ta, body: { value: KEY } });
    const ok = await queue(ta, pipeline({ secrets: ['APT_SIGNING_KEY'] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const rec = srv.store.data.jobs[ok.body.id];
    assert.deepEqual(rec.secretNames, ['APT_SIGNING_KEY']);
    assert.ok(!JSON.stringify(rec).includes('PGP'), 'the job record keeps names, not values');
    assert.equal((await queue(ta, pipeline({ secrets: ['X'], env: { X: '1' } }))).body.error, 'bad_spec');

    // A team's secrets: its maintainers may use them, a plain member may not.
    srv.teams.create(srv.store.userByName('alice'), { name: 'acme' }, '127.0.0.1');
    srv.teams.setMember(srv.store.userByName('alice'), 'acme', 'bob', 'member', '127.0.0.1');
    await fresh(alice, ta);
    await api(srv.url, 'PUT', '/api/v1/ci/secrets/DEPLOY_TOKEN', { token: ta, body: { value: 'team-secret-value', owner: 'team:acme' } });
    await fresh(bob, tb);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/ci/secrets/OTHER', { token: tb, body: { value: 'x', owner: 'team:acme' } })).status, 403, 'a member cannot set them');
    assert.throws(() => srv.ci.run(srv.store.userByName('bob'), { tarball: pipeline({ secrets: ['DEPLOY_TOKEN'] }), owner: { type: 'team', name: 'acme' } }, '127.0.0.1'), (e) => e.code === 'secrets_forbidden');
    assert.throws(() => srv.ci.run(srv.store.userByName('alice'), { tarball: pipeline({ secrets: ['APT_SIGNING_KEY'] }), sandboxAgent: 'ada', paidByPlan: true }, '127.0.0.1'), (e) => e.code === 'sandbox_no_secrets');
  } finally { await srv.close(); }
});

test('SEC-3: the runner that takes the build gets the values; the log hides them; a starter who lost access gets none', async () => {
  const { srv, alice, ta, runner, fresh } = await setup();
  try {
    await fresh(alice, ta);
    await api(srv.url, 'PUT', '/api/v1/ci/secrets/APT_SIGNING_KEY', { token: ta, body: { value: KEY } });
    const r = await api(srv.url, 'POST', '/api/v1/ci/runs', { token: ta, body: { tarball: pipeline({ secrets: ['APT_SIGNING_KEY'] }).toString('base64') } });
    const got = await srv.jobs.claim(runner, 50);
    assert.equal(got.job.secrets.APT_SIGNING_KEY, KEY);
    const job = srv.jobs.get(r.body.id);
    srv.jobs.appendLog(job, `printing it: ${KEY}\nand one line: c2Vjb25kLWxpbmUtb2YtdGhlLWtleQ==\n`);
    const log = srv.jobs.readLog(job);
    assert.ok(!log.includes('c2Vjb25kLWxpbmUtb2YtdGhlLWtleQ') && !log.includes('PRIVATE KEY BLOCK'), log);
    assert.match(log, /printing it: \*\*\*/);
    await srv.jobs.complete(job, { status: 'succeeded', exitCode: 0 });

    // The same pipeline again, but the account's owner is now suspended: the runner gets nothing.
    const again = await api(srv.url, 'POST', '/api/v1/ci/runs', { token: ta, body: { tarball: pipeline({ secrets: ['APT_SIGNING_KEY'] }).toString('base64') } });
    srv.store.tx((d) => { Object.values(d.users).find((u) => u.username === 'alice').status = 'suspended'; });
    const got2 = await srv.jobs.claim(runner, 50);
    assert.equal(got2.job.id, again.body.id);
    assert.deepEqual(got2.job.secrets, {});
    assert.match(srv.jobs.readLog(srv.jobs.get(again.body.id)), /no secrets for this build: alice may no longer use them/);
  } finally { await srv.close(); }
});

test('SEC-4: on the runner, the secrets reach the steps as variables, from a file only its user can read that is gone before the first step', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-sec-'));
  const job = { id: 'j1', kind: 'ci', secrets: { APT_SIGNING_KEY: "it's a key\nline two" }, spec: { pipeline: { env: {}, steps: [{ name: 'show', run: 'printf "%s|" "$APT_SIGNING_KEY"; [ -f "$J/secrets.sh" ] && echo still-there || echo gone' }] } } };
  prepare(work, job, null);
  assert.equal(fs.statSync(path.join(work, 'secrets.sh')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(work, 'run.sh'), 'utf8').includes('line two'), 'run.sh does not hold the value');
  const out = execFileSync('sh', [path.join(work, 'run.sh')], { env: { PATH: process.env.PATH, GITCHA_JOB: work } }).toString();
  assert.match(out, /it's a key\nline two\|gone/);
  assert.equal(fs.existsSync(path.join(work, 'secrets.sh')), false);
  const mask = secretMasker(["it's a key\nline two"]);
  assert.equal(mask("value: it's a key\nline two, again: line two"), 'value: ***, again: ***');
  assert.equal(secretMasker([])('unchanged'), 'unchanged');
});
