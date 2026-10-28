// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Plans, usage metering and quotas, with Stripe and PayPal as payment
// providers. A billing account belongs to a user or a team (team owners
// manage it). Payment happens on the provider's hosted pages, so card data
// never touches Gitcha. Provider events arrive by signed webhook; a return
// from checkout is also confirmed server-side with the provider, so nothing
// the browser says is trusted.
import fs from 'node:fs';
import { HttpError } from '../errors.js';
import { StripeProvider } from './stripe.js';
import { PayPalProvider } from './paypal.js';

export const METRICS = {
  fn_invocations: 'function invocations',
  build_minutes: 'build minutes',
  sites: 'sites',
};

// Defaults; an operator replaces them with GITCHA_PLANS_FILE (same shape).
export const DEFAULT_PLANS = {
  free: { name: 'Free', price: null, limits: { fn_invocations: 10_000, build_minutes: 300, sites: 3 }, paid: false },
  pro: { name: 'Pro', price: '5 per month', limits: { fn_invocations: 1_000_000, build_minutes: 3000, sites: 50 }, paid: true },
  team: { name: 'Team', price: '20 per month', limits: { fn_invocations: 5_000_000, build_minutes: 10_000, sites: 200 }, paid: true },
};

const month = (t) => new Date(t).toISOString().slice(0, 7);
const GRACE_MS = 7 * 86_400_000; // a failed payment keeps the paid limits this long

export class BillingService {
  constructor({ store, config, teams, clock = Date.now, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { store, config, teams, clock });
    store.data.billing ??= { accounts: {}, usage: {}, events: {} };
    this.plans = config.billing.plansFile ? JSON.parse(fs.readFileSync(config.billing.plansFile, 'utf8')) : DEFAULT_PLANS;
    if (!this.plans.free) throw new Error('The plans file must define a "free" plan.');
    const b = config.billing;
    this.providers = {};
    if (b.stripe.secretKey) this.providers.stripe = new StripeProvider({ ...b.stripe, prices: b.priceIds.stripe, fetchImpl, clock });
    if (b.paypal.clientId && b.paypal.clientSecret) this.providers.paypal = new PayPalProvider({ ...b.paypal, plans: b.priceIds.paypal, fetchImpl, clock, brand: config.issuer });
  }

  get enabled() { return this.config.billing.enabled; }
  get data() { return this.store.data.billing; }

  /** For the ring manifest: what this instance sells. */
  paidFeatures() {
    if (!this.enabled) return [];
    return Object.entries(this.plans).filter(([, p]) => p.paid).map(([id, p]) => `${p.name} plan (${p.price ?? 'priced on request'})`);
  }

  // ---- accounts and permissions ------------------------------------------------------
  parseOwner(user, owner) {
    if (!owner || owner === `user:${user.username}`) return { key: `user:${user.username}`, type: 'user', name: user.username };
    const m = /^team:([a-z0-9][a-z0-9_-]{1,31})$/.exec(owner);
    if (!m) throw new HttpError(400, 'bad_owner', 'Billing owner must be "user:NAME" or "team:NAME".');
    return { key: owner, type: 'team', name: m[1] };
  }

  /** Users see and pay for themselves; team owners for their team; team members can look. */
  account(user, owner, { manage = false } = {}) {
    const o = this.parseOwner(user, owner);
    if (o.type === 'team') {
      const t = this.teams.get(o.name);
      this.teams.require(t, user, manage ? 'owner' : 'member');
    }
    return o;
  }

  subscription(key) {
    const a = this.data.accounts[key];
    if (!a?.subscription) return null;
    return a.subscription;
  }

  /** The plan whose limits apply now. Past-due accounts keep paid limits for a grace period, counted from when the spell began. */
  planFor(key) {
    const s = this.subscription(key);
    if (s && this.plans[s.plan] && (s.status === 'active' || (s.status === 'past_due' && this.clock() - (s.pastDueSince ?? s.updatedAt) < GRACE_MS))) return s.plan;
    return 'free';
  }

  usage(key, t = this.clock()) {
    return { ...(this.data.usage[key]?.[month(t)] ?? {}) };
  }

