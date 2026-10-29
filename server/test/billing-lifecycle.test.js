// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// How a subscription moves: grace, plan changes, event order and trust, expiry. Fake providers throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { BillingService } from '../src/billing/billing.js';
import { setup, subscribe, billingOf, dbAccount, auditRows, stripeEvent, postStripe, postPaypal, DAY } from './billing-fixtures.js';

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
    assert.ok(auditRows(srv).some((a) => a.event === 'billing.event_ignored' && a.owner === 'user:alice'), 'an audit row says an event was ignored');
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

const sessionDone = (fake, sessionId, owner = 'user:alice') => {
  const s = fake.st.sessions[sessionId];
  return { id: sessionId, mode: 'subscription', payment_status: 'paid', client_reference_id: owner, subscription: s.subscription, customer: fake.st.subs[s.subscription]?.customer };
};
const subEvent = (srv, fake, type, subId, extra = {}, opts = {}) => stripeEvent(srv, type, { ...fake.st.subs[subId], ...extra }, opts);

test('BIL-2a: events are applied in the provider\'s order; an older one delivered late never undoes a newer one', async () => {
  const { srv, fake, token } = await setup();
  try {
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro' });
    const t = Math.floor(srv.clock() / 1000);
    // The cancellation (t+10) arrives first; the update that was sent before it (t+5) arrives late.
    const gone = await postStripe(srv, subEvent(srv, fake, 'customer.subscription.deleted', subId, { status: 'canceled' }, { created: t + 10 }));
    assert.equal(gone.body.applied, true);
    assert.equal((await billingOf(srv, token)).plan, 'free');
    const late = await postStripe(srv, subEvent(srv, fake, 'customer.subscription.updated', subId, { status: 'active' }, { created: t + 5 }));
    assert.equal(late.body.ignored, true, JSON.stringify(late.body));
    assert.equal((await billingOf(srv, token)).plan, 'free', 'a cancelled subscription is not live again');
    // Even a newer-looking "active" cannot revive a cancelled subscription: cancelled is final for that subscription.
    const odd = await postStripe(srv, subEvent(srv, fake, 'customer.subscription.updated', subId, { status: 'active' }, { created: t + 20 }));
    assert.equal(odd.body.ignored, true);
    assert.equal((await billingOf(srv, token)).plan, 'free');
  } finally { await srv.close(); }
});

test('BIL-2a: a stale failure notice does not take a newer recovery back', async () => {
  const { srv, fake, token } = await setup();
  try {
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro' });
    const t = Math.floor(srv.clock() / 1000);
    assert.equal((await postStripe(srv, subEvent(srv, fake, 'customer.subscription.updated', subId, { status: 'active', current_period_end: 2_100_000_000 }, { created: t + 10 }))).body.applied, true);
    const late = await postStripe(srv, failedInvoice(srv, subId, 'evt_late_fail').replace(/"created":\d+/, `"created":${t + 5}`));
    assert.equal(late.body.ignored, true);
    assert.equal(dbAccount(srv, 'user:alice').subscription.status, 'active');
    // Two events in the same second both apply: a second has no finer order, and ids are not an order.
    assert.equal((await postStripe(srv, failedInvoice(srv, subId, 'evt_same_sec').replace(/"created":\d+/, `"created":${t + 10}`))).body.applied, true);
    assert.equal(dbAccount(srv, 'user:alice').subscription.status, 'past_due');
  } finally { await srv.close(); }
});

test('BIL-2b: an event is marked seen only with its effect; a failed write is retried, not lost', async () => {
  const { srv, fake, token } = await setup();
  try {
    await checkout(srv, token, { plan: 'pro', provider: 'stripe' });
    const sessionId = Object.keys(fake.st.sessions).at(-1);
    const sub = fake.st.completeCheckout(sessionId);
    const paid = stripeEvent(srv, 'checkout.session.completed', sessionDone(fake, sessionId), { id: 'evt_paid_1' });

    const real = srv.store.flush.bind(srv.store);
    srv.store.flush = () => { throw new Error('disk full'); };
    const down = await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body: paid, headers: { 'stripe-signature': (await import('./billing-fixtures.js')).stripeSign(paid, Math.floor(srv.clock() / 1000)) } });
    assert.equal(down.status, 500);
    assert.equal(srv.store.data.billing.events['stripe:evt_paid_1'], undefined, 'not marked seen when the write failed');
    assert.equal(dbAccount(srv, 'user:alice').subscription.status, 'pending', 'memory holds what disk holds');

    srv.store.flush = real;
    const retry = await postStripe(srv, paid);
    assert.equal(retry.body.applied, true, `the provider's retry applies the upgrade: ${JSON.stringify(retry.body)}`);
    assert.equal((await billingOf(srv, token)).plan, 'pro');
    assert.equal(dbAccount(srv, 'user:alice').subscription.subscriptionId, sub.id);
    assert.equal((await postStripe(srv, paid)).body.duplicate, true, 'and only then is it a duplicate');
  } finally { await srv.close(); }
});

