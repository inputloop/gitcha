// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// PayPal, over its REST API with no SDK (no extra PayPal library). It covers
// subscriptions (using Billing Plans made in the PayPal dashboard),
// cancelling, and checking webhooks with PayPal's own
// verify-webhook-signature call. BillingService (billing.js) uses it.
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { PROVIDER_TIMEOUT_MS, providerError, providerFetch } from './provider-call.js';

// PayPal's subscription states and event types, turned into Gitcha's own states.
// An UPDATED event maps to null: its new state is read from the subscription in the event.
const STATUS = { ACTIVE: 'active', APPROVAL_PENDING: 'pending', APPROVED: 'pending', SUSPENDED: 'past_due', CANCELLED: 'canceled', EXPIRED: 'canceled' };
const EVENT_STATUS = {
  'BILLING.SUBSCRIPTION.ACTIVATED': 'active', 'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'active', 'BILLING.SUBSCRIPTION.UPDATED': null,
  'BILLING.SUBSCRIPTION.SUSPENDED': 'past_due', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'past_due',
  'BILLING.SUBSCRIPTION.CANCELLED': 'canceled', 'BILLING.SUBSCRIPTION.EXPIRED': 'canceled',
};

/** The PayPal API host tells us if this is the live service or the sandbox (PayPal's test service). */
export function paypalMode(api) {
  try {
    const h = new URL(api).hostname;
    if (h === 'api-m.paypal.com' || h === 'api.paypal.com') return 'live';
    if (h.includes('sandbox')) return 'test';
  } catch { /* not a URL: unknown */ }
  return 'unknown';
}

/** Talks to PayPal for BillingService. */
export class PayPalProvider {
  constructor({ clientId, clientSecret, webhookId, api, plans, fetchImpl, clock, brand, log, timeoutMs = PROVIDER_TIMEOUT_MS }) {
    Object.assign(this, { clientId, clientSecret, webhookId, api, plans, fetchImpl, clock, brand, log, timeoutMs });
    this.token = null;
    this.tokenFlight = null; // one token fetch at a time, shared by whoever asks meanwhile
    this.verifiedUntil = new Map(); // deliveries PayPal has confirmed, so a repeat costs no call
    this.inFlight = new Map(); // verify calls still running, so the same delivery is asked about once at a time
    this.mode = paypalMode(api);
  }

  /** True when at least one plan has a PayPal Billing Plan id. */
  get canSell() { return Object.values(this.plans).some(Boolean); }

  /** An OAuth access token for the API calls. It is reused until a minute before it runs out. */
  async accessToken() {
    if (this.token && this.token.expiresAt > this.clock() + 60_000) return this.token.value;
    this.tokenFlight ??= this.fetchToken().finally(() => { this.tokenFlight = null; });
    return this.tokenFlight;
  }

