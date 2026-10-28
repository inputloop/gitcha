// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Talking to Stripe and PayPal: what a user is told when they fail, how long we wait, and what an anonymous caller can make us do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { StripeProvider } from '../src/billing/stripe.js';
import { PayPalProvider } from '../src/billing/paypal.js';
import { setup, ppHeaders, postPaypal, ppEvent } from './billing-fixtures.js';

const quiet = () => { const lines = []; return { lines, info: (m) => lines.push(m), error: (m) => lines.push(m) }; };
const checkout = (srv, token, body) => api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body });
const hangs = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

test('BIL-11: a user is told one fixed thing when a provider fails; the provider\'s own words go to the log', async () => {
  const { srv, fake, token } = await setup();
  try {
    const log = quiet();
    srv.billing.log = log;
    fake.st.stripeError = { status: 403, message: "No such price: 'price_1Nxyz'. The provided key 'sk_test_********PRBE' does not have the required permissions on account 'acct_1AbCdEfGhIjK'." };
    const r = await checkout(srv, token, { plan: 'pro', provider: 'stripe' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'stripe_error');
    for (const secret of ['price_1Nxyz', 'sk_test', 'acct_1AbCdEfGhIjK', 'permissions']) assert.ok(!r.body.message.includes(secret), `the user is not told "${secret}": ${r.body.message}`);
    assert.ok(log.lines.some((l) => l.includes('price_1Nxyz') && l.includes('403')), 'the server log has what Stripe said');
    assert.ok(!log.lines.some((l) => l.includes('sk_test_x')), 'and never the key');

    fake.st.stripeError = null;
    fake.st.ppTokenFail = true;
    const pp = await checkout(srv, token, { plan: 'pro', provider: 'paypal' });
    assert.equal(pp.status, 502);
    assert.ok(!/PAYPAL_CLIENT|check /.test(pp.body.message), `no configuration hints for a user: ${pp.body.message}`);
    assert.ok(log.lines.some((l) => /PAYPAL_CLIENT_ID/.test(l)), 'the operator\'s hint is in the log');
  } finally { await srv.close(); }
});

test('BIL-14: a provider that does not answer is given up on', { timeout: 10_000 }, async () => {
  const log = quiet();
  const keepAlive = setTimeout(() => {}, 8000); // AbortSignal.timeout's own timer does not keep a bare process alive; a server's socket does
  const stripe = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'w', api: 'https://stripe.test', prices: { pro: 'price_pro' }, fetchImpl: hangs, clock: Date.now, log, timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(stripe.portal('cus_1', 'http://x'), (e) => e.status === 502 && e.code === 'stripe_error');
  assert.ok(Date.now() - t0 < 3000, 'gave up quickly');
  assert.ok(log.lines.some((l) => /no answer in 50 ms/.test(l)));
  const paypal = new PayPalProvider({ clientId: 'c', clientSecret: 's', webhookId: 'W', api: 'https://paypal.test', plans: {}, fetchImpl: hangs, clock: Date.now, log, timeoutMs: 50 });
  await assert.rejects(paypal.accessToken(), (e) => e.status === 502 && e.code === 'paypal_error');
  clearTimeout(keepAlive);
});

test('BIL-14: an anonymous PayPal webhook without PayPal\'s headers costs PayPal no call', async () => {
  const { srv, fake } = await setup();
  try {
    const before = fake.calls.length;
    const bare = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${srv.url}/api/v1/billing/paypal/webhook`, { method: 'POST', body: JSON.stringify({ id: `x${i}` }) })));
    assert.deepEqual([...new Set(bare.map((r) => r.status))], [400]);
    const partial = ppHeaders();
    delete partial['paypal-cert-url'];
    assert.equal((await fetch(`${srv.url}/api/v1/billing/paypal/webhook`, { method: 'POST', body: '{}', headers: partial })).status, 400);
    assert.equal(fake.calls.length, before, 'no token request and no verify request were made');
    assert.equal(fake.st.ppVerify, 0);
  } finally { await srv.close(); }
});

test('BIL-14: PayPal is asked once per delivery, and for one access token at a time', async () => {
  const { srv, fake } = await setup();
  try {
    const headers = ppHeaders();
    const ev = ppEvent(srv, 'BILLING.SUBSCRIPTION.UPDATED', { id: 'I-NONE', custom_id: 'user:alice' }, { id: 'WH-ONCE' });
    await Promise.all([postPaypal(srv, ev, headers), postPaypal(srv, ev, headers), postPaypal(srv, ev, headers)]);
    await postPaypal(srv, ev, headers);
    assert.equal(fake.st.ppVerify, 1, 'the same delivery four times is verified once');
    const other = await postPaypal(srv, ev, { ...headers, 'paypal-transmission-sig': 'forged' });
    assert.equal(other.status, 400, 'a different signature is not covered by the first answer');
    assert.equal(fake.st.ppVerify, 2);

    const fresh = await setup();
    try {
      const many = Array.from({ length: 12 }, (_, i) => postPaypal(fresh.srv, ppEvent(fresh.srv, 'BILLING.SUBSCRIPTION.UPDATED', { id: `I-N${i}` }, { id: `WH-M${i}` }), ppHeaders()));
      await Promise.all(many);
      assert.equal(fresh.fake.st.ppTokens, 1, 'twelve first calls share one token request');
    } finally { await fresh.srv.close(); }
  } finally { await srv.close(); }
});