test('BIL-3a: only a paid subscription session this server created activates an account', async () => {
  const { srv, fake, token } = await setup({ users: ['alice', 'mallory'] });
  try {
    // mallory opens a Team checkout and abandons it: pending, not paid.
    await checkout(srv, token, { plan: 'team', provider: 'stripe' });
    const ours = Object.keys(fake.st.sessions).at(-1);
    assert.equal((await billingOf(srv, token)).plan, 'free');

    // A signed completed-event for some other session (a donation page on the same Stripe account) naming alice: no match, no plan.
    const other = stripeEvent(srv, 'checkout.session.completed', { id: 'cs_live_donation', mode: 'payment', payment_status: 'paid', client_reference_id: 'user:alice', customer: 'cus_other' });
    const r = await postStripe(srv, other);
    assert.equal(r.body.ignored, true);
    let acct = dbAccount(srv, 'user:alice');
    assert.equal(acct.subscription.status, 'pending');
    assert.equal(acct.subscription.customerId, undefined, 'the other payment\'s customer does not become the portal customer');
    // ...and a user with no account at all gets none.
    const nobody = stripeEvent(srv, 'checkout.session.completed', { id: 'cs_live_donation2', mode: 'subscription', payment_status: 'paid', client_reference_id: 'user:mallory', subscription: 'sub_x', customer: 'cus_o' });
    assert.equal((await postStripe(srv, nobody)).body.ignored, true);
    assert.equal(dbAccount(srv, 'user:mallory'), undefined);

    // Our own session, but not a paid subscription: nothing activates.
    const sub = fake.st.completeCheckout(ours);
    const unpaid = stripeEvent(srv, 'checkout.session.completed', { ...sessionDone(fake, ours), payment_status: 'unpaid' });
    assert.equal((await postStripe(srv, unpaid)).body.ignored, true);
    const wrongMode = stripeEvent(srv, 'checkout.session.completed', { ...sessionDone(fake, ours), mode: 'payment' });
    assert.equal((await postStripe(srv, wrongMode)).body.ignored, true);
    assert.equal((await billingOf(srv, token)).plan, 'free');

    // The real thing: our session, subscription mode, paid. The plan is the one chosen at checkout.
    const paid = await postStripe(srv, stripeEvent(srv, 'checkout.session.completed', { ...sessionDone(fake, ours), metadata: { plan: 'pro' } }));
    assert.equal(paid.body.applied, true);
    acct = dbAccount(srv, 'user:alice');
    assert.equal(acct.subscription.plan, 'team', 'the plan comes from our record, not from event metadata');
    assert.equal(acct.subscription.subscriptionId, sub.id);
    assert.equal(acct.subscription.customerId, sub.customer);
  } finally { await srv.close(); }
});

