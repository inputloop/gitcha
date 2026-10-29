// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A stateful fake Stripe and PayPal, plus the helpers the billing tests share. Not a test file itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, createUser, api, deviceLogin, tmpDir } from './helpers.js';

export const STRIPE_WH = 'whsec_test';
export const DAY = 86_400_000;
const BIG = 1e13;

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

/** In-memory Stripe and PayPal. `calls` lists every request the server made; `st` is what the providers hold. */
export function fakeProviders() {
  const calls = [];
  const st = {
    n: 0, sessions: {}, subs: {}, pp: {}, ppVerify: 0, ppTokens: 0, periodEnd: 2_000_000_000,
    stripeError: null, // { status, message } makes every Stripe call answer with it
    failCancel: false, // cancelling a subscription at either provider answers 500
    ppTokenFail: false, // PayPal refuses to issue an access token
    gate: null, // async (url, init) => ... awaited before a request is answered (to hold it open)
  };
  const priceOf = { pro: 'price_pro', team: 'price_team' };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, host: u.host, signal: init.signal });
    if (st.gate) await st.gate(u, init);
    if (u.host === 'stripe.test') {
      if (st.stripeError) return reply(st.stripeError.status, { error: { message: st.stripeError.message } });
      if (init.headers.Authorization !== 'Bearer sk_test_x' && init.headers.Authorization !== 'Bearer sk_live_x') return reply(401, { error: { message: 'bad key' } });
      let m;
      if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
        const p = new URLSearchParams(init.body);
        const id = `cs_test_${++st.n}`;
        st.sessions[id] = { id, mode: 'subscription', payment_status: 'unpaid', client_reference_id: p.get('client_reference_id'), owner: p.get('metadata[owner]'), plan: p.get('metadata[plan]'), price: p.get('line_items[0][price]'), subscription: null };
        return reply(200, { id, url: `https://checkout.stripe.test/pay/${id}` });
      }
      if ((m = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(u.pathname))) {
        const s = st.sessions[m[1]];
        if (!s) return reply(404, { error: { message: 'No such session' } });
        return reply(200, { ...s, subscription: s.subscription ? st.subs[s.subscription] : null });
      }
      if ((m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(u.pathname))) {
        const s = st.subs[m[1]];
        if (!s) return reply(404, { error: { message: `No such subscription: '${m[1]}'` } });
        if (init.method === 'DELETE') {
          if (st.failCancel) return reply(500, { error: { message: 'cancel failed' } });
          s.status = 'canceled';
        }
        return reply(200, s);
      }
      if (u.pathname === '/v1/billing_portal/sessions') return reply(200, { url: `https://billing.stripe.test/p/${new URLSearchParams(init.body).get('customer')}` });
    }
    if (u.host === 'paypal.test') {
      if (u.pathname === '/v1/oauth2/token') { st.ppTokens++; return st.ppTokenFail ? reply(401, { error: 'invalid_client' }) : reply(200, { access_token: 'A21', expires_in: 3600 }); }
      if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
        const b = JSON.parse(init.body);
        const id = `I-PP${++st.n}`;
        st.pp[id] = { id, status: 'APPROVAL_PENDING', custom_id: b.custom_id, plan_id: b.plan_id };
        return reply(201, { id, links: [{ rel: 'approve', href: `https://paypal.test/approve/${id}` }] });
      }
      let m;
      if ((m = /^\/v1\/billing\/subscriptions\/(I-\w+)\/cancel$/.exec(u.pathname))) {
        if (!st.pp[m[1]]) return reply(404, { message: 'no such subscription' });
        if (st.failCancel) return reply(500, { message: 'cancel failed' });
        st.pp[m[1]].status = 'CANCELLED';
        return reply(204, {});
      }
      if ((m = /^\/v1\/billing\/subscriptions\/(I-\w+)$/.exec(u.pathname))) return st.pp[m[1]] ? reply(200, st.pp[m[1]]) : reply(404, { message: 'no such subscription' });
      if (u.pathname === '/v1/notifications/verify-webhook-signature') {
        st.ppVerify++;
        const b = JSON.parse(init.body);
        return reply(200, { verification_status: b.transmission_sig === 'good' && b.webhook_id === 'WH-1' ? 'SUCCESS' : 'FAILURE' });
      }
    }
    return reply(404, { message: `unexpected ${u.host}${u.pathname}` });
  };
  /** The buyer paid at Stripe: the session gets a subscription. */
  st.completeCheckout = (sessionId, status = 'active') => {
    const s = st.sessions[sessionId];
    const id = `sub_${++st.n}`;
    st.subs[id] = { id, status, customer: `cus_${st.n}`, metadata: { owner: s.owner, plan: s.plan }, items: { data: [{ price: { id: priceOf[s.plan] } }] }, current_period_end: st.periodEnd };
    s.subscription = id;
    s.payment_status = 'paid';
    return st.subs[id];
  };
  /** The buyer approved at PayPal. */
  st.approve = (id, status = 'ACTIVE') => { st.pp[id].status = status; st.pp[id].billing_info = { next_billing_time: new Date(st.periodEnd * 1000).toISOString() }; return st.pp[id]; };
  return { fetchImpl, calls, st };
}

