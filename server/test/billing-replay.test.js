// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-2c: how long a delivered event is remembered, and what happens to one older than that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, subscribe, billingOf, stripeEvent, postStripe, postPaypal, ppEvent, ppHeaders, DAY } from './billing-fixtures.js';

const unknownSub = (srv, n, id) => stripeEvent(srv, 'invoice.payment_failed', { subscription: `sub_unknown_${n}` }, { id });

test('BIL-2c: an event is remembered for a time, not for a count: thousands of later events do not make it replayable', async () => {
  const { srv } = await setup();
  try {
    const first = unknownSub(srv, 0, 'evt_first');
    assert.equal((await postStripe(srv, first)).body.reason, 'unknown_subscription');
    const events = srv.store.data.billing.events;
    for (let i = 0; i < 6000; i++) events[`stripe:filler_${i}`] = srv.clock();
    assert.equal((await postStripe(srv, unknownSub(srv, 1, 'evt_after'))).body.reason, 'unknown_subscription');
    assert.deepEqual((await postStripe(srv, first)).body, { duplicate: true }, 'the first event is still known after 6000 others');
    assert.ok(Object.keys(events).length > 6000, 'nothing was dropped for being one of many');
  } finally { await srv.close(); }
});

test('BIL-2c: an event is forgotten after the retention time, and the table does not keep growing past it', async () => {
  const { srv } = await setup();
  try {
    assert.equal((await postStripe(srv, unknownSub(srv, 0, 'evt_old'))).body.reason, 'unknown_subscription');
    srv.clock.advance(20 * DAY);
    assert.equal((await postStripe(srv, unknownSub(srv, 1, 'evt_mid'))).body.reason, 'unknown_subscription');
    assert.ok(srv.store.data.billing.events['stripe:evt_old'], 'still held after twenty days');
    srv.clock.advance(15 * DAY); // evt_old is now 35 days old, evt_mid 15
    assert.equal((await postStripe(srv, unknownSub(srv, 2, 'evt_new'))).body.reason, 'unknown_subscription');
    const held = Object.keys(srv.store.data.billing.events).sort();
    assert.deepEqual(held, ['stripe:evt_mid', 'stripe:evt_new']);
  } finally { await srv.close(); }
});

test('BIL-2c: a PayPal delivery created longer ago than events are remembered is ignored, so a captured one cannot be replayed late', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    assert.equal(paid.confirm.status, 200);
    const stale = ppEvent(srv, 'BILLING.SUBSCRIPTION.CANCELLED', { id: paid.subId, status: 'CANCELLED', custom_id: 'user:alice' }, { at: srv.clock() - 40 * DAY });
    const res = await postPaypal(srv, stale, ppHeaders('good'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ignored: true, reason: 'too_old' });
    const view = await billingOf(srv, token);
    assert.deepEqual([view.plan, view.subscription.status], ['pro', 'active']);
    const row = srv.store.data.audit.find((a) => a.event === 'billing.event_ignored' && a.reason === 'too_old');
    assert.equal(row?.owner, 'user:alice', 'and the refusal is written down');
    // A recent one still applies.
    const fresh = ppEvent(srv, 'BILLING.SUBSCRIPTION.CANCELLED', { id: paid.subId, status: 'CANCELLED', custom_id: 'user:alice' }, { at: srv.clock() - DAY });
    assert.equal((await postPaypal(srv, fresh, ppHeaders('good'))).body.applied, true);
  } finally { await srv.close(); }
});
