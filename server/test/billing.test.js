// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { verifyStripeSignature, form } from '../src/billing/stripe.js';

const STRIPE_WH = 'whsec_test';

/** A fake Stripe + PayPal good enough to exercise our requests. */
function fakeProviders() {
  const calls = [];
  const state = { subs: {} };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (u.host === 'stripe.test') {
      if (init.headers.Authorization !== 'Bearer sk_test_x') return reply(401, { error: { message: 'bad key' } });
      if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
        const p = new URLSearchParams(init.body);
        state.lastOwner = p.get('client_reference_id');
        return reply(200, { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' });
      }
      if (u.pathname === '/v1/checkout/sessions/cs_test_1') {
        return reply(200, { id: 'cs_test_1', client_reference_id: state.lastOwner, subscription: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { owner: state.lastOwner, plan: 'pro' }, items: { data: [{ price: { id: 'price_pro' } }] }, current_period_end: 2000000000 } });
      }
      if (u.pathname === '/v1/subscriptions/sub_1' && init.method === 'DELETE') return reply(200, { id: 'sub_1', status: 'canceled' });
      if (u.pathname === '/v1/billing_portal/sessions') return reply(200, { url: 'https://billing.stripe.test/p/1' });
    }
    if (u.host === 'paypal.test') {
      if (u.pathname === '/v1/oauth2/token') return reply(200, { access_token: 'A21', expires_in: 3600 });
      if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
        const b = JSON.parse(init.body);
        state.subs['I-ABC'] = { id: 'I-ABC', status: 'APPROVAL_PENDING', custom_id: b.custom_id, plan_id: b.plan_id };
        return reply(201, { id: 'I-ABC', links: [{ rel: 'approve', href: 'https://paypal.test/approve/I-ABC' }] });
      }
      if (u.pathname === '/v1/billing/subscriptions/I-ABC') return reply(200, { ...state.subs['I-ABC'], status: state.paypalStatus ?? 'ACTIVE' });
      if (u.pathname === '/v1/notifications/verify-webhook-signature') {
        const b = JSON.parse(init.body);
        return reply(200, { verification_status: b.transmission_sig === 'good' && b.webhook_id === 'WH-1' ? 'SUCCESS' : 'FAILURE' });
      }
    }
    return reply(404, { message: `unexpected ${u.host}${u.pathname}` });
  };
  return { fetchImpl, calls, state };
}

const billingOverrides = {
  enabled: true,
  stripe: { secretKey: 'sk_test_x', webhookSecret: STRIPE_WH, api: 'https://stripe.test' },
  paypal: { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-1', api: 'https://paypal.test' },
  priceIds: { stripe: { pro: 'price_pro', team: null }, paypal: { pro: 'P-PRO', team: null } },
};

async function setup() {
  const fake = fakeProviders();
  const srv = await startServer({ env: { GITCHA_HOSTING_DOMAINS: 'pages.test' }, overrides: { billing: billingOverrides }, appOpts: { fetchImpl: fake.fetchImpl } });
  const alice = createUser(srv, 'alice', 'first long pass!');
  const token = await deviceLogin(srv, alice);
  return { srv, alice, token, fake };
}

function stripeSign(body, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', STRIPE_WH).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

test('Stripe signature verification and form encoding', () => {
  const body = Buffer.from('{"a":1}');
  const now = 1_800_000_000;
  const good = `t=${now},v1=${crypto.createHmac('sha256', 's').update(`${now}.{"a":1}`).digest('hex')}`;
  assert.equal(verifyStripeSignature(body, good, 's', now), true);
  assert.equal(verifyStripeSignature(body, good, 'wrong', now), false);
  assert.equal(verifyStripeSignature(Buffer.from('{"a":2}'), good, 's', now), false, 'tampered body');
  assert.equal(verifyStripeSignature(body, good, 's', now + 600), false, 'replayed too late');
  assert.equal(form({ line_items: [{ price: 'p', quantity: 1 }], metadata: { owner: 'user:a' } }), 'line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bowner%5D=user%3Aa');
});

test('free plan quotas: sites and function invocations answer 402 when used up', async () => {
  const { srv, token } = await setup();
  try {
    for (const n of ['s1', 's2', 's3']) assert.equal((await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: n } })).status, 201);
    const over = await api(srv.url, 'POST', '/api/v1/sites', { token, body: { name: 's4' } });
    assert.equal(over.status, 402);
    assert.equal(over.body.error, 'quota_exceeded');
    assert.equal(over.body.limit, 3);
    srv.billing.record('user:alice', 'fn_invocations', 10_000);
    assert.throws(() => srv.billing.check('user:alice', 'fn_invocations'), /10000 of 10000 function invocations/);
    const view = await api(srv.url, 'GET', '/api/v1/billing', { token });
    assert.equal(view.body.plan, 'free');
    assert.equal(view.body.usage.fn_invocations, 10_000);
    assert.deepEqual(view.body.providers.sort(), ['paypal', 'stripe']);
  } finally { await srv.close(); }
});