  /** Asks PayPal for a new token with the client id and secret. */
  async fetchToken() {
    const res = await providerFetch({ fetchImpl: this.fetchImpl, name: 'PayPal', code: 'paypal_error', log: this.log, timeoutMs: this.timeoutMs, what: 'POST /v1/oauth2/token' }, `${this.api}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw providerError('PayPal', 'paypal_error', this.log, `no access token (status ${res.status}); check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET`, res.status);
    this.token = { value: j.access_token, expiresAt: this.clock() + (j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  /**
   * Makes one API call. `requestId` is sent as PayPal-Request-Id, so PayPal treats a repeat
   * of the same request as one (idempotent: safe to send twice).
   */
  async call(method, path, body, requestId) {
    const token = await this.accessToken();
    const res = await providerFetch({ fetchImpl: this.fetchImpl, name: 'PayPal', code: 'paypal_error', log: this.log, timeoutMs: this.timeoutMs, what: `${method} ${path}` }, this.api + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw providerError('PayPal', 'paypal_error', this.log, `${method} ${path} answered ${res.status}: ${j.message ?? j.name ?? ''}`, res.status);
    return j;
  }

  /** Which Gitcha plan a PayPal Billing Plan id belongs to, or null. */
  planForId(planId) {
    return Object.entries(this.plans).find(([, id]) => id && id === planId)?.[0] ?? null;
  }

  /**
   * Starts a subscription and returns the PayPal page where the buyer approves it. The owner
   * goes in `custom_id`. The request id stays the same for a minute, so a repeat in that minute makes no second one.
   */
  async createCheckout({ owner, plan, successUrl, cancelUrl }) {
    const planId = this.plans[plan];
    if (!planId) throw new HttpError(400, 'provider_unavailable', `No PayPal plan is configured for the ${plan} plan.`);
    const s = await this.call('POST', '/v1/billing/subscriptions', {
      plan_id: planId, custom_id: owner,
      application_context: { brand_name: this.brand, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: successUrl, cancel_url: cancelUrl },
    }, `sub-${owner}-${plan}-${Math.floor(this.clock() / 60_000)}`);
    const approve = (s.links ?? []).find((l) => l.rel === 'approve')?.href;
    if (!approve) throw new HttpError(502, 'paypal_error', 'PayPal returned no approval link.');
    return { url: approve, ids: { subscriptionId: s.id } };
  }

  /** Turns a PayPal subscription into Gitcha's shape: owner, status, plan, id and period end. */
  fromSubscription(s) {
    return {
      owner: s.custom_id ?? null, status: STATUS[s.status] ?? 'pending', plan: this.planForId(s.plan_id),
      subscriptionId: s.id, currentPeriodEnd: s.billing_info?.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : null,
    };
  }

  /** Asks PayPal about one subscription. Only ids in PayPal's "I-..." form are looked up. */
  async lookup({ subscriptionId }) {
    if (!subscriptionId || !/^I-[\w]+$/.test(subscriptionId)) return null;
    return this.fromSubscription(await this.call('GET', `/v1/billing/subscriptions/${subscriptionId}`));
  }

  /** PayPal has no "cancel at period end": it cancels at once. Gitcha itself keeps the paid plan to the end of the period. */
  async cancel(sub) {
    if (!sub.subscriptionId) return;
    try { await this.call('POST', `/v1/billing/subscriptions/${sub.subscriptionId}/cancel`, { reason: 'Cancelled by the account owner in Gitcha.' }); } catch (err) { if (err.providerStatus !== 404) throw err; } // a 404 means it is already gone, which is as good as cancelled
  }

  /**
   * PayPal's answer about one delivery (its ids, signature and exact bytes). The same delivery is
   * asked about once at a time. A yes is remembered for ten minutes, for at most 1,000 deliveries.
   */
  async deliveryVerified(key, ask) {
    const now = this.clock();
    if ((this.verifiedUntil.get(key) ?? 0) > now) return true;
    let flight = this.inFlight.get(key);
    if (!flight) {
      flight = ask().then((ok) => {
        if (ok) {
          if (this.verifiedUntil.size >= 1000) for (const [k, until] of this.verifiedUntil) if (until <= now) this.verifiedUntil.delete(k);
          if (this.verifiedUntil.size >= 1000) this.verifiedUntil.delete(this.verifiedUntil.keys().next().value);
          this.verifiedUntil.set(key, now + 10 * 60_000);
        }
        return ok;
      }).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, flight);
    }
    return flight;
  }

  /** Checks a webhook with PayPal and turns it into { id, type, owner, status, plan, subscriptionId, at }. */
  async verifyWebhook(rawBody, headers) {
    if (!this.webhookId) throw new HttpError(503, 'webhook_unconfigured', 'PAYPAL_WEBHOOK_ID is not set.');
    // Every real delivery carries all five headers. Without them PayPal is not asked (a verify call uses up the merchant's API allowance).
    const sig = {
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
    };
    if (Object.values(sig).some((v) => typeof v !== 'string' || !v)) throw new HttpError(400, 'bad_signature', 'PayPal signature check failed.');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'bad_body', 'Not JSON.'); }
    const ok = await this.deliveryVerified(`${sig.transmission_id}|${sig.transmission_sig}|${crypto.createHash('sha256').update(rawBody).digest('hex')}`,
      async () => (await this.call('POST', '/v1/notifications/verify-webhook-signature', { ...sig, webhook_id: this.webhookId, webhook_event: event })).verification_status === 'SUCCESS');
    if (!ok) throw new HttpError(400, 'bad_signature', 'PayPal signature check failed.');
    // An event type we do not handle comes back with no owner, and billing ignores it.
    if (!Object.hasOwn(EVENT_STATUS, event.event_type)) return { id: event.id, type: event.event_type, owner: null };
    const r = event.resource ?? {};
    const status = EVENT_STATUS[event.event_type] ?? STATUS[r.status] ?? null;
    const at = Date.parse(event.create_time); // PayPal's own time for the event
    return { id: event.id, type: event.event_type, owner: r.custom_id ?? null, status, plan: this.planForId(r.plan_id), subscriptionId: r.id, ...(Number.isFinite(at) ? { at } : {}) };
  }
}
