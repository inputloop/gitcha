// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-5d: cancelling in Gitcha stops renewal; the paid period already bought keeps its plan until it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, stripeEvent, postStripe, postPaypal, ppEvent, ppHeaders, DAY } from './billing-fixtures.js';

const post = (srv, token, p, body) => api(srv.url, 'POST', p, { token, body });
const writes = (fake, subId) => fake.calls.filter((c) => c.url === `/v1/subscriptions/${subId}` && c.method !== 'GET');

test('BIL-5d: a Stripe subscription cancelled in Gitcha stops renewing and keeps its plan to the end of the paid period', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro' });
    const periodEnd = fake.st.subs[paid.subId].current_period_end * 1000;
    const res = await post(srv, token, '/api/v1/billing/cancel', {});
    assert.equal(res.status, 200);
    assert.deepEqual(writes(fake, paid.subId).map((c) => c.method), ['POST'], 'Stripe was asked to stop renewing, not to end the subscription now');
    assert.equal(new URLSearchParams(writes(fake, paid.subId)[0].body).get('cancel_at_period_end'), 'true');
    assert.deepEqual([res.body.plan, res.body.subscription.status, res.body.subscription.endsAt], ['pro', 'canceled', periodEnd]);

    srv.clock.advance(29 * DAY);
    assert.equal((await billingOf(srv, token)).plan, 'pro', 'still paid on day 29');
    srv.clock.advance(2 * DAY);
    const after = await billingOf(srv, token);
    assert.equal(after.plan, 'free', 'and free once the period is over');
    assert.equal(after.subscription.endsAt ?? null, null);
    // Stripe's own end-of-period delete changes nothing more.
    assert.equal((await postStripe(srv, stripeEvent(srv, 'customer.subscription.deleted', { id: paid.subId, status: 'canceled', metadata: { owner: 'user:alice' }, items: { data: [{ price: { id: 'price_pro' } }] } }))).status, 200);
    assert.equal((await billingOf(srv, token)).plan, 'free');
  } finally { await srv.close(); }
});

test('BIL-5d: a cancelled subscription that Stripe still reports as active is not brought back by a late event or a confirm', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro' });
    await post(srv, token, '/api/v1/billing/cancel', {});
    const evt = stripeEvent(srv, 'customer.subscription.updated', { id: paid.subId, status: 'active', cancel_at_period_end: true, metadata: { owner: 'user:alice' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    assert.deepEqual((await postStripe(srv, evt)).body, { ignored: true, reason: 'subscription_ended' });
    await post(srv, token, '/api/v1/billing/confirm', { provider: 'stripe', subscription_id: paid.subId });
    const view = await billingOf(srv, token);
    assert.deepEqual([view.plan, view.subscription.status], ['pro', 'canceled'], 'still cancelled, still paid to the end');
  } finally { await srv.close(); }
});

test('BIL-5d: PayPal cancels at once, so Gitcha holds the plan to the period end itself', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    const res = await post(srv, token, '/api/v1/billing/cancel', {});
    assert.equal(fake.st.pp[paid.subId].status, 'CANCELLED');
    assert.deepEqual([res.body.plan, res.body.subscription.status], ['pro', 'canceled']);
    // PayPal's own notice that it cancelled does not shorten it.
    await postPaypal(srv, ppEvent(srv, 'BILLING.SUBSCRIPTION.CANCELLED', { id: paid.subId, status: 'CANCELLED', custom_id: 'user:alice' }), ppHeaders('good'));
    assert.equal((await billingOf(srv, token)).plan, 'pro');
    srv.clock.advance(31 * DAY);
    assert.equal((await billingOf(srv, token)).plan, 'free');
  } finally { await srv.close(); }
});

test('BIL-5d: an account whose last payment failed has no paid period to keep: cancelling it ends the plan now, by a real cancel at Stripe', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro' });
    await postStripe(srv, stripeEvent(srv, 'invoice.payment_failed', { subscription: paid.subId }));
    assert.equal((await billingOf(srv, token)).subscription.status, 'past_due');
    const res = await post(srv, token, '/api/v1/billing/cancel', {});
    assert.equal(res.body.plan, 'free');
    assert.deepEqual(writes(fake, paid.subId).map((c) => c.method), ['DELETE']);
  } finally { await srv.close(); }
});

test('BIL-5d: starting a checkout in the paid time left after a cancel waits in its slot and costs nothing already paid', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro' });
    await post(srv, token, '/api/v1/billing/cancel', {});
    const co = await post(srv, token, '/api/v1/billing/checkout', { plan: 'team', provider: 'stripe' });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    const waiting = await billingOf(srv, token);
    assert.deepEqual([waiting.plan, waiting.subscription.status, waiting.pendingCheckout?.plan], ['pro', 'canceled', 'team'], 'the paid time is untouched while the buyer is at the provider');
    const sessionId = Object.keys(fake.st.sessions).at(-1);
    fake.st.completeCheckout(sessionId);
    const conf = await post(srv, token, '/api/v1/billing/confirm', { provider: 'stripe', session_id: sessionId });
    assert.deepEqual([conf.body.plan, conf.body.subscription.status], ['team', 'active']);
    assert.deepEqual(writes(fake, paid.subId).map((c) => c.method), ['POST'], 'the old subscription was not cancelled a second time');
    // The same plan again is allowed too (it is not "already subscribed" once it has been cancelled).
    const again = await subscribe(srv, fake, token, { plan: 'pro' });
    assert.equal(again.checkout.status, 200);
  } finally { await srv.close(); }
});
