// PayPal, over its REST API with no SDK: subscriptions (Billing Plans created
// in the PayPal dashboard), cancellation, and webhook verification through
// PayPal's own verify-webhook-signature call.
import { HttpError } from '../errors.js';

const STATUS = { ACTIVE: 'active', APPROVAL_PENDING: 'pending', APPROVED: 'pending', SUSPENDED: 'past_due', CANCELLED: 'canceled', EXPIRED: 'canceled' };
const EVENT_STATUS = {
  'BILLING.SUBSCRIPTION.ACTIVATED': 'active', 'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'active', 'BILLING.SUBSCRIPTION.UPDATED': null,
  'BILLING.SUBSCRIPTION.SUSPENDED': 'past_due', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'past_due',
  'BILLING.SUBSCRIPTION.CANCELLED': 'canceled', 'BILLING.SUBSCRIPTION.EXPIRED': 'canceled',
};

export class PayPalProvider {
  constructor({ clientId, clientSecret, webhookId, api, plans, fetchImpl, clock, brand }) {
    Object.assign(this, { clientId, clientSecret, webhookId, api, plans, fetchImpl, clock, brand });
    this.token = null;
  }

  get canSell() { return Object.values(this.plans).some(Boolean); }

  async accessToken() {
    if (this.token && this.token.expiresAt > this.clock() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.api}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new HttpError(502, 'paypal_error', 'PayPal did not issue an access token (check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
    this.token = { value: j.access_token, expiresAt: this.clock() + (j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  async call(method, path, body, requestId) {
    const res = await this.fetchImpl(this.api + path, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, 'paypal_error', `PayPal refused the request: ${j.message ?? j.name ?? res.status}`);
    return j;
  }

  planForId(planId) {
    return Object.entries(this.plans).find(([, id]) => id && id === planId)?.[0] ?? null;
  }

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

  fromSubscription(s) {
    return {
      owner: s.custom_id ?? null, status: STATUS[s.status] ?? 'pending', plan: this.planForId(s.plan_id),
      subscriptionId: s.id, currentPeriodEnd: s.billing_info?.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : null,
    };
  }

  async lookup({ subscriptionId }) {
    if (!subscriptionId || !/^I-[\w]+$/.test(subscriptionId)) return null;
    return this.fromSubscription(await this.call('GET', `/v1/billing/subscriptions/${subscriptionId}`));
  }

  async cancel(sub) {
    if (sub.subscriptionId) await this.call('POST', `/v1/billing/subscriptions/${sub.subscriptionId}/cancel`, { reason: 'Cancelled by the account owner in Gitcha.' });
  }

  async verifyWebhook(rawBody, headers) {
    if (!this.webhookId) throw new HttpError(503, 'webhook_unconfigured', 'PAYPAL_WEBHOOK_ID is not set.');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'bad_body', 'Not JSON.'); }
    const v = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.webhookId, webhook_event: event,
    });
    if (v.verification_status !== 'SUCCESS') throw new HttpError(400, 'bad_signature', 'PayPal signature check failed.');
    if (!(event.event_type in EVENT_STATUS)) return { id: event.id, type: event.event_type, owner: null };
    const r = event.resource ?? {};
    const status = EVENT_STATUS[event.event_type] ?? STATUS[r.status] ?? null;
    return { id: event.id, type: event.event_type, owner: r.custom_id ?? null, status, plan: this.planForId(r.plan_id), subscriptionId: r.id };
  }
}
