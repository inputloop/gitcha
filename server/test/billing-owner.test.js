// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Whose a billing account is: bound to the person or team it was opened for, closed with it, and shared across free teams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { BillingService } from '../src/billing/billing.js';
import { setup, subscribe, billingOf, dbAccount, auditRows } from './billing-fixtures.js';

const post = (srv, token, p, body) => api(srv.url, 'POST', p, { token, body });

test('BIL-9: a deleted team\'s plan, customer and subscription do not pass to the next registrant of the name', async () => {
  const { srv, fake, people } = await setup({ users: ['alice', 'mallory'] });
  const { alice, mallory } = people;
  try {
    assert.equal((await post(srv, alice.token, '/api/v1/teams', { name: 'acme' })).status, 201);
    const paid = await subscribe(srv, fake, alice.token, { plan: 'team', owner: 'team:acme' });
    assert.equal(paid.confirm.body.plan, 'team');
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/teams/acme', { token: alice.token })).status, 200);

    assert.equal((await post(srv, mallory.token, '/api/v1/teams', { name: 'acme' })).status, 201);
    const view = await billingOf(srv, mallory.token, 'team:acme');
    assert.equal(view.plan, 'free', 'a new team of the same name starts on Free');
    assert.equal(view.subscription, null);
    assert.equal((await post(srv, mallory.token, '/api/v1/billing/portal', { owner: 'team:acme' })).body.error, 'no_portal', 'no portal for the previous owner\'s customer');
    assert.equal((await post(srv, mallory.token, '/api/v1/billing/cancel', { owner: 'team:acme' })).body.error, 'no_subscription');

    // The previous owner's subscription is cancelled at the provider rather than left to bill for nothing.
    await srv.billing.drainCancels();
    assert.equal(fake.st.subs[paid.subId].status, 'canceled');
    assert.equal(dbAccount(srv, 'team:acme'), undefined);
  } finally { await srv.close(); }
});

test('BIL-9: closeAccount (the team-deletion hook) cancels at the provider, clears the customer and logs it', async () => {
  const { srv, fake, token, alice } = await setup();
  try {
    await post(srv, token, '/api/v1/teams', { name: 'acme' });
    const paid = await subscribe(srv, fake, token, { plan: 'pro', owner: 'team:acme' });
    assert.equal(paid.confirm.body.plan, 'pro');
    assert.equal(dbAccount(srv, 'team:acme').subscription.customerId, fake.st.subs[paid.subId].customer);
    await api(srv.url, 'DELETE', '/api/v1/teams/acme', { token });
    await srv.billing.closeAccount('team:acme', { by: 'alice', userId: srv.store.userByName('alice').id });
    assert.equal(fake.st.subs[paid.subId].status, 'canceled');
    assert.equal(dbAccount(srv, 'team:acme'), undefined, 'no record, so no portal customer and no plan');
    assert.equal(srv.store.data.billing.closed.at(-1).key, 'team:acme');
    assert.equal(srv.store.data.billing.pendingCancels.length, 0, 'nothing left to cancel');
    assert.ok(auditRows(srv).some((a) => a.event === 'billing.account_closed' && a.owner === 'team:acme'));
    // The same owner can start again from Free.
    await post(srv, token, '/api/v1/teams', { name: 'acme' });
    assert.equal((await billingOf(srv, token, 'team:acme')).plan, 'free');
    assert.equal(alice.username, 'alice');
  } finally { await srv.close(); }
});

test('BIL-9: a cancel the provider refuses stays queued and is retried', async () => {
  const { srv, fake, token } = await setup();
  const quiet = { info() {}, error() {} };
  try {
    srv.billing.log = quiet;
    await post(srv, token, '/api/v1/teams', { name: 'acme' });
    const paid = await subscribe(srv, fake, token, { plan: 'pro', owner: 'team:acme' });
    await api(srv.url, 'DELETE', '/api/v1/teams/acme', { token });
    fake.st.failCancel = true;
    await srv.billing.closeAccount('team:acme');
    assert.equal(srv.store.data.billing.pendingCancels.length, 1, 'kept for another try');
    assert.equal(fake.st.subs[paid.subId].status, 'active');
    fake.st.failCancel = false;
    await srv.billing.drainCancels();
    assert.equal(fake.st.subs[paid.subId].status, 'canceled');
    assert.equal(srv.store.data.billing.pendingCancels.length, 0);
  } finally { await srv.close(); }
});

