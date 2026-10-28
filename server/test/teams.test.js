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
    // Naming an owner takes a code of its own, sent with the change (AUTH-4); the step-up above is not it.
    assert.equal((await api(srv.url, 'PUT', '/api/v1/teams/acme/members/dave', { token: tok.alice, body: { role: 'owner' } })).status, 401);
    assert.equal((await api(srv.url, 'PUT', '/api/v1/teams/acme/members/dave', { token: tok.alice, body: { role: 'owner', code: users.alice.nextCode() } })).status, 200);
    const audit = srv.store.auditFor(srv.store.userByName('dave').id).map((e) => e.event);
    assert.ok(audit.includes('team.member_added'), 'the added user sees it in their audit log');
  } finally { await srv.close(); }
});

test('a publish cannot change who sees a team package; the visibility route does, and audits it (PKG-F8)', async () => {
  const { srv, tok } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'maintainer' } });
    const first = await publish(srv, tok.bob, { name: 'acme-secret', version: '1.0.0', team: 'acme', private: true });
    assert.equal(first.body.visibility, 'team');

    // one stray "private": false in a manifest used to publish every earlier version to the whole registry
    const flip = await publish(srv, tok.bob, { name: 'acme-secret', version: '1.0.1', private: false });
    assert.equal(flip.status, 409, JSON.stringify(flip.body));
    assert.equal(flip.body.error, 'visibility_change');
    assert.match(flip.body.message, /gitcha access acme-secret public/);
    assert.equal((await publish(srv, tok.bob, { name: 'acme-secret', version: '1.0.1' }, { private: false })).status, 409, 'the request flag is no different');
    assert.equal((await api(srv.url, 'GET', '/api/v1/packages/acme-secret/1.0.0/tarball', { token: tok.dave })).status, 404, 'still hidden from outsiders');

    // saying what is already so, or nothing, is fine and changes nothing
    assert.equal((await publish(srv, tok.bob, { name: 'acme-secret', version: '1.0.1', team: 'acme', private: true })).body.visibility, 'team');
    assert.equal((await publish(srv, tok.bob, { name: 'acme-secret', version: '1.0.2' })).body.visibility, 'team');

    // making a public team package private by publishing is the same kind of change
    await publish(srv, tok.bob, { name: 'acme-open', version: '1.0.0', team: 'acme' });
    assert.equal((await publish(srv, tok.bob, { name: 'acme-open', version: '1.0.1', team: 'acme', private: true })).body.error, 'visibility_change');

    // the route that is meant for it works and leaves the event
    const route = await api(srv.url, 'POST', '/api/v1/packages/acme-secret/visibility', { token: tok.bob, body: { private: false } });
    assert.equal(route.status, 200);
    const events = srv.store.auditFor(srv.store.userByName('bob').id).map((e) => e.event);
    assert.ok(events.includes('package.visibility'));
  } finally { await srv.close(); }
});

test('moving a package out of a team is for that team\'s owners, and every owner of both teams is told (PKG-F9)', async () => {
  const { srv, tok } = await setup();
  try {
    const id = (n) => srv.store.userByName(n).id;
    const events = (n) => srv.store.auditFor(id(n)).filter((e) => e.event === 'package.transferred');
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'maintainer' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/carol', { token: tok.alice, body: { role: 'owner' } });
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.bob, body: { name: 'bobs' } });
    await api(srv.url, 'PUT', '/api/v1/teams/bobs/members/dave', { token: tok.bob, body: { role: 'owner' } });
    await publish(srv, tok.alice, { name: 'acme-pub', version: '1.0.0', team: 'acme' });

    // a maintainer of acme who owns another team used to be able to walk off with it, unseen
    const grab = await api(srv.url, 'POST', '/api/v1/packages/acme-pub/transfer', { token: tok.bob, body: { team: 'bobs' } });
    assert.equal(grab.status, 403, JSON.stringify(grab.body));
    assert.equal(grab.body.error, 'team_forbidden');
    assert.match(grab.body.message, /owner of team "acme"/);
    assert.equal((await publish(srv, tok.alice, { name: 'acme-pub', version: '1.0.1' })).status, 201, 'it is still acme\'s');
    assert.deepEqual([events('alice').length, events('bob').length], [0, 0]);

    // an owner of acme who may take it in (a maintainer of the target) can move it, and the owners are told
    await api(srv.url, 'PUT', '/api/v1/teams/bobs/members/alice', { token: tok.bob, body: { role: 'maintainer' } });
    const moved = await api(srv.url, 'POST', '/api/v1/packages/acme-pub/transfer', { token: tok.alice, body: { team: 'bobs' } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    for (const who of ['alice', 'carol', 'bob', 'dave']) assert.equal(events(who).length, 1, `${who} has a package.transferred row`);
    assert.equal(events('alice')[0].ip !== undefined, true, 'the actor\'s own row keeps the address');
    for (const who of ['carol', 'bob', 'dave']) {
      const e = events(who)[0];
      assert.deepEqual([e.package, e.from, e.to, e.by], ['acme-pub', 'acme', 'bobs', 'alice']);
      assert.equal(e.ip, undefined, `${who}'s row does not carry alice's address`);
    }
    assert.equal(events('carol')[0].event, 'package.transferred');
  } finally { await srv.close(); }
});

test('a personal package moved into a team is told to that team\'s owners (PKG-F9)', async () => {
  const { srv, tok } = await setup();
  try {
    await publish(srv, tok.bob, { name: 'bob-utils', version: '1.0.0' });
    await api(srv.url, 'POST', '/api/v1/teams', { token: tok.alice, body: { name: 'acme' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: tok.alice, body: { role: 'maintainer' } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/packages/bob-utils/transfer', { token: tok.bob, body: { team: 'acme' } })).status, 200);
    const seen = srv.store.auditFor(srv.store.userByName('alice').id).filter((e) => e.event === 'package.transferred');
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].package, seen[0].to, seen[0].by], ['bob-utils', 'acme', 'bob']);
  } finally { await srv.close(); }
});
