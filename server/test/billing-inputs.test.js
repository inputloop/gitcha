// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-4a: what a signed-in user, or a signed event, can feed the billing code that is not the plain case, and must not turn into a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, postPaypal, ppEvent, ppHeaders } from './billing-fixtures.js';

test('BIL-4a: a provider name that is an Object.prototype key is "not set up" (400), on checkout, confirm and the webhook path', async () => {
  const { srv, token } = await setup();
  try {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const co = await api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body: { plan: 'pro', provider: name } });
      assert.deepEqual([co.status, co.body.error], [400, 'provider_unavailable'], `checkout with provider ${name}`);
      const cf = await api(srv.url, 'POST', '/api/v1/billing/confirm', { token, body: { provider: name, session_id: 'cs_test_1' } });
      assert.deepEqual([cf.status, cf.body.error], [400, 'provider_unavailable'], `confirm with provider ${name}`);
      await assert.rejects(() => srv.billing.webhook(name, Buffer.from('{}'), {}), (err) => err.status === 404, `webhook for ${name}`);
    }
  } finally { await srv.close(); }
});

test('BIL-4a: a JSON body of null is an empty body on every billing route', async () => {
  const { srv, token } = await setup();
  try {
    const want = { checkout: 400, confirm: 400, cancel: 409, portal: 409 };
    for (const [route, status] of Object.entries(want)) {
      const res = await fetch(`${srv.url}/api/v1/billing/${route}`, { method: 'POST', body: 'null', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      assert.equal(res.status, status, route);
    }
  } finally { await srv.close(); }
});

test('BIL-4a: a signed PayPal event whose type is an Object.prototype key changes nothing', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro', provider: 'paypal' });
    assert.equal(paid.confirm.status, 200);
    const res = await postPaypal(srv, ppEvent(srv, 'toString', { id: paid.subId, status: 'CANCELLED', custom_id: 'user:alice' }), ppHeaders('good'));
    assert.equal(res.status, 200);
    assert.notEqual(res.body.applied, true);
    const view = await billingOf(srv, token);
    assert.deepEqual([view.plan, view.subscription.status], ['pro', 'active']);
  } finally { await srv.close(); }
});