test('BIL-9: accounts are bound to the owner\'s id, and records from before binding are adopted or retired at startup', async () => {
  const { srv, fake, token } = await setup();
  const quiet = { info() {}, error() {} };
  try {
    await post(srv, token, '/api/v1/teams', { name: 'acme' });
    await subscribe(srv, fake, token, { plan: 'pro' });
    assert.equal(dbAccount(srv, 'user:alice').ownerRef, srv.store.userByName('alice').id, 'a user account holds the user id');

    // An account written before binding existed, for a team that is still there, and one for a team that is gone.
    const sub = (id) => ({ provider: 'stripe', plan: 'pro', status: 'active', subscriptionId: id, customerId: 'cus_x' });
    fake.st.subs.sub_legacy_1 = { id: 'sub_legacy_1', status: 'active', metadata: {}, items: { data: [] } };
    fake.st.subs.sub_legacy_2 = { id: 'sub_legacy_2', status: 'active', metadata: {}, items: { data: [] } };
    srv.store.data.billing.accounts['team:acme'] = { subscription: sub('sub_legacy_1') };
    srv.store.data.billing.accounts['team:ghost'] = { subscription: sub('sub_legacy_2') };
    const fresh = new BillingService({ store: srv.store, config: srv.config, teams: srv.teams, clock: srv.clock, fetchImpl: fake.fetchImpl, log: quiet });
    await fresh.drainCancels();
    assert.ok(srv.store.data.billing.accounts['team:acme'].ownerRef, 'adopted by the team that exists');
    assert.equal(fresh.planFor('team:acme'), 'pro');
    assert.equal(srv.store.data.billing.accounts['team:ghost'], undefined, 'no owner, so retired');
    assert.equal(fake.st.subs.sub_legacy_2.status, 'canceled', 'and cancelled at the provider');
    assert.equal(fake.st.subs.sub_legacy_1.status, 'active');
  } finally { await srv.close(); }
});

test('BIL-9b: Free is one allowance for a person and the teams they created, not one per team', async () => {
  const { srv, fake, people } = await setup({ users: ['alice', 'bob'] });
  const { alice, bob } = people;
  const site = (who, name, team) => post(srv, who.token, '/api/v1/sites', { name, ...(team ? { team } : {}) });
  try {
    for (const t of ['farm1', 'farm2', 'farm3']) assert.equal((await post(srv, alice.token, '/api/v1/teams', { name: t })).status, 201);
    // Three sites in all, wherever they are: the fourth is refused, in a team that has none of its own yet.
    assert.equal((await site(alice, 'a1')).status, 201);
    assert.equal((await site(alice, 'a2', 'farm1')).status, 201);
    assert.equal((await site(alice, 'a3', 'farm2')).status, 201);
    const refused = await site(alice, 'a4', 'farm3');
    assert.equal(refused.status, 402, 'a third team does not bring a new allowance');
    assert.equal(refused.body.code ?? refused.body.error, 'quota_exceeded');
    assert.equal((await site(alice, 'a5')).status, 402);
    const v = await billingOf(srv, alice.token, 'team:farm3');
    assert.equal(v.usage.sites, 3, 'the page shows the figure the limit is checked against');
    assert.equal(v.sharedWith, 3);

    // The same holds for the metered counts.
    srv.billing.record('team:farm1', 'build_minutes', 200);
    assert.throws(() => srv.billing.reserve('team:farm2', 'build_minutes', 101), (e) => e.status === 402);
    srv.billing.reserve('team:farm2', 'build_minutes', 100);

    // Someone else's team is someone else's allowance, and a paid team stands on its own limits.
    assert.equal((await post(srv, bob.token, '/api/v1/teams', { name: 'bobs' })).status, 201);
    assert.equal((await site(bob, 'b1', 'bobs')).status, 201);
    const paid = await subscribe(srv, fake, alice.token, { plan: 'pro', owner: 'team:farm3' });
    assert.equal(paid.confirm.body.plan, 'pro');
    assert.equal((await site(alice, 'a6', 'farm3')).status, 201, 'the paid team has its Pro limit');
    assert.equal((await billingOf(srv, alice.token, 'team:farm3')).sharedWith, undefined);
    assert.equal((await site(alice, 'a7')).status, 402, 'and the rest of the pool is still full');
  } finally { await srv.close(); }
});
