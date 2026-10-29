// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-15: tests for the behaviours a one-line breakage of the billing code used to leave green (the review's p19 mutations).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, startServer } from './helpers.js';
import { packFiles } from '../../extension/lib/tar.js';
import { setup, subscribe, billingOf, stripeEvent, postStripe, postPaypal, ppEvent, ppHeaders, STRIPE_WH, DAY } from './billing-fixtures.js';

const post = (srv, token, p, body) => api(srv.url, 'POST', p, { token, body });
const tgz = (files) => packFiles(Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) }))).toString('base64');
const stripeKeys = (extra = {}) => ({ secretKey: 'sk_test_x', webhookSecret: STRIPE_WH, api: 'https://stripe.test', ...extra });
const paypalKeys = (extra = {}) => ({ clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-1', api: 'https://paypal.test', ...extra });

// ---- webhooks that must refuse -------------------------------------------------------------------------------------------------------

test('BIL-15 (M03): with no Stripe webhook secret, a delivery signed with an empty key is refused, not believed', async () => {
  const { srv } = await setup({ billing: { stripe: stripeKeys({ webhookSecret: '' }) } });
  try {
    const body = stripeEvent(srv, 'invoice.payment_failed', { subscription: 'sub_1' });
    const t = Math.floor(srv.clock() / 1000);
    const sig = crypto.createHmac('sha256', '').update(`${t}.${body}`).digest('hex');
    const res = await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'webhook_unconfigured');
    assert.deepEqual(srv.store.data.billing.events, {}, 'and nothing was recorded as seen');
  } finally { await srv.close(); }
});

test('BIL-15 (M05): with no PayPal webhook id, a delivery is refused before PayPal is asked', async () => {
  const { srv, fake } = await setup({ billing: { paypal: paypalKeys({ webhookId: '' }) } });
  try {
    const res = await postPaypal(srv, ppEvent(srv, 'BILLING.SUBSCRIPTION.CANCELLED', { id: 'I-PP1', status: 'CANCELLED' }), ppHeaders('good'));
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'webhook_unconfigured');
    assert.equal(fake.st.ppVerify, 0, 'PayPal was never asked to verify it');
  } finally { await srv.close(); }
});

test('BIL-15 (M16): the webhook routes answer 404 when billing is off, even if provider keys are set and the signature is good', async () => {
  const { srv } = await setup({ billing: { enabled: false } });
  try {
    assert.ok(srv.billing.providers.stripe, 'the keys are there');
    const res = await postStripe(srv, stripeEvent(srv, 'invoice.payment_failed', { subscription: 'sub_1' }));
    assert.equal(res.status, 404);
    assert.equal((await postPaypal(srv, ppEvent(srv, 'BILLING.SUBSCRIPTION.CANCELLED', { id: 'I-PP1' }), ppHeaders('good'))).status, 404);
    assert.deepEqual(srv.store.data.billing.events, {});
  } finally { await srv.close(); }
});

// ---- events ------------------------------------------------------------------------------------------------------------------------------

test('BIL-15 (M07): an event seen a while ago is still a duplicate after later ones', async () => {
  const { srv } = await setup();
  try {
    const bodies = [1, 2, 3, 4].map((n) => stripeEvent(srv, 'invoice.payment_failed', { subscription: `sub_unknown_${n}` }, { id: `evt_dup_${n}` }));
    for (const b of bodies) assert.equal((await postStripe(srv, b)).body.reason, 'unknown_subscription');
    srv.clock.advance(DAY); // a day later, other events arrive and the table is trimmed
    assert.equal((await postStripe(srv, stripeEvent(srv, 'invoice.payment_failed', { subscription: 'sub_unknown_5' }, { id: 'evt_dup_5' }))).body.reason, 'unknown_subscription');
    for (const b of bodies) assert.deepEqual((await postStripe(srv, b)).body, { duplicate: true }, 'every one of them, not only the latest');
  } finally { await srv.close(); }
});

