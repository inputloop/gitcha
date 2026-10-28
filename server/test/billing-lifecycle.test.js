// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// How a subscription moves: grace, plan changes, event order and trust, expiry. Fake providers throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, dbAccount, stripeEvent, postStripe, DAY } from './billing-fixtures.js';

const confirm = (srv, token, body) => api(srv.url, 'POST', '/api/v1/billing/confirm', { token, body });
const failedInvoice = (srv, subId, id, owner = 'user:alice') => stripeEvent(srv, 'invoice.payment_failed', { subscription: subId, subscription_details: { metadata: { owner } } }, { id });

test('BIL-6: the past_due grace runs from when it began, and confirm cannot extend it', async () => {
  const { srv, fake, token } = await setup();
  try {
    const { subId } = await subscribe(srv, fake, token);
    const plan = async () => (await billingOf(srv, token)).plan;
    assert.equal((await postStripe(srv, failedInvoice(srv, subId, 'evt_f1'))).status, 200);
    fake.st.subs[subId].status = 'unpaid'; // Stripe's "unpaid" and PayPal's SUSPENDED both read as past_due and do not end by themselves
    assert.equal(await plan(), 'pro', 'paid limits during the grace');

    srv.clock.advance(6 * DAY);
    const c = await confirm(srv, token, { provider: 'stripe', subscription_id: subId });
    assert.equal(c.body.subscription.status, 'past_due');
    assert.equal(await plan(), 'pro', 'day 6 is inside the grace');

    srv.clock.advance(2 * DAY);
    assert.equal(await plan(), 'free', 'day 8: a confirm on day 6 did not restart the seven days');
    await confirm(srv, token, { provider: 'stripe', subscription_id: subId });
    assert.equal(await plan(), 'free', 'confirming again does not bring the plan back');

    // A later failure notice (Stripe retries the invoice) is the same past-due spell, not a new one.
    assert.equal((await postStripe(srv, failedInvoice(srv, subId, 'evt_f2'))).status, 200);
    assert.equal(await plan(), 'free', 'a retry of the failed payment does not restart the grace');

    // Paying clears the spell; the next failure starts a fresh grace.
    fake.st.subs[subId].status = 'active';
    await confirm(srv, token, { provider: 'stripe', subscription_id: subId });
    assert.equal(await plan(), 'pro');
    assert.equal(dbAccount(srv, 'user:alice').subscription.pastDueSince, undefined, 'paying clears the spell');
    srv.clock.advance(DAY);
    await postStripe(srv, failedInvoice(srv, subId, 'evt_f3'));
    srv.clock.advance(6 * DAY);
    assert.equal(await plan(), 'pro', 'a new spell has its own seven days');
    srv.clock.advance(2 * DAY);
    assert.equal(await plan(), 'free');
  } finally { await srv.close(); }
});