  record(key, metric, n = 1) {
    if (!METRICS[metric]) return;
    const m = month(this.clock());
    const u = (this.data.usage[key] ??= {});
    (u[m] ??= {})[metric] = (u[m][metric] ?? 0) + n;
    // Usage is flushed with the next write; a crash loses at most a few seconds of counts.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.store.flush(); }, 2000);
      this.flushTimer.unref?.();
    }
  }

  /** Throw 402 when the owner is at their plan's limit. `current` overrides the monthly count (e.g. number of sites). */
  check(key, metric, current) {
    if (!this.enabled) return;
    const plan = this.plans[this.planFor(key)];
    const limit = plan.limits?.[metric];
    if (limit === undefined || limit === null) return;
    const used = current ?? this.usage(key)[metric] ?? 0;
    if (used >= limit) {
      throw new HttpError(402, 'quota_exceeded', `${key} has used ${used} of ${limit} ${METRICS[metric]} on the ${plan.name} plan${current === undefined ? ' this month' : ''}. Upgrade at ${this.config.publicUrl}/billing.`, { metric, limit, used, plan: this.planFor(key) });
    }
  }

  view(user, owner) {
    const o = this.account(user, owner);
    const plan = this.planFor(o.key);
    const sub = this.subscription(o.key);
    return {
      owner: o.key, enabled: this.enabled, plan, planName: this.plans[plan].name, limits: this.plans[plan].limits, usage: this.usage(o.key),
      subscription: sub ? { provider: sub.provider, plan: sub.plan, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd ?? null } : null,
      pendingCheckout: this.data.accounts[o.key]?.checkout ? { provider: this.data.accounts[o.key].checkout.provider, plan: this.data.accounts[o.key].checkout.plan } : null,
      plans: Object.entries(this.plans).map(([id, p]) => ({ id, name: p.name, price: p.price, limits: p.limits, paid: Boolean(p.paid) })),
      providers: Object.keys(this.providers).filter((k) => this.providers[k].canSell),
    };
  }

  /** Change the account's subscription record; `replace` starts a fresh one instead of merging over the old. */
  setSubscription(key, patch, event, { replace = false, clearCheckout = false } = {}) {
    this.store.tx((d) => {
      const a = (d.billing.accounts[key] ??= {});
      const before = replace ? {} : a.subscription ?? {};
      a.subscription = { ...before, ...patch, updatedAt: this.clock() };
      // The grace is counted from the first moment of a past-due spell; a write that changes nothing cannot move it.
      if (a.subscription.status !== 'past_due') delete a.subscription.pastDueSince;
      else a.subscription.pastDueSince = before.status === 'past_due' ? before.pastDueSince ?? before.updatedAt : this.clock();
      if (clearCheckout) delete a.checkout;
      a.history = [...(a.history ?? []).slice(-49), { at: this.clock(), event, status: a.subscription.status, plan: a.subscription.plan, provider: a.subscription.provider }];
      this.store.audit({ event: `billing.${event}`, owner: key, plan: a.subscription.plan, status: a.subscription.status, provider: a.subscription.provider });
    });
  }

  /** A checkout for a new plan on an account that already pays waits in its own slot; the paid record is not touched. */
  setCheckout(key, slot, event) {
    this.store.tx((d) => {
      const a = (d.billing.accounts[key] ??= {});
      a.checkout = slot;
      a.history = [...(a.history ?? []).slice(-49), { at: this.clock(), event, status: 'pending', plan: slot?.plan, provider: slot?.provider }];
      this.store.audit({ event: `billing.${event}`, owner: key, plan: slot?.plan, status: 'pending', provider: slot?.provider });
    });
  }

  ignored(provider, ev, key, reason) {
    this.store.tx(() => this.store.audit({ event: 'billing.event_ignored', owner: key ?? ev.owner, provider, eventType: ev.type, eventId: ev.id, reason }));
    return { ignored: true, reason };
  }

  // ---- checkout ---------------------------------------------------------------------------
  provider(name) {
    const p = this.providers[name];
    if (!this.enabled || !p) throw new HttpError(400, 'provider_unavailable', `Payments with ${name} are not set up on this instance.`);
    return p;
  }

  async checkout(user, { owner, plan, provider }, ip) {
    const o = this.account(user, owner, { manage: true });
    if (!this.plans[plan]?.paid) throw new HttpError(400, 'bad_plan', `"${plan}" is not a paid plan.`);
    const current = this.subscription(o.key);
    const paying = Boolean(current && ['active', 'past_due'].includes(current.status));
    if (paying && current.plan === plan) {
      throw new HttpError(409, 'already_subscribed', `${o.key} is already on the ${this.plans[plan].name} plan.`);
    }
    const p = this.provider(provider);
    const base = this.config.publicUrl;
    const out = await p.createCheckout({
      owner: o.key, plan,
      successUrl: `${base}/billing/return?provider=${provider}&owner=${encodeURIComponent(o.key)}`,
      cancelUrl: `${base}/billing?owner=${encodeURIComponent(o.key)}&msg=cancelled`,
    });
    // On an account that pays, the new plan waits in its own slot and the paid subscription stays until the new one is confirmed.
    if (paying) this.setCheckout(o.key, { provider, plan, ...out.ids, startedAt: this.clock() }, 'checkout_started');
    else this.setSubscription(o.key, { provider, plan, status: 'pending', ...out.ids }, 'checkout_started', { replace: true, clearCheckout: true });
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'billing.checkout', ip, owner: o.key, plan, provider }));
    return { url: out.url };
  }

  /** The browser came back from the provider: ask the provider what really happened. */
  async confirmReturn(user, { owner, provider, sessionId, subscriptionId }) {
    const o = this.account(user, owner);
    const p = this.provider(provider);
    const sub = this.subscription(o.key);
    const slot = this.data.accounts[o.key]?.checkout;
    const found = await p.lookup({ sessionId, subscriptionId: subscriptionId ?? sub?.subscriptionId ?? slot?.subscriptionId });
    if (!found || found.owner !== o.key) throw new HttpError(400, 'not_confirmed', 'The payment provider has no matching subscription for this account yet.');
    // The subscription must be one this account is waiting on or already holds: its owner field alone proves nothing.
    const target = this.targetOf(o.key, provider, { subscriptionId: found.subscriptionId, checkoutSessionId: sessionId });
    if (!target) throw new HttpError(400, 'not_confirmed', 'That subscription is not the one this account is waiting on.');
    await this.adopt(o.key, target, { ...found, provider }, 'confirmed', { authoritative: true });
    return this.view(user, o.key);
  }

  async cancel(user, { owner }, ip) {
    const o = this.account(user, owner, { manage: true });
    const sub = this.subscription(o.key);
    if (!sub || !['active', 'past_due', 'pending'].includes(sub.status)) throw new HttpError(409, 'no_subscription', 'There is no subscription to cancel.');
    await this.provider(sub.provider).cancel(sub);
    this.setSubscription(o.key, { status: 'canceled' }, 'canceled_by_user');
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'billing.cancel', ip, owner: o.key }));
    return this.view(user, o.key);
  }

  /** Stripe's customer portal (update card, invoices). */
  async portal(user, { owner }) {
    const o = this.account(user, owner, { manage: true });
    const sub = this.subscription(o.key);
    if (sub?.provider !== 'stripe' || !sub.customerId) throw new HttpError(409, 'no_portal', 'The billing portal is available for Stripe subscriptions.');
    return { url: await this.provider('stripe').portal(sub.customerId, `${this.config.publicUrl}/billing?owner=${encodeURIComponent(o.key)}`) };
  }

  // ---- webhooks -------------------------------------------------------------------------------
  /** Which of this account's records (the paid one or the waiting checkout) does the provider's subscription or session belong to? */
  targetOf(key, provider, { subscriptionId, checkoutSessionId }) {
    const hit = (r) => r?.provider === provider && ((subscriptionId && r.subscriptionId === subscriptionId) || (checkoutSessionId && r.checkoutSessionId === checkoutSessionId));
    if (hit(this.subscription(key))) return 'current';
    if (hit(this.data.accounts[key]?.checkout)) return 'checkout';
    return null;
  }

  /** The account an event is about is found by the ids we recorded, never by the owner the event claims. */
  accountFor(provider, ids) {
    for (const key of Object.keys(this.data.accounts)) {
      const target = this.targetOf(key, provider, ids);
      if (target) return { key, target };
    }
    return null;
  }

  /** Take what the provider says about a subscription into the account. A replacement plan cancels the old subscription first. */
  async adopt(key, target, next, event, { authoritative = false } = {}) {
    const patch = {};
    for (const k of ['status', 'plan', 'subscriptionId', 'customerId', 'currentPeriodEnd']) if (next[k] !== undefined && (next[k] !== null || (authoritative && k === 'currentPeriodEnd'))) patch[k] = next[k];
    if (target === 'current') {
      this.setSubscription(key, { provider: next.provider, ...patch }, event);
      return 'applied';
    }
    const slot = this.data.accounts[key].checkout;
    if (next.status === 'canceled') { // the buyer never paid, or the provider dropped the new subscription
      this.store.tx((d) => { delete d.billing.accounts[key].checkout; });
      return 'dropped';
    }
    if (next.status !== 'active') return 'waiting';
    const old = this.subscription(key);
    if (old && ['active', 'past_due'].includes(old.status) && old.subscriptionId !== next.subscriptionId) await this.provider(old.provider).cancel(old);
    this.setSubscription(key, { provider: next.provider, ...patch, plan: patch.plan ?? slot.plan, checkoutSessionId: slot.checkoutSessionId }, event, { replace: true, clearCheckout: true });
    return 'applied';
  }

  /** Apply a verified provider event. Each event id is applied once. */
  async applyEvent(provider, ev) {
    if (!ev) return { ignored: true };
    if (this.data.events[`${provider}:${ev.id}`]) return { duplicate: true };
    this.store.tx((d) => {
      d.billing.events[`${provider}:${ev.id}`] = this.clock();
      const ids = Object.keys(d.billing.events);
      if (ids.length > 5000) for (const k of ids.slice(0, ids.length - 5000)) delete d.billing.events[k];
    });
    const named = typeof ev.owner === 'string' && /^(user|team):/.test(ev.owner);
    const hit = this.accountFor(provider, ev);
    if (!hit) return named ? this.ignored(provider, ev, ev.owner, 'unknown_subscription') : { ignored: true };
    if (named && ev.owner !== hit.key) return this.ignored(provider, ev, hit.key, 'owner_mismatch');
    const outcome = await this.adopt(hit.key, hit.target, { ...ev, provider }, `${provider}:${ev.type}`);
    if (outcome !== 'applied') return { ignored: true, reason: outcome };
    return { applied: true, owner: hit.key, status: ev.status };
  }

  async webhook(provider, rawBody, headers) {
    const p = this.providers[provider];
    if (!this.enabled || !p) throw new HttpError(404, 'not_found', 'Not found.');
    const ev = await p.verifyWebhook(rawBody, headers); // throws 400 on a bad signature
    return this.applyEvent(provider, ev);
  }
}