test('BIL-15 (M17): an event naming something that is not a Gitcha owner leaves no row about that name; one naming a real owner shape does', async () => {
  const { srv } = await setup();
  try {
    const ghost = (owner, id) => stripeEvent(srv, 'invoice.payment_failed', { subscription: 'sub_nobody', subscription_details: { metadata: { owner } } }, { id });
    assert.equal((await postStripe(srv, ghost('constructor', 'evt_c'))).body.reason, 'unknown_subscription');
    assert.equal((await postStripe(srv, ghost('user:zed', 'evt_z'))).body.reason, 'unknown_subscription');
    const rows = srv.store.data.audit.filter((a) => a.event === 'billing.event_ignored');
    assert.deepEqual(rows.map((a) => a.owner), ['user:zed'], 'only the well-formed owner is written down');
    assert.ok(srv.store.data.billing.events['stripe:evt_c'], 'but both were marked seen');
  } finally { await srv.close(); }
});

test('BIL-15 (M20): a Stripe subscription that is "unpaid" is past due, not active', async () => {
  const { srv, fake, token } = await setup();
  try {
    const paid = await subscribe(srv, fake, token, { plan: 'pro' });
    const evt = stripeEvent(srv, 'customer.subscription.updated', { id: paid.subId, status: 'unpaid', metadata: { owner: 'user:alice' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    assert.equal((await postStripe(srv, evt)).body.applied, true);
    assert.equal(srv.store.data.billing.accounts['user:alice'].subscription.status, 'past_due');
    assert.equal((await billingOf(srv, token)).subscription.status, 'past_due');
  } finally { await srv.close(); }
});

// ---- confirmation and checkout ----------------------------------------------------------------------------------------------

test('BIL-15 (M08): a return is not confirmed when the provider says the subscription belongs to another account', async () => {
  const { srv, fake, token } = await setup({ users: ['alice', 'bob'] });
  try {
    assert.equal((await post(srv, token, '/api/v1/billing/checkout', { plan: 'pro', provider: 'stripe' })).status, 200);
    const sessionId = Object.keys(fake.st.sessions).at(-1);
    const sub = fake.st.completeCheckout(sessionId);
    sub.metadata.owner = 'user:bob'; // the id is the one we recorded for alice; the provider's own record names someone else
    const res = await post(srv, token, '/api/v1/billing/confirm', { provider: 'stripe', session_id: sessionId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_confirmed');
    assert.equal(srv.store.data.billing.accounts['user:alice'].subscription.status, 'pending', 'still waiting');
  } finally { await srv.close(); }
});

test('BIL-15 (M18): a Stripe checkout is for one of the plan, and carries the owner twice (session and subscription)', async () => {
  const { srv, fake, token } = await setup();
  try {
    await post(srv, token, '/api/v1/billing/checkout', { plan: 'pro', provider: 'stripe' });
    const call = fake.calls.find((c) => c.url === '/v1/checkout/sessions' && c.method === 'POST');
    const p = new URLSearchParams(call.body);
    assert.equal(p.get('line_items[0][quantity]'), '1');
    assert.equal(p.get('line_items[0][price]'), 'price_pro');
    assert.equal(p.get('mode'), 'subscription');
    assert.equal(p.get('client_reference_id'), 'user:alice');
    assert.equal(p.get('metadata[owner]'), 'user:alice');
    assert.equal(p.get('subscription_data[metadata][owner]'), 'user:alice');
  } finally { await srv.close(); }
});

test('BIL-15 (M21, M22): cancelling and the portal need a fresh code, and work with one', async () => {
  const { srv, fake, people } = await setup({ longSessions: false });
  const { alice } = people;
  try {
    const paid = await subscribe(srv, fake, alice.token, { plan: 'pro' });
    assert.equal(paid.confirm.status, 200);
    srv.clock.advance(11 * 60_000);
    for (const route of ['cancel', 'portal']) {
      const res = await post(srv, alice.token, `/api/v1/billing/${route}`, {});
      assert.equal(res.body.reason, 'sensitive_action', route);
    }
    assert.equal(fake.st.subs[paid.subId].status, 'active', 'nothing was cancelled');
    assert.equal((await billingOf(srv, alice.token)).plan, 'pro');

    assert.equal((await post(srv, alice.token, '/api/v1/auth/step-up', { code: alice.user.nextCode() })).status, 200);
    assert.match((await post(srv, alice.token, '/api/v1/billing/portal', {})).body.url, /^https:\/\/billing\.stripe\.test\//);
    assert.equal((await post(srv, alice.token, '/api/v1/billing/cancel', {})).body.plan, 'free');
  } finally { await srv.close(); }
});

// ---- the quotas at the call sites (functions and CI), end to end through a runner -------------------------------------------------

const PLANS = {
  free: { name: 'Free', price: null, limits: { fn_invocations: 2, build_minutes: 2, sites: 3 }, paid: false },
  pro: { name: 'Pro', price: '5 per month', limits: { fn_invocations: 1000, build_minutes: 1000, sites: 50 }, paid: true },
};

/** A runner that is not a process: registered through the service, it claims and completes jobs when told to. */
function fakeRunner(srv) {
  const admin = srv.store.userByName('alice');
  const reg = srv.jobs.createRegistration(admin, {}, '127.0.0.1');
  const { id } = srv.jobs.register({ token: reg.token, name: 'test-runner' }, '127.0.0.1');
  const runner = srv.store.data.runners[id];
  return {
    async take() { const got = await srv.jobs.claim(runner, 3000); assert.ok(got, 'the runner was given a job'); return srv.jobs.get(got.job.id); },
    finish: (job, patch = {}) => srv.jobs.complete(job, { status: 'succeeded', exitCode: 0, response: { status: 200, body: 'hi' }, ...patch }),
  };
}

test('BIL-15 (M24, M25): function invocations are counted and, past the plan limit, refused with 402', async () => {
  const { srv, people } = await setup({ users: ['alice', 'bob'], plans: PLANS, env: { GITCHA_QUEUE_WAIT: '300ms' } });
  const bob = people.bob;
  try {
    const runner = fakeRunner(srv);
    const fn = tgz({ 'gitcha.fn.json': JSON.stringify({ name: 'hello', runtime: 'node', entry: 'index.js', timeout: '1s' }), 'index.js': 'export default () => ({ status: 200, body: "hi" })' });
    assert.equal((await api(srv.url, 'PUT', '/api/v1/functions', { token: bob.token, body: { tarball: fn } })).status, 201);
    const invoke = () => post(srv, bob.token, '/api/v1/functions/bob/hello/invoke', {});
    for (let i = 1; i <= 2; i++) {
      const [res] = await Promise.all([invoke(), runner.take().then((job) => runner.finish(job))]);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 200, `invocation ${i} ran`);
    }
    assert.equal((await billingOf(srv, bob.token)).usage.fn_invocations, 2, 'both were counted');
    const third = await invoke();
    assert.equal(third.status, 402);
    assert.equal(third.body.error, 'quota_exceeded');
    assert.equal(third.body.metric, 'fn_invocations');
  } finally { await srv.close(); }
});

test('BIL-15 (M26, M27): build minutes are counted from the time the build ran and, past the plan limit, a new build is refused', async () => {
  const { srv, people } = await setup({ users: ['alice', 'bob'], plans: PLANS });
  const bob = people.bob;
  try {
    const runner = fakeRunner(srv);
    const ci = tgz({ 'gitcha-ci.json': JSON.stringify({ image: 'docker.io/library/node:22-alpine', steps: ['echo hi'], timeout: '1s' }) });
    const queued = await post(srv, bob.token, '/api/v1/ci/runs', { tarball: ci });
    assert.equal(queued.status, 201);
    const job = await runner.take();
    srv.clock.advance(90_000); // ran for a minute and a half: two minutes, rounded up
    await runner.finish(job);
    assert.equal((await billingOf(srv, bob.token)).usage.build_minutes, 2);
    const refused = await post(srv, bob.token, '/api/v1/ci/runs', { tarball: ci });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.metric, 'build_minutes');
    srv.clock.advance(31 * DAY); // the allowance is monthly
    assert.equal((await post(srv, bob.token, '/api/v1/ci/runs', { tarball: ci })).status, 201);
  } finally { await srv.close(); }
});
