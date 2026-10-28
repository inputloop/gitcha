// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';

const MIN = 60_000;
const tgz = (manifest) => packFiles([{ path: 'gitcha.json', data: JSON.stringify(manifest) }]);
const publish = (srv, token, manifest, extra = {}) => {
  const t = tgz(manifest);
  return api(srv.url, 'PUT', '/api/v1/packages', {
    token, body: { tarball: t.toString('base64'), integrity: `sha256-${crypto.createHash('sha256').update(t).digest('hex')}`, ...extra },
  });
};

async function setup() {
  const srv = await startServer();
  const users = {};
  for (const [name, pw] of [['alice', 'first long pass!'], ['bob', 'second long pass'], ['carol', 'third long pass!'], ['dave', 'fourth long pass']]) {
    users[name] = createUser(srv, name, pw);
  }
  const tok = {};
  for (const n of Object.keys(users)) tok[n] = await deviceLogin(srv, users[n]);
  return { srv, users, tok };
}

test('create a team, add members with roles, and share packages', async () => {
  const { srv, tok } = await setup();
  try {
    const c = await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme', description: 'Acme tools' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.role, 'owner');

    assert.equal((await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'maintainer' } })).status, 200);
    const add = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/carol', { token: tok.alice, body: { role: 'member' } });
    assert.deepEqual(add.body.members.map((m) => [m.username, m.role]), [['alice', 'owner'], ['bob', 'maintainer'], ['carol', 'member']]);

    // Non-owners cannot manage members.
    assert.equal((await api(srv.url, 'PUT', '/api/v1/teams/acme/members/dave', { token: tok.bob, body: { role: 'member' } })).status, 403);

    // A team maintainer publishes a team package; another maintainer can publish the next version.
    const p1 = await publish(srv, tok.bob, { name: 'acme-ui', version: '1.0.0', team: 'acme' });
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    assert.equal(p1.body.team, 'acme');
    assert.equal((await publish(srv, tok.alice, { name: 'acme-ui', version: '1.1.0' })).status, 201, 'combined ownership');
    // Plain members and outsiders cannot.
    assert.equal((await publish(srv, tok.carol, { name: 'acme-ui', version: '1.2.0' })).status, 403);
    assert.equal((await publish(srv, tok.dave, { name: 'acme-ui', version: '1.2.0' })).status, 403);
    assert.equal((await publish(srv, tok.carol, { name: 'carol-pkg', version: '1.0.0', team: 'acme' })).status, 403, 'members cannot create team packages');

    const info = await api(srv.url, 'GET', '/api/v1/teams/acme', { token: tok.carol });
    assert.deepEqual(info.body.packageNames, ['acme-ui']);
    assert.equal((await api(srv.url, 'GET', '/api/v1/teams/acme', { token: tok.dave })).status, 403);
  } finally { await srv.close(); }
});

test('team-private packages are visible only to team members', async () => {
  const { srv, tok } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'secret-lab' } });
    await api(srv.url, 'PUT', '/api/v1/teams/secret-lab/members/carol', { token: tok.alice, body: { role: 'member' } });
    assert.equal((await publish(srv, tok.alice, { name: 'lab-core', version: '0.1.0', team: 'secret-lab', private: true })).status, 201);

    const forCarol = await api(srv.url, 'GET', '/api/v1/packages', { token: tok.carol });
    assert.deepEqual(forCarol.body.packages.map((p) => p.name), ['lab-core']);
    assert.equal(forCarol.body.packages[0].visibility, 'team');
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/lab-core/latest/tarball', { token: tok.carol })).status, 200);

    const forDave = await api(srv.url, 'GET', '/api/v1/packages', { token: tok.dave });
    assert.deepEqual(forDave.body.packages, []);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/lab-core', { token: tok.dave })).status, 404, 'existence is not leaked');
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/lab-core/latest/tarball', { token: tok.dave })).status, 404);

    // Name squatting on a hidden package fails without revealing the owner.
    const squat = await publish(srv, tok.dave, { name: 'lab-core', version: '9.9.9' });
    assert.equal(squat.body.error, 'name_unavailable');
    assert.ok(!squat.body.message.includes('secret-lab'));

    // Make it public.
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/lab-core/visibility', { token: tok.alice, body: { private: false } })).status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/lab-core', { token: tok.dave })).status, 200);
  } finally { await srv.close(); }
});

test('transfer a personal package into a team', async () => {
  const { srv, tok } = await setup();
  try {
    await publish(srv, tok.bob, { name: 'bob-utils', version: '1.0.0' });
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme' } });
    // Bob must be a maintainer of the target team.
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/bob-utils/transfer', { token: tok.bob, body: { team: 'acme' } })).status, 403);
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'maintainer' } });
    // Alice can't transfer Bob's package.
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/bob-utils/transfer', { token: tok.alice, body: { team: 'acme' } })).status, 403);
    const t = await api(srv.url, 'POST', '/api/v1/packages/bob-utils/transfer', { token: tok.bob, body: { team: 'acme' } });
    assert.equal(t.status, 200);
    assert.equal(t.body.owner, 'acme');
    assert.equal((await publish(srv, tok.alice, { name: 'bob-utils', version: '1.0.1' })).status, 201, 'now shared');
  } finally { await srv.close(); }
});

test('owner safeguards: last owner, leaving, deletion, sensitive checks', async () => {
  const { srv, users, tok } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme' } });
    const demote = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/alice', { token: tok.alice, body: { role: 'member' } });
    assert.equal(demote.body.error, 'last_owner');
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/teams/acme/members/alice', { token: tok.alice })).body.error, 'last_owner');

    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'member' } });
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/teams/acme/members/bob', { token: tok.bob })).status, 200, 'members can leave');

    assert.equal((await api(srv.url, 'POST', '/api/v1/teams', { token: tok.bob, body: { name: 'alice' } })).body.error, 'team_exists', 'cannot shadow a username');
    assert.equal((await api(srv.url, 'POST', '/api/v1/teams', { token: tok.bob, body: { name: 'acme' } })).status, 409);

    await publish(srv, tok.alice, { name: 'acme-x', version: '1.0.0', team: 'acme' });
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/teams/acme', { token: tok.alice })).body.error, 'team_has_packages');

    // Member management is sensitive: a stale code is not enough.
    srv.clock.advance(11 * MIN);
    const stale = await api(srv.url, 'PUT', '/api/v1/teams/acme/members/dave', { token: tok.alice, body: { role: 'owner' } });
    assert.equal(stale.body.reason, 'sensitive_action');
    await api(srv.url, 'POST', '/api/v1/auth/step-up', { token: tok.alice, body: { code: users.alice.nextCode() } });
    assert.equal((await api(srv.url, 'PUT', '/api/v1/teams/acme/members/dave', { token: tok.alice, body: { role: 'owner' } })).status, 200);
    const audit = srv.store.auditFor(srv.store.userByName('dave').id).map((e) => e.event);
    assert.ok(audit.includes('team.member_added'), 'the added user sees it in their audit log');
  } finally { await srv.close(); }
});