test('BIL-3b: the key mode is announced once at startup, and records of the other mode are not honoured', async () => {
  const lines = [];
  const log = { info: (m) => lines.push(m), error: (m) => lines.push(m) };
  const { srv, fake, token } = await setup({ billing: { stripe: { secretKey: 'sk_live_x', webhookSecret: 'whsec_test', api: 'https://stripe.test' } } });
  try {
    const mk = () => new BillingService({ store: srv.store, config: srv.config, teams: srv.teams, clock: srv.clock, fetchImpl: fake.fetchImpl, log });
    mk();
    assert.equal(lines.filter((l) => /stripe/i.test(l) && /live mode/i.test(l)).length, 1, `one line names Stripe's live mode: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes('sk_live')), 'the key is not printed');

    // A subscription recorded while the keys were test keys is not a paid plan now.
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro' });
    assert.equal(dbAccount(srv, 'user:alice').subscription.mode, 'live', 'a record says which mode wrote it');
    assert.equal((await billingOf(srv, token)).plan, 'pro');
    dbAccount(srv, 'user:alice').subscription.mode = 'test';
    const view = await billingOf(srv, token);
    assert.equal(view.plan, 'free');
    assert.equal(view.subscription, null);
    lines.length = 0;
    mk();
    assert.ok(lines.some((l) => /1 subscription record/.test(l) && /other mode/.test(l)), `the startup log counts them: ${JSON.stringify(lines)}`);

    // Events say which mode they come from; a test-mode event on live keys is ignored.
    dbAccount(srv, 'user:alice').subscription.mode = 'live';
    const t = stripeEvent(srv, 'customer.subscription.updated', { ...fake.st.subs[subId], status: 'canceled' }, { livemode: false });
    assert.equal((await postStripe(srv, t)).body.ignored, true);
    assert.equal((await billingOf(srv, token)).plan, 'pro');
    const l = stripeEvent(srv, 'customer.subscription.updated', { ...fake.st.subs[subId], status: 'canceled' }, { livemode: true });
    assert.equal((await postStripe(srv, l)).body.applied, true);
  } finally { await srv.close(); }

  // Records from before modes existed take the mode of the keys now in use.
  const t2 = await setup();
  try {
    t2.srv.store.data.billing.accounts['user:alice'] = { ownerRef: t2.srv.store.userByName('alice').id, subscription: { provider: 'stripe', plan: 'pro', status: 'active', subscriptionId: 'sub_old' } };
    const again = new BillingService({ store: t2.srv.store, config: t2.srv.config, teams: t2.srv.teams, clock: t2.srv.clock, fetchImpl: t2.fake.fetchImpl, log });
    assert.equal(t2.srv.store.data.billing.accounts['user:alice'].subscription.mode, 'test');
    assert.equal(again.planFor('user:alice'), 'pro');
  } finally { await t2.srv.close(); }
});

test('BIL-5c: a subscription past its paid period is past due, then lapses; the provider is asked and the answer is taken', async () => {
  const { srv, fake, token } = await setup();
  try {
    fake.st.periodEnd = Math.floor(srv.clock() / 1000) + 30 * 86_400;
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro' });
    const plan = async () => (await billingOf(srv, token)).plan;
    assert.equal(await plan(), 'pro');
    assert.equal((await billingOf(srv, token)).subscription.status, 'active');

    srv.clock.advance(31 * DAY);
    assert.equal(await plan(), 'pro', 'a day past the period end is inside the grace');
    assert.equal((await billingOf(srv, token)).subscription.status, 'past_due', 'and is shown as past due');
    srv.clock.advance(7 * DAY);
    assert.equal(await plan(), 'free', 'eight days past the period end, with no word from the provider, the paid plan lapses');

    // Stripe renewed it and the webhook never came: asking Stripe puts it right.
    fake.st.subs[subId].current_period_end = Math.floor(srv.clock() / 1000) + 20 * 86_400;
    await srv.billing.refresh();
    assert.equal(await plan(), 'pro');
    assert.equal((await billingOf(srv, token)).subscription.status, 'active');

    // Or it ended there and the cancel event never came.
    srv.clock.advance(21 * DAY);
    fake.st.subs[subId].status = 'canceled';
    await srv.billing.refresh();
    assert.equal(dbAccount(srv, 'user:alice').subscription.status, 'canceled');
    assert.equal(await plan(), 'free');
  } finally { await srv.close(); }
});

test('BIL-5c: PayPal does not announce renewals, so a lapsed period is refreshed from PayPal', async () => {
  const { srv, fake, token } = await setup();
  try {
    fake.st.periodEnd = Math.floor(srv.clock() / 1000) + 30 * 86_400;
    const { subId } = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    assert.ok(dbAccount(srv, 'user:alice').subscription.currentPeriodEnd, 'the period end is read');
    srv.clock.advance(40 * DAY);
    assert.equal((await billingOf(srv, token)).plan, 'free');
    fake.st.pp[subId].billing_info = { next_billing_time: new Date(srv.clock() + 25 * DAY).toISOString() };
    await srv.billing.refresh();
    assert.equal((await billingOf(srv, token)).plan, 'pro');
  } finally { await srv.close(); }
});

test('BIL-4b: a subscription id from the browser is checked before it goes into a Stripe URL', async () => {
  const { srv, fake, token } = await setup();
  try {
    await subscribe(srv, fake, token, { plan: 'pro' });
    const before = fake.calls.length;
    for (const bad of ['../customers/cus_X', '../../v1/balance', 'sub_1?expand[]=customer', 'sub_1/../x', 'cus_X', 'sub_1 ', '']) {
      const r = await confirm(srv, token, { provider: 'stripe', subscription_id: bad });
      // An empty id falls back to the account's own subscription; anything else must be refused outright.
      if (bad) assert.equal(r.body.error, 'not_confirmed', `refused: ${JSON.stringify(bad)} -> ${JSON.stringify(r.body)}`);
    }
    const sent = fake.calls.slice(before).map((c) => c.url);
    assert.ok(!sent.some((u) => u.includes('..') || u.includes('balance') || u.includes('customers') || u.includes('expand')), `nothing odd reached Stripe: ${JSON.stringify(sent)}`);
  } finally { await srv.close(); }
});
