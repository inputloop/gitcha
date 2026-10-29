// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-13: GITCHA_CURRENCY has an effect on what the plans say they cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, billingOf } from './billing-fixtures.js';

const priceOf = (view, id) => view.plans.find((p) => p.id === id).price;

test('BIL-13: the default plans state their price in the configured currency (USD unless told otherwise)', async () => {
  const { srv, token } = await setup();
  try {
    assert.equal(priceOf(await billingOf(srv, token), 'pro'), '5 USD per month');
    assert.deepEqual(srv.billing.paidFeatures(), ['Pro plan (5 USD per month)', 'Team plan (20 USD per month)']);
  } finally { await srv.close(); }
});

test('BIL-13: GITCHA_CURRENCY changes it, and a price written as text in the plans file is shown as written', async () => {
  const { srv, token } = await setup({ billing: { currency: 'EUR' } });
  try {
    const view = await billingOf(srv, token);
    assert.equal(priceOf(view, 'pro'), '5 EUR per month');
    assert.equal(priceOf(view, 'team'), '20 EUR per month');
    assert.equal(priceOf(view, 'free'), null);
  } finally { await srv.close(); }
  const plans = {
    free: { name: 'Free', price: null, limits: { fn_invocations: 1, build_minutes: 1, sites: 1 }, paid: false },
    pro: { name: 'Pro', price: 'about 5 euros a month', limits: { fn_invocations: 9, build_minutes: 9, sites: 9 }, paid: true },
  };
  const again = await setup({ billing: { currency: 'EUR' }, plans });
  try {
    assert.equal(priceOf(await billingOf(again.srv, again.token), 'pro'), 'about 5 euros a month');
  } finally { await again.srv.close(); }
});
