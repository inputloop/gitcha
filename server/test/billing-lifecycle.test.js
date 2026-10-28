// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// How a subscription moves: grace, plan changes, event order and trust, expiry. Fake providers throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, dbAccount, stripeEvent, postStripe, postPaypal, DAY } from './billing-fixtures.js';

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

const checkout = (srv, token, body) => api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body });
const deleted = (fake, subId) => fake.calls.filter((c) => c.method === 'DELETE' && c.url === `/v1/subscriptions/${subId}`).length;

test('BIL-5a: a checkout for another plan leaves the paid subscription alone until the new one is confirmed, then cancels the old one first', async () => {
  const { srv, fake, token } = await setup();
  try {
    const first = await subscribe(srv, fake, token, { plan: 'pro' });
    assert.equal(first.confirm.body.plan, 'pro');
    assert.equal((await checkout(srv, token, { plan: 'pro', provider: 'stripe' })).body.error, 'already_subscribed', 'the same plan twice is refused');

    const co = await checkout(srv, token, { plan: 'team', provider: 'stripe' });
    assert.equal(co.status, 200);
    const sessionId = Object.keys(fake.st.sessions).at(-1);
    let view = await billingOf(srv, token);
    assert.equal(view.plan, 'pro', 'opening a checkout does not take the paid plan away');
    assert.equal(view.subscription.status, 'active');
    assert.equal(view.subscription.plan, 'pro');
    assert.equal(deleted(fake, first.subId), 0, 'nothing is cancelled before the new plan is paid');

    // The buyer pays; the provider cannot cancel the old subscription: nothing switches and the confirm can be retried.
    const second = fake.st.completeCheckout(sessionId);
    fake.st.failCancel = true;
    const failed = await confirm(srv, token, { provider: 'stripe', session_id: sessionId });
    assert.equal(failed.status, 502);
    view = await billingOf(srv, token);
    assert.equal(view.plan, 'pro');
    assert.equal(dbAccount(srv, 'user:alice').subscription.subscriptionId, first.subId, 'still on the old subscription');
    fake.st.failCancel = false;

    const ok = await confirm(srv, token, { provider: 'stripe', session_id: sessionId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.plan, 'team');
    assert.equal(fake.st.subs[first.subId].status, 'canceled', 'the old subscription is cancelled at the provider');
    assert.equal(fake.st.subs[second.id].status, 'active');
    const acct = dbAccount(srv, 'user:alice');
    assert.equal(acct.subscription.subscriptionId, second.id);
    assert.equal(acct.checkout, undefined, 'the pending slot is cleared');

    // The old subscription's own "deleted" event (Stripe sends it because we cancelled) must not undo the new plan.
    const gone = stripeEvent(srv, 'customer.subscription.deleted', { ...fake.st.subs[first.subId], status: 'canceled' });
    assert.equal((await postStripe(srv, gone)).body.ignored, true);
    assert.equal((await billingOf(srv, token)).plan, 'team');
  } finally { await srv.close(); }
});

test('BIL-5a: an abandoned upgrade checkout changes nothing, and PayPal switches the same way', async () => {
  const { srv, fake, token } = await setup();
  try {
    const first = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    assert.equal(first.confirm.body.plan, 'pro');
    await checkout(srv, token, { plan: 'team', provider: 'paypal' });
    const pending = Object.keys(fake.st.pp).at(-1);
    assert.notEqual(pending, first.subId);
    assert.equal((await billingOf(srv, token)).plan, 'pro', 'abandoned or not, the paid plan stands');
    assert.equal(fake.st.pp[first.subId].status, 'ACTIVE');

    fake.st.approve(pending);
    const ev = { id: 'WH-ACT-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: pending, custom_id: 'user:alice', plan_id: 'P-TEAM', status: 'ACTIVE' } };
    const r = await postPaypal(srv, ev);
    assert.equal(r.body.applied, true, JSON.stringify(r.body));
    assert.equal(fake.st.pp[first.subId].status, 'CANCELLED', 'the old PayPal subscription is cancelled');
    const view = await billingOf(srv, token);
    assert.equal(view.plan, 'team');
    assert.equal(dbAccount(srv, 'user:alice').subscription.subscriptionId, pending);
  } finally { await srv.close(); }
});

test('BIL-5b: an event for a subscription the account does not hold is recorded and ignored, whoever it names', async () => {
  const { srv, fake, token } = await setup();
  try {
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro' });
    // Stripe: a "deleted" for some other subscription that names alice in its metadata.
    const other = stripeEvent(srv, 'customer.subscription.deleted', { id: 'sub_orphan', status: 'canceled', customer: 'cus_x', metadata: { owner: 'user:alice', plan: 'pro' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    const r = await postStripe(srv, other);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, true);
    const view = await billingOf(srv, token);
    assert.equal(view.plan, 'pro');
    assert.equal(dbAccount(srv, 'user:alice').subscription.subscriptionId, subId);
    assert.ok(srv.store.data.audit.some((a) => a.event === 'billing.event_ignored' && a.owner === 'user:alice'), 'an audit row says an event was ignored');
  } finally { await srv.close(); }
});

test('BIL-5b: PayPal custom_id naming a victim cannot cancel the victim', async () => {
  const { srv, fake, token } = await setup();
  try {
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    const forged = { id: 'WH-FORGE-1', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-ATTACKER', custom_id: 'user:alice', plan_id: 'P-PRO', status: 'CANCELLED' } };
    const r = await postPaypal(srv, forged);
    assert.equal(r.body.ignored, true);
    assert.equal((await billingOf(srv, token)).plan, 'pro');
    assert.equal(dbAccount(srv, 'user:alice').subscription.subscriptionId, subId);
  } finally { await srv.close(); }
});
