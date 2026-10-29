// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Stripe, over its REST API with no SDK (no extra Stripe library). It covers
// Checkout Sessions for subscriptions, the customer portal, cancelling, and
// checking webhook signatures. A signature is an HMAC-SHA256 (a keyed hash
// that only someone with the secret can make) over "timestamp.payload", as
// Stripe documents. BillingService (billing.js) uses it.
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { PROVIDER_TIMEOUT_MS, providerError, providerFetch } from './provider-call.js';

const TOLERANCE_S = 300; // a webhook signed more than 5 minutes ago (or ahead) is refused
/** Which Stripe account the secret key belongs to: live or test (restricted keys carry the same marker). */
export const stripeMode = (key) => (/^(sk|rk)_live_/.test(key ?? '') ? 'live' : /^(sk|rk)_test_/.test(key ?? '') ? 'test' : 'unknown');
const SUB_ID = /^sub_\w+$/; // ids that go into a URL path are checked first
const idOf = (x) => (typeof x === 'string' ? x : x?.id ?? undefined); // an expandable field is an id or an object
// Stripe's subscription states, turned into Gitcha's own states.
const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete: 'pending', incomplete_expired: 'canceled', paused: 'canceled' };

/** Encodes an object the way Stripe's API wants (a web form), including nested keys like line_items[0][price]. */
export function form(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(form(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

/**
 * Checks the Stripe-Signature header ("t=TIME,v1=SIG,..."): the time must be within TOLERANCE_S
 * of `nowS`, and one v1 signature must match. The compare takes the same time whatever the
 * bytes (timingSafeEqual), so an attacker cannot guess the signature by timing it.
 */
export function verifyStripeSignature(rawBody, header, secret, nowS) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header ?? '').split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(nowS - t) > TOLERANCE_S) return false;
  // The MAC is over the exact bytes Stripe sent; the compare is on decoded bytes, after the lengths agree in characters and in bytes.
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const want = Buffer.from(expected, 'hex');
  return sigs.some((s) => { const got = Buffer.from(s, 'hex'); return s.length === expected.length && got.length === want.length && crypto.timingSafeEqual(got, want); });
}

/** Talks to Stripe for BillingService. Ids that go into a URL path are checked first. */
export class StripeProvider {
  constructor({ secretKey, webhookSecret, api, prices, fetchImpl, clock, log, timeoutMs = PROVIDER_TIMEOUT_MS }) {
    Object.assign(this, { secretKey, webhookSecret, api, prices, fetchImpl, clock, log, timeoutMs });
    this.mode = stripeMode(secretKey);
  }

  /** True when at least one plan has a Stripe Price id. */
  get canSell() { return Object.values(this.prices).some(Boolean); }