test('Stripe: checkout, server-side confirmation, webhooks, portal and cancel', async () => {
  const { srv, token, fake } = await setup();
  try {
    const co = await api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body: { plan: 'pro', provider: 'stripe' } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.url, 'https://checkout.stripe.test/pay/cs_test_1');
    const sent = fake.calls.find((c) => c.url === '/v1/checkout/sessions');
    assert.match(sent.body, /client_reference_id=user%3Aalice/);
    assert.match(sent.body, /success_url=.*session_id%3D%7BCHECKOUT_SESSION_ID%7D/);
    assert.ok(sent.headers['Idempotency-Key']);
    assert.equal((await api(srv.url, 'GET', '/api/v1/billing', { token })).body.plan, 'free', 'pending until confirmed');

    // A forged confirmation for someone else's session is refused.
    const bob = createUser(srv, 'bob', 'second long pass');
    const tb = await deviceLogin(srv, bob);
    assert.equal((await api(srv.url, 'POST', '/api/v1/billing/confirm', { token: tb, body: { provider: 'stripe', session_id: 'cs_test_1' } })).body.error, 'not_confirmed');

    const conf = await api(srv.url, 'POST', '/api/v1/billing/confirm', { token, body: { provider: 'stripe', session_id: 'cs_test_1' } });
    assert.equal(conf.body.plan, 'pro');
    assert.equal(conf.body.subscription.status, 'active');

    // Webhook: unsigned or tampered events are refused; a signed one applies once.
    const ev = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_failed', data: { object: { subscription_details: { metadata: { owner: 'user:alice' } } } } });
    assert.equal((await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body: ev, headers: { 'stripe-signature': 't=1,v1=00' } })).status, 400);
    const ok = await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body: ev, headers: { 'stripe-signature': stripeSign(ev) } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'past_due');
    const again = await (await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body: ev, headers: { 'stripe-signature': stripeSign(ev) } })).json();
    assert.equal(again.duplicate, true);
    assert.equal((await api(srv.url, 'GET', '/api/v1/billing', { token })).body.plan, 'pro', 'past due keeps paid limits during the grace period');

    assert.equal((await api(srv.url, 'POST', '/api/v1/billing/portal', { token, body: {} })).body.url, 'https://billing.stripe.test/p/1');
    const cancel = await api(srv.url, 'POST', '/api/v1/billing/cancel', { token, body: {} });
    assert.equal(cancel.body.plan, 'free');
    assert.ok(fake.calls.some((c) => c.method === 'DELETE' && c.url === '/v1/subscriptions/sub_1'));
  } finally { await srv.close(); }
});

test('PayPal: subscription approval, confirmation and verified webhooks', async () => {
  const { srv, token, fake } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
    const co = await api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body: { owner: 'team:acme', plan: 'pro', provider: 'paypal' } });
    assert.equal(co.body.url, 'https://paypal.test/approve/I-ABC');
    assert.equal(JSON.parse(fake.calls.find((c) => c.url === '/v1/billing/subscriptions').body).custom_id, 'team:acme');
    const conf = await api(srv.url, 'POST', '/api/v1/billing/confirm', { token, body: { owner: 'team:acme', provider: 'paypal', subscription_id: 'I-ABC' } });
    assert.equal(conf.body.plan, 'pro');

    const ev = { id: 'WH-EV-1', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-ABC', custom_id: 'team:acme', plan_id: 'P-PRO', status: 'CANCELLED' } };
    const bad = await fetch(`${srv.url}/api/v1/billing/paypal/webhook`, { method: 'POST', body: JSON.stringify(ev), headers: { 'paypal-transmission-sig': 'forged' } });
    assert.equal(bad.status, 400);
    const good = await fetch(`${srv.url}/api/v1/billing/paypal/webhook`, { method: 'POST', body: JSON.stringify(ev), headers: { 'paypal-transmission-sig': 'good' } });
    assert.equal((await good.json()).status, 'canceled');
    assert.equal((await api(srv.url, 'GET', '/api/v1/billing?owner=team:acme', { token })).body.plan, 'free');
  } finally { await srv.close(); }
});

test('billing is sensitive, owner-only for teams, and off unless enabled', async () => {
  const { srv, alice, token } = await setup();
  try {
    await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
    const bob = createUser(srv, 'bob', 'second long pass');
    const tb = await deviceLogin(srv, bob);
    await api(srv.url, 'PUT', '/api/v1/teams/acme/members/bob', { token, body: { role: 'maintainer' } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/billing/checkout', { token: tb, body: { owner: 'team:acme', plan: 'pro', provider: 'stripe' } })).status, 403, 'only team owners pay for a team');
    assert.equal((await api(srv.url, 'GET', '/api/v1/billing?owner=team:acme', { token: tb })).status, 200, 'members can look');
    srv.clock.advance(11 * 60_000);
    assert.equal((await api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body: { plan: 'pro', provider: 'stripe' } })).body.reason, 'sensitive_action');
    await api(srv.url, 'POST', '/api/v1/auth/step-up', { token, body: { code: alice.nextCode() } });
    assert.equal((await api(srv.url, 'POST', '/api/v1/billing/checkout', { token, body: { plan: 'free', provider: 'stripe' } })).body.error, 'bad_plan');
  } finally { await srv.close(); }
  const off = await startServer();
  try {
    assert.equal((await fetch(`${off.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body: '{}' })).status, 404, 'no billing endpoints when off');
    assert.doesNotThrow(() => off.billing.check('user:x', 'sites', 1000), 'no quotas when billing is off');
  } finally { await off.close(); }
});
