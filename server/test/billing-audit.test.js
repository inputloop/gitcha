// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The money trail: who changed an account's subscription, how, and who can read that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, stripeEvent, postStripe } from './billing-fixtures.js';

const post = (srv, token, p, body) => api(srv.url, 'POST', p, { token, body });

test('BIL-12: money rows say who or what made the change, and every owner of the account can read them', async () => {
  const { srv, fake, people } = await setup({ users: ['alice', 'bob', 'carol'] });
  const { alice, bob, carol } = people;
  const idOf = (name) => srv.store.userByName(name).id;
  try {
    await post(srv, alice.token, '/api/v1/teams', { name: 'acme' });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token: alice.token, body: { role: 'owner' } });
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/carol', { token: alice.token, body: { role: 'member' } });

    const paid = await subscribe(srv, fake, alice.token, { plan: 'pro', owner: 'team:acme' });
    assert.equal(paid.confirm.status, 200);
    const rows = (name) => srv.store.auditFor(idOf(name), 100).filter((a) => a.event.startsWith('billing.'));
    const confirmed = rows('alice').find((a) => a.event === 'billing.confirmed');
    assert.ok(confirmed, 'the confirm that made the team Pro is in alice\'s trail');
    assert.equal(confirmed.by, 'confirm');
    assert.equal(confirmed.actor, 'alice');
    assert.equal(confirmed.subscriptionId, paid.subId);
    assert.ok(rows('bob').some((a) => a.event === 'billing.confirmed'), 'and in the other owner\'s');
    assert.equal(rows('carol').length, 0, 'a plain member is not an owner of the money');

    // A provider-driven change is attributed to the webhook, with the event and subscription ids, in every owner's trail.
    const failed = stripeEvent(srv, 'invoice.payment_failed', { subscription: paid.subId, subscription_details: { metadata: { owner: 'team:acme' } } }, { id: 'evt_fail_audit' });
    assert.equal((await postStripe(srv, failed)).body.applied, true);
    for (const name of ['alice', 'bob']) {
      const w = rows(name).find((a) => a.event === 'billing.stripe:invoice.payment_failed');
      assert.ok(w, `${name} can see the webhook change`);
      assert.equal(w.by, 'webhook');
      assert.equal(w.eventId, 'evt_fail_audit');
      assert.equal(w.subscriptionId, paid.subId);
      assert.equal(w.status, 'past_due');
    }

    // bob cancels: alice, the other owner, can read who did it.
    const cancel = await post(srv, bob.token, '/api/v1/billing/cancel', { owner: 'team:acme' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const seen = rows('alice').find((a) => a.event === 'billing.canceled_by_user');
    assert.ok(seen, 'alice sees the cancellation');
    assert.equal(seen.actor, 'bob');
    assert.equal(seen.by, 'user');
    assert.ok(rows('bob').find((a) => a.event === 'billing.canceled_by_user').ip, 'the one who did it also has the address it came from');

    // The account's own history is readable by its owners, with the same attribution; a plain member does not get it.
    const h = (await billingOf(srv, alice.token, 'team:acme')).history;
    assert.ok(Array.isArray(h) && h.length >= 4);
    assert.deepEqual(h.map((e) => e.event).slice(0, 2), ['canceled_by_user', 'stripe:invoice.payment_failed']);
    assert.equal(h[1].by, 'webhook');
    assert.equal(h[1].eventId, 'evt_fail_audit');
    assert.equal((await billingOf(srv, carol.token, 'team:acme')).history, undefined);
  } finally { await srv.close(); }
});
