// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Stripe, over its REST API with no SDK: Checkout Sessions for subscriptions,
// the customer portal, cancellation, and webhook signature verification
// (HMAC-SHA256 over "timestamp.payload", as Stripe documents).
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';

const TOLERANCE_S = 300;
const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete: 'pending', incomplete_expired: 'canceled', paused: 'canceled' };

/** Stripe's form encoding, including nested keys like line_items[0][price]. */
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

export function verifyStripeSignature(rawBody, header, secret, nowS) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header ?? '').split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(nowS - t) > TOLERANCE_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export class StripeProvider {
  constructor({ secretKey, webhookSecret, api, prices, fetchImpl, clock }) {
    Object.assign(this, { secretKey, webhookSecret, api, prices, fetchImpl, clock });
  }

  get canSell() { return Object.values(this.prices).some(Boolean); }

  async call(method, path, body, idempotencyKey) {
    const res = await this.fetchImpl(this.api + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`, 'Stripe-Version': '2024-06-20',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? form(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, 'stripe_error', `Stripe refused the request: ${json.error?.message ?? res.status}`);
    return json;
  }

  planForPrice(priceId) {
    return Object.entries(this.prices).find(([, id]) => id && id === priceId)?.[0] ?? null;
  }

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

  async lookup({ sessionId, subscriptionId }) {
    let sub;
    if (sessionId) {
      if (!/^cs_[\w]+$/.test(sessionId)) return null;
      const s = await this.call('GET', `/v1/checkout/sessions/${sessionId}?expand[]=subscription`);
      sub = typeof s.subscription === 'object' ? s.subscription : s.subscription ? await this.call('GET', `/v1/subscriptions/${s.subscription}`) : null;
      if (!sub) return null;
      return this.fromSubscription(sub, s.client_reference_id);
    }
    if (subscriptionId) return this.fromSubscription(await this.call('GET', `/v1/subscriptions/${subscriptionId}`));
    return null;
  }

  fromSubscription(sub, fallbackOwner) {
    return {
      owner: sub.metadata?.owner ?? fallbackOwner ?? null,
      status: STATUS[sub.status] ?? 'pending',
      plan: this.planForPrice(sub.items?.data?.[0]?.price?.id) ?? sub.metadata?.plan ?? null,
      subscriptionId: sub.id, customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
      currentPeriodEnd: sub.current_period_end ? sub.current_period_end * 1000 : null,
    };
  }

  async cancel(sub) {
    if (sub.subscriptionId) await this.call('DELETE', `/v1/subscriptions/${sub.subscriptionId}`);
  }

  async portal(customerId, returnUrl) {
    const s = await this.call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    return s.url;
  }

  /** Verify and translate a webhook into { id, type, owner, status, plan, ... } (or null to ignore). */
  async verifyWebhook(rawBody, headers) {
    if (!this.webhookSecret) throw new HttpError(503, 'webhook_unconfigured', 'STRIPE_WEBHOOK_SECRET is not set.');
    if (!verifyStripeSignature(rawBody, headers['stripe-signature'], this.webhookSecret, Math.floor(this.clock() / 1000))) {
      throw new HttpError(400, 'bad_signature', 'Stripe signature check failed.');
    }
    const ev = JSON.parse(rawBody.toString('utf8'));
    const o = ev.data?.object ?? {};
    switch (ev.type) {
      case 'checkout.session.completed':
        return { id: ev.id, type: ev.type, owner: o.client_reference_id ?? o.metadata?.owner, plan: o.metadata?.plan, status: 'active', subscriptionId: o.subscription, customerId: o.customer };
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return { id: ev.id, type: ev.type, ...this.fromSubscription(o), ...(ev.type.endsWith('deleted') ? { status: 'canceled' } : {}) };
      case 'invoice.payment_failed':
        return { id: ev.id, type: ev.type, owner: o.subscription_details?.metadata?.owner ?? o.lines?.data?.[0]?.metadata?.owner, status: 'past_due' };
      default:
        return { id: ev.id, type: ev.type, owner: null };
    }
  }
}