  /** Makes one API call. An `idempotencyKey` makes Stripe treat a repeat of the same request as one (safe to send twice). */
  async call(method, path, body, idempotencyKey) {
    const res = await providerFetch({ fetchImpl: this.fetchImpl, name: 'Stripe', code: 'stripe_error', log: this.log, timeoutMs: this.timeoutMs, what: `${method} ${path.split('?')[0]}` }, this.api + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`, 'Stripe-Version': '2024-06-20',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? form(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw providerError('Stripe', 'stripe_error', this.log, `${method} ${path.split('?')[0]} answered ${res.status}: ${json.error?.message ?? ''}`, res.status);
    return json;
  }

  /** Which Gitcha plan a Stripe Price id belongs to, or null. */
  planForPrice(priceId) {
    return Object.entries(this.prices).find(([, id]) => id && id === priceId)?.[0] ?? null;
  }

  /**
   * Starts a Checkout Session and returns the Stripe page to pay on. The owner and plan go in
   * the metadata. The idempotency key stays the same for a minute, so a repeat in that minute makes no second session.
   */
  async createCheckout({ owner, plan, successUrl, cancelUrl }) {
    const price = this.prices[plan];
    if (!price) throw new HttpError(400, 'provider_unavailable', `No Stripe price is configured for the ${plan} plan.`);
    const s = await this.call('POST', '/v1/checkout/sessions', {
      mode: 'subscription', client_reference_id: owner,
      line_items: [{ price, quantity: 1 }],
      success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`, cancel_url: cancelUrl,
      metadata: { owner, plan }, subscription_data: { metadata: { owner, plan } },
    }, `checkout-${owner}-${plan}-${Math.floor(this.clock() / 60_000)}`);
    return { url: s.url, ids: { checkoutSessionId: s.id } };
  }

  /** Asks Stripe about a checkout session ("cs_...") or a subscription ("sub_..."). Any other id gives null. */
  async lookup({ sessionId, subscriptionId }) {
    let sub;
    if (sessionId) {
      if (!/^cs_[\w]+$/.test(sessionId)) return null;
      const s = await this.call('GET', `/v1/checkout/sessions/${sessionId}?expand[]=subscription`);
      if (typeof s.subscription === 'string' && !SUB_ID.test(s.subscription)) return null;
      sub = typeof s.subscription === 'object' ? s.subscription : s.subscription ? await this.call('GET', `/v1/subscriptions/${s.subscription}`) : null;
      if (!sub) return null;
      return this.fromSubscription(sub, s.client_reference_id);
    }
    if (subscriptionId) {
      if (!SUB_ID.test(subscriptionId)) return null;
      return this.fromSubscription(await this.call('GET', `/v1/subscriptions/${subscriptionId}`));
    }
    return null;
  }

  /** Turns a Stripe subscription into Gitcha's shape: owner, status, plan, ids and period end. */
  fromSubscription(sub, fallbackOwner) {
    return {
      owner: sub.metadata?.owner ?? fallbackOwner ?? null,
      status: STATUS[sub.status] ?? 'pending',
      plan: this.planForPrice(sub.items?.data?.[0]?.price?.id) ?? sub.metadata?.plan ?? null,
      subscriptionId: sub.id, customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
      currentPeriodEnd: sub.current_period_end ? sub.current_period_end * 1000 : null,
    };
  }

  /** End the subscription now, or (atPeriodEnd) stop it renewing and let the period already paid for run out. */
  async cancel(sub, { atPeriodEnd = false } = {}) {
    if (!SUB_ID.test(sub.subscriptionId ?? '')) return;
    const path = `/v1/subscriptions/${sub.subscriptionId}`;
    try { await (atPeriodEnd ? this.call('POST', path, { cancel_at_period_end: true }) : this.call('DELETE', path)); } catch (err) { if (err.providerStatus !== 404) throw err; } // a 404 means it is already gone, which is as good as cancelled
  }

  /** A link to Stripe's customer portal, where the customer changes their card and sees invoices. */
  async portal(customerId, returnUrl) {
    const s = await this.call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    return s.url;
  }

  /** Checks a webhook's signature and turns it into { id, type, owner, status, plan, ... } (or null to ignore). */
  async verifyWebhook(rawBody, headers) {
    if (!this.webhookSecret) throw new HttpError(503, 'webhook_unconfigured', 'STRIPE_WEBHOOK_SECRET is not set.');
    if (!verifyStripeSignature(rawBody, headers['stripe-signature'], this.webhookSecret, Math.floor(this.clock() / 1000))) {
      throw new HttpError(400, 'bad_signature', 'Stripe signature check failed.');
    }
    const ev = JSON.parse(rawBody.toString('utf8'));
    const o = ev.data?.object ?? {};
    const at = Number.isFinite(ev.created) ? ev.created * 1000 : undefined; // Stripe's own time for the event
    const out = this.translate(ev, o);
    return out && { ...out, ...(at !== undefined ? { at } : {}), ...(typeof ev.livemode === 'boolean' ? { livemode: ev.livemode } : {}) };
  }

  /** Turns the Stripe event types we use into Gitcha's shape. Any other type comes back with no owner, and billing ignores it. */
  translate(ev, o) {
    switch (ev.type) {
      case 'checkout.session.completed':
        // Only a paid subscription session counts. Billing finds the account by the session id we saved, so any other session is ignored there.
        if (o.mode !== 'subscription' || !['paid', 'no_payment_required'].includes(o.payment_status)) return { id: ev.id, type: ev.type, owner: null };
        return { id: ev.id, type: ev.type, owner: o.client_reference_id ?? o.metadata?.owner, checkoutSessionId: o.id, status: 'active', subscriptionId: idOf(o.subscription), customerId: idOf(o.customer) };
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return { id: ev.id, type: ev.type, ...this.fromSubscription(o), ...(ev.type.endsWith('deleted') ? { status: 'canceled' } : {}) };
      case 'invoice.payment_failed':
        return { id: ev.id, type: ev.type, owner: o.subscription_details?.metadata?.owner ?? o.lines?.data?.[0]?.metadata?.owner, subscriptionId: idOf(o.subscription) ?? idOf(o.parent?.subscription_details?.subscription), status: 'past_due' };
      default:
        return { id: ev.id, type: ev.type, owner: null };
    }
  }
}