export const billingOverrides = (extra = {}) => ({
  enabled: true,
  stripe: { secretKey: 'sk_test_x', webhookSecret: STRIPE_WH, api: 'https://stripe.test' },
  paypal: { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-1', api: 'https://paypal.test' },
  priceIds: { stripe: { pro: 'price_pro', team: 'price_team' }, paypal: { pro: 'P-PRO', team: 'P-TEAM' } },
  ...extra,
});

/**
 * A server with billing on against the fake providers, and the first user signed in. Sessions never expire while the clock jumps,
 * unless `longSessions` is false (to test the fresh-code rule). `plans` replaces the plan table (written to a plans file).
 */
export async function setup({ billing = {}, env = {}, users = ['alice'], plans = null, longSessions = true } = {}) {
  const fake = fakeProviders();
  let plansFile;
  if (plans) { plansFile = path.join(tmpDir('gitcha-plans-'), 'plans.json'); fs.writeFileSync(plansFile, JSON.stringify(plans)); }
  const srv = await startServer({
    env: { GITCHA_HOSTING_DOMAINS: 'pages.test', ...env },
    overrides: { billing: billingOverrides({ ...(plansFile ? { plansFile } : {}), ...billing }), ...(longSessions ? { policy: { sessionIdle: BIG, sessionMaxAge: BIG, stepUpInterval: BIG, sensitiveWindow: BIG, stepUpOnNewNetwork: false } } : {}) },
    appOpts: { fetchImpl: fake.fetchImpl },
  });
  const people = {};
  try {
    for (const name of users) {
      const user = createUser(srv, name, 'plum river lantern 42');
      people[name] = { user, token: await deviceLogin(srv, user) };
    }
  } catch (err) { await srv.close(); throw err; }
  const first = people[users[0]];
  return { srv, fake, token: first.token, alice: first.user, people };
}

const call = (srv, token) => (method, p, body) => api(srv.url, method, p, { token, body });

/** Check out `plan` with `provider` for `owner`, let the provider say it is paid, and confirm the return. Returns the confirm response. */
export async function subscribe(srv, fake, token, { plan = 'pro', provider = 'stripe', owner } = {}) {
  const a = call(srv, token);
  const co = await a('POST', '/api/v1/billing/checkout', { owner, plan, provider });
  if (co.status !== 200) return { checkout: co };
  if (provider === 'stripe') {
    const sessionId = Object.keys(fake.st.sessions).at(-1);
    const sub = fake.st.completeCheckout(sessionId);
    const conf = await a('POST', '/api/v1/billing/confirm', { owner, provider, session_id: sessionId });
    return { checkout: co, confirm: conf, sessionId, subId: sub.id };
  }
  const subId = Object.keys(fake.st.pp).at(-1);
  fake.st.approve(subId);
  const conf = await a('POST', '/api/v1/billing/confirm', { owner, provider, subscription_id: subId });
  return { checkout: co, confirm: conf, subId };
}

export const billingOf = async (srv, token, owner) => (await api(srv.url, 'GET', `/api/v1/billing${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`, { token })).body;
export const dbAccount = (srv, key) => srv.store.data.billing.accounts[key];

let seq = 0;
export function stripeSign(body, t) {
  const sig = crypto.createHmac('sha256', STRIPE_WH).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

/** A Stripe event as the wire carries it. `created` defaults to the server's clock. */
export function stripeEvent(srv, type, object, { id = `evt_${++seq}`, created = Math.floor(srv.clock() / 1000), livemode = false } = {}) {
  return JSON.stringify({ id, type, created, livemode, data: { object } });
}

export async function postStripe(srv, body, { t = Math.floor(srv.clock() / 1000) } = {}) {
  const res = await fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': stripeSign(body, t) } });
  return { status: res.status, body: await res.json() };
}

export const ppHeaders = (sig = 'good') => ({
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert.pem', 'paypal-transmission-id': `tx-${++seq}`,
  'paypal-transmission-sig': sig, 'paypal-transmission-time': '2026-10-28T10:00:00Z',
});

export async function postPaypal(srv, event, headers = ppHeaders()) {
  const res = await fetch(`${srv.url}/api/v1/billing/paypal/webhook`, { method: 'POST', body: JSON.stringify(event), headers });
  return { status: res.status, body: await res.json() };
}

export const ppEvent = (srv, type, resource, { id = `WH-EV-${++seq}`, at = srv.clock() } = {}) => ({ id, event_type: type, create_time: new Date(at).toISOString(), resource });
