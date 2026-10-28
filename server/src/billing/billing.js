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
const GONE = '(gone)'; // the binding of an account whose owner no longer exists

// Services holding usage that is not on disk yet; a stop signal ends in process.exit, which writes them (flushOnExit).
const unflushed = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const b of unflushed) { try { b.flushNow(); } catch { /* the process is ending: nothing more can be done */ } } });
}

export class BillingService {
  constructor({ store, config, teams, clock = Date.now, fetchImpl = globalThis.fetch, log = { info: (m) => console.log(m), error: (m) => console.error(m) } }) {
    Object.assign(this, { store, config, teams, clock, log, flushMs: 2000, flushFailures: 0 });
    store.data.billing ??= { accounts: {}, usage: {}, events: {} };
    this.plans = config.billing.plansFile ? JSON.parse(fs.readFileSync(config.billing.plansFile, 'utf8')) : DEFAULT_PLANS;
    if (!this.plans.free) throw new Error('The plans file must define a "free" plan.');
    const b = config.billing;
    this.providerLog = { error: (m) => this.log.error(m) }; // follows this.log, which a test may swap
    this.providers = {};
    if (b.stripe.secretKey) this.providers.stripe = new StripeProvider({ ...b.stripe, prices: b.priceIds.stripe, fetchImpl, clock, log: this.providerLog });
    if (b.paypal.clientId && b.paypal.clientSecret) this.providers.paypal = new PayPalProvider({ ...b.paypal, plans: b.priceIds.paypal, fetchImpl, clock, brand: config.issuer, log: this.providerLog });
    if (this.enabled) this.startUp();
  }

  /** Say which mode each provider's keys are in, bind accounts that predate binding, retire those whose owner is gone, and keep checking while the server runs. */
  startUp() {
    for (const [name, p] of Object.entries(this.providers)) {
      this.log.info(p.mode === 'unknown' ? `billing: ${name} keys are neither live nor test keys; records of the two modes cannot be told apart` : `billing: ${name} is in ${p.mode} mode`);
    }
    let changed = 0;
    for (const [key, a] of Object.entries(this.data.accounts)) {
      if (a.ownerRef === undefined) { a.ownerRef = this.ownerRef(key) ?? GONE; changed++; }
      // A record from before modes existed is taken to be in the mode the keys are in now.
      if (a.subscription && a.subscription.mode === undefined && this.providers[a.subscription.provider]) { a.subscription.mode = this.providers[a.subscription.provider].mode; changed++; }
    }
    if (changed) {
      this.log.info(`billing: bound ${changed} billing record(s) to their owner or mode`);
      try { this.store.flush(); } catch (err) { this.log.error(`billing: could not save the bindings: ${err.message}`); }
    }
    const other = Object.keys(this.data.accounts).filter((k) => { const s = this.data.accounts[k].subscription; return s && !this.modeOk(s); }).length;
    if (other) this.log.info(`billing: ${other} subscription record(s) were written in the other mode and are not honoured`);
    const upkeep = () => this.reconcile().then(() => this.refresh()).catch((err) => this.log.error(`billing: ${err.message}`));
    upkeep();
    // A team deleted since the last look has its subscription cancelled, and a subscription past its paid period is asked about, within minutes.
    this.upkeepTimer = setInterval(upkeep, 5 * 60_000);
    this.upkeepTimer.unref?.();
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
    if (this.data.accounts[o.key] && !this.accountOf(o.key)) this.reconcile().catch((err) => this.log.error(`billing: ${err.message}`));
    return o;
  }

  // ---- who an account belongs to ----------------------------------------------------------
  /** What an account is bound to: the user's id, or the team as it was created (teams carry no id; creation time and creator tell a re-registered name apart). */
  ownerRef(key) {
    const [type, ...rest] = key.split(':');
    const name = rest.join(':');
    if (type === 'user') return this.store.userByName(name)?.id ?? null;
    const t = this.store.team(name);
    return t ? t.id ?? `${t.createdAt}:${t.createdBy}` : null;
  }

  /** The account, if it still belongs to the owner it was opened for (a team name reused by someone else gets nothing). */
  accountOf(key) {
    const a = this.data.accounts[key];
    if (!a) return null;
    if (a.ownerRef !== undefined && a.ownerRef !== this.ownerRef(key)) return null;
    return a;
  }

  /** The account for a write: a new one, or the existing one if it is this owner's (an old one of the same name is retired first). */
  ensureAccount(d, key) {
    let a = d.billing.accounts[key];
    if (a && a.ownerRef !== undefined && a.ownerRef !== this.ownerRef(key)) { this.retireInto(d, key, 'owner_changed'); a = undefined; }
    return (d.billing.accounts[key] ??= { ownerRef: this.ownerRef(key) });
  }

  /** Close an account: its record goes, its provider subscriptions are queued for cancellation, and the closing is logged. */
  retireInto(d, key, reason, who = {}) {
    const a = d.billing.accounts[key];
    if (!a) return;
    delete d.billing.accounts[key];
    const s = a.subscription;
    const live = [s && ['active', 'past_due', 'pending'].includes(s.status) ? s : null, a.checkout].filter((r) => r?.subscriptionId);
    d.billing.pendingCancels ??= [];
    for (const r of live) d.billing.pendingCancels.push({ key, provider: r.provider, subscriptionId: r.subscriptionId, at: this.clock() });
    d.billing.closed = [...(d.billing.closed ?? []).slice(-199), { key, at: this.clock(), reason, provider: s?.provider, plan: s?.plan, status: s?.status, subscriptionId: s?.subscriptionId, by: who.by }];
    this.store.audit({ userId: who.userId, event: 'billing.account_closed', owner: key, reason, provider: s?.provider, by: who.by });
  }

  /** For the team-deletion path: close the team's billing account and cancel its subscription at the provider. Never rejects. */
  async closeAccount(key, who = {}) {
    try {
      this.store.tx((d) => this.retireInto(d, key, who.reason ?? 'team_deleted', who));
    } catch (err) { this.log.error(`billing: could not close ${key}: ${err.message}`); }
    await this.drainCancels();
  }

  /** Retire every account whose owner is gone or was replaced, then cancel what they left at the providers. */
  async reconcile() {
    const stale = Object.keys(this.data.accounts).filter((k) => !this.accountOf(k));
    if (stale.length) {
      try { this.store.tx((d) => { for (const k of stale) this.retireInto(d, k, this.ownerRef(k) === null ? 'owner_gone' : 'owner_changed'); }); } catch (err) { this.log.error(`billing: could not retire ${stale.join(', ')}: ${err.message}`); return; }
    }
    await this.drainCancels();
  }

  /** Cancel, at the provider, the subscriptions of closed accounts. A cancel that fails stays queued for the next pass. */
  drainCancels() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const item of [...(this.data.pendingCancels ?? [])]) {
        const p = this.providers[item.provider];
        if (!p) continue;
        try { await p.cancel({ subscriptionId: item.subscriptionId }); } catch (err) {
          this.log.error(`billing: could not cancel ${item.provider} subscription ${item.subscriptionId} of closed account ${item.key}: ${err.message}`);
          continue;
        }
        try { this.store.tx((d) => { d.billing.pendingCancels = d.billing.pendingCancels.filter((x) => x !== item); }); } catch (err) { this.log.error(`billing: ${err.message}`); }
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  /** A record written with test keys is not a paid plan once the keys are live, and the reverse. */
  modeOk(s) {
    const pm = this.providers[s.provider]?.mode;
    return !s.mode || !pm || pm === 'unknown' || s.mode === 'unknown' || s.mode === pm;
  }

  /** Ask the provider about subscriptions whose paid period has run out: a renewal PayPal never announces, or an event that never came. */
  async refresh() {
    const now = this.clock();
    for (const key of Object.keys(this.data.accounts)) {
      const s = this.subscription(key);
      if (!s?.subscriptionId || !['active', 'past_due'].includes(s.status) || s.currentPeriodEnd == null || s.currentPeriodEnd >= now) continue;
      const p = this.providers[s.provider];
      if (!p) continue;
      try {
        const found = await p.lookup({ subscriptionId: s.subscriptionId });
        if (found?.owner === key && found.subscriptionId === s.subscriptionId) await this.adopt(key, 'current', { ...found, provider: s.provider }, 'refreshed', { authoritative: true });
      } catch (err) { this.log.error(`billing: could not refresh ${key}: ${err.message}`); }
    }
  }

  subscription(key) {
    const s = this.accountOf(key)?.subscription;
    return s && this.modeOk(s) ? s : null;
  }

  /**
   * How a subscription stands: 'paid', 'grace' (a failed payment, or a paid period that ran out with no word from the provider;
   * paid limits stay for seven days from when that began) or 'none'. A record with no period end never runs out by itself.
   */
  standing(s) {
    const now = this.clock();
    let since;
    if (s.status === 'past_due') since = s.pastDueSince ?? s.updatedAt;
    else if (s.status === 'active') {
      if (s.currentPeriodEnd == null || s.currentPeriodEnd >= now) return 'paid';
      since = s.currentPeriodEnd;
    } else return 'none';
    return now - since < GRACE_MS ? 'grace' : 'none';
  }

  /** The plan whose limits apply now. */
  planFor(key) {
    const s = this.subscription(key);
    if (s && Object.hasOwn(this.plans, s.plan) && this.standing(s) !== 'none') return s.plan;
    return 'free';
  }

  usage(key, t = this.clock()) {
    return { ...(this.data.usage[key]?.[month(t)] ?? {}) };
  }

  /** Add `n` (may be negative, never below zero) to this month's count, or to the month `at` falls in. */
  record(key, metric, n = 1, at = this.clock()) {
    if (!METRICS[metric]) return;
    const m = month(at);
    const u = (this.data.usage[key] ??= {});
    (u[m] ??= {})[metric] = Math.max(0, (u[m][metric] ?? 0) + n);
    // Usage is flushed soon after, not with every count; a stop signal writes it too (see flushOnExit).
    unflushed.add(this);
    hookExit();
    this.scheduleFlush();
  }

  scheduleFlush(delay = this.flushMs) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try { this.flushNow(); this.flushFailures = 0; } catch (err) {
        // A disk that is unwell must not end the process: say so, and try again a little later.
        this.log.error(`billing: could not save usage (${err.message}); trying again`);
        this.scheduleFlush(Math.min(this.flushMs * 2 ** Math.min(++this.flushFailures, 8), 60_000));
      }
    }, delay);
    this.flushTimer.unref?.();
  }

  /** Write the store now (usage counts included). */
  flushNow() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.store.flush();
    unflushed.delete(this);
  }

  /**
   * Throw 402 when taking `n` more would pass the owner's plan limit. `current` overrides the monthly count (e.g. number of sites).
   */
  check(key, metric, current, n = 1) {
    if (!this.enabled) return;
    const plan = this.plans[this.planFor(key)];
    const limit = plan.limits?.[metric];
    if (limit === undefined || limit === null) return;
    const used = current ?? this.usage(key)[metric] ?? 0;
    if (used + n > limit) {
      throw new HttpError(402, 'quota_exceeded', `${key} has used ${used} of ${limit} ${METRICS[metric]} on the ${plan.name} plan${current === undefined ? ' this month' : ''}. Upgrade at ${this.config.publicUrl}/billing.`, { metric, limit, used, plan: this.planFor(key) });
    }
  }

  /**
   * Take `n` of a metered resource before the work starts: refuse (402) if that passes the limit, and count it now, so work
   * admitted together counts together. Returns plain data to keep with the job; give it to settle() when the work ends.
   */
  reserve(key, metric, n = 1) {
    this.check(key, metric, undefined, n);
    this.record(key, metric, n);
    return { key, metric, n, at: this.clock() };
  }

  /** The work ended having used `actual` (0 if it never ran): correct the count made at reserve(). Once per reservation; a second call does nothing. */
  settle(reservation, actual) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    const diff = Math.max(0, actual) - reservation.n;
    if (diff) this.record(reservation.key, reservation.metric, diff, reservation.at);
  }

  /** The work never ran (a platform failure, a job that never started). */
  release(reservation) { this.settle(reservation, 0); }

  view(user, owner) {
    const o = this.account(user, owner);
    const plan = this.planFor(o.key);
    const sub = this.subscription(o.key);
    return {
      owner: o.key, enabled: this.enabled, plan, planName: this.plans[plan].name, limits: this.plans[plan].limits, usage: this.usage(o.key),
      subscription: sub ? { provider: sub.provider, plan: sub.plan, status: sub.status === 'active' && this.standing(sub) !== 'paid' ? 'past_due' : sub.status, currentPeriodEnd: sub.currentPeriodEnd ?? null } : null,
      pendingCheckout: this.accountOf(o.key)?.checkout ? { provider: this.accountOf(o.key).checkout.provider, plan: this.accountOf(o.key).checkout.plan } : null,
      plans: Object.entries(this.plans).map(([id, p]) => ({ id, name: p.name, price: p.price, limits: p.limits, paid: Boolean(p.paid) })),
      providers: Object.keys(this.providers).filter((k) => this.providers[k].canSell),
    };
  }

  // ---- writes ---------------------------------------------------------------------------------
  /**
   * Run `change(d)` and, if `seen` is given, mark that event seen in the same write. If the write fails, memory is put back
   * (the account, the close queues, the audit rows and the marker) so nothing half-done is kept and the provider's retry starts clean.
   */
  atomically(key, change, seen = null) {
    const bd = this.data;
    const was = { account: key ? structuredClone(bd.accounts[key]) : undefined, closed: structuredClone(bd.closed), pending: structuredClone(bd.pendingCancels), audit: this.store.data.audit.length, marker: seen ? bd.events[seen] : undefined };
    const put = (obj, k, v) => { if (v === undefined) delete obj[k]; else obj[k] = v; };
    try {
      return this.store.tx((d) => {
        const out = change(d);
        if (seen) this.markSeen(d, seen);
        return out;
      });
    } catch (err) {
      if (key) put(bd.accounts, key, was.account);
      put(bd, 'closed', was.closed);
      put(bd, 'pendingCancels', was.pending);
      if (seen) put(bd.events, seen, was.marker);
      this.store.data.audit.length = Math.min(this.store.data.audit.length, was.audit);
      throw err;
    }
  }

  markSeen(d, seen) {
    d.billing.events[seen] = this.clock();
    const ids = Object.keys(d.billing.events);
    if (ids.length > 5000) for (const k of ids.slice(0, ids.length - 5000)) delete d.billing.events[k];
  }

  /** Change the account's subscription record inside a write; `replace` starts a fresh one instead of merging over the old. */
  putSubscription(d, key, patch, event, { replace = false, clearCheckout = false } = {}) {
    const a = this.ensureAccount(d, key);
    const before = replace ? {} : a.subscription ?? {};
    a.subscription = { ...before, ...patch, updatedAt: this.clock() };
    // The grace is counted from the first moment of a past-due spell; a write that changes nothing cannot move it.
    if (a.subscription.status !== 'past_due') delete a.subscription.pastDueSince;
    else a.subscription.pastDueSince = before.status === 'past_due' ? before.pastDueSince ?? before.updatedAt : this.clock();
    if (clearCheckout) delete a.checkout;
    a.history = [...(a.history ?? []).slice(-49), { at: this.clock(), event, status: a.subscription.status, plan: a.subscription.plan, provider: a.subscription.provider }];
    this.store.audit({ event: `billing.${event}`, owner: key, plan: a.subscription.plan, status: a.subscription.status, provider: a.subscription.provider });
  }

  /** A checkout for a new plan on an account that already pays waits in its own slot (null empties it); the paid record is not touched. */
  putCheckout(d, key, slot, event) {
    const a = this.ensureAccount(d, key);
    if (slot) a.checkout = slot; else delete a.checkout;
    a.history = [...(a.history ?? []).slice(-49), { at: this.clock(), event, status: 'pending', plan: slot?.plan, provider: slot?.provider }];
    this.store.audit({ event: `billing.${event}`, owner: key, plan: slot?.plan, status: 'pending', provider: slot?.provider });
  }

  setSubscription(key, patch, event, opts) { this.atomically(key, (d) => this.putSubscription(d, key, patch, event, opts)); }
  setCheckout(key, slot, event) { this.atomically(key, (d) => this.putCheckout(d, key, slot, event)); }

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
    if (paying) this.setCheckout(o.key, { provider, plan, mode: p.mode, ...out.ids, startedAt: this.clock() }, 'checkout_started');
    else this.setSubscription(o.key, { provider, plan, mode: p.mode, status: 'pending', ...out.ids }, 'checkout_started', { replace: true, clearCheckout: true });
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'billing.checkout', ip, owner: o.key, plan, provider }));
    return { url: out.url };
  }

  /** The browser came back from the provider: ask the provider what really happened. */
  async confirmReturn(user, { owner, provider, sessionId, subscriptionId }) {
    const o = this.account(user, owner);
    const p = this.provider(provider);
    const sub = this.subscription(o.key);
    const slot = this.accountOf(o.key)?.checkout;
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
    if (hit(this.accountOf(key)?.checkout)) return 'checkout';
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

  /** Why an event for this account must not be applied, if it must not: it is older than one already applied, or the subscription has ended. */
  supersededBy(hit, ev) {
    if (hit.target !== 'current') return null;
    const s = this.subscription(hit.key);
    // Cancelled is final for a subscription (a new purchase is a new subscription), whatever order events arrive in.
    if (s.status === 'canceled' && s.subscriptionId === ev.subscriptionId && ev.status && ev.status !== 'canceled') return 'subscription_ended';
    // Events carry the provider's own time; one older than the last applied is a late delivery. Ids are no order (random), so the same second applies.
    if (ev.at != null && s.lastEventAt != null && ev.at < s.lastEventAt) return 'older_than_applied';
    return null;
  }

  /** Take what the provider says about a subscription into the account. A replacement plan cancels the old subscription first. `seen` marks the event in the same write. */
  async adopt(key, target, next, event, { authoritative = false, seen = null } = {}) {
    const patch = {};
    for (const k of ['status', 'plan', 'subscriptionId', 'customerId', 'currentPeriodEnd']) if (next[k] !== undefined && (next[k] !== null || (authoritative && k === 'currentPeriodEnd'))) patch[k] = next[k];
    const mark = (outcome) => { if (seen) this.atomically(null, () => {}, seen); return outcome; };
    if (target === 'current') {
      if (next.at != null) patch.lastEventAt = Math.max(next.at, this.subscription(key).lastEventAt ?? 0);
      return this.atomically(key, (d) => { this.putSubscription(d, key, { provider: next.provider, ...patch }, event); return 'applied'; }, seen);
    }
    const slot = this.accountOf(key).checkout;
    if (next.status === 'canceled') { // the buyer never paid, or the provider dropped the new subscription
      return this.atomically(key, (d) => { this.putCheckout(d, key, null, 'checkout_dropped'); return 'dropped'; }, seen);
    }
    if (next.status !== 'active') return mark('waiting');
    const old = this.subscription(key);
    if (old && ['active', 'past_due'].includes(old.status) && old.subscriptionId !== next.subscriptionId) await this.provider(old.provider).cancel(old);
    // The cancel took a while; if another delivery or a confirm got here first, there is nothing left to do.
    if ((seen && this.data.events[seen]) || this.accountOf(key)?.checkout !== slot) return 'duplicate';
    const fresh = { provider: next.provider, ...patch, plan: patch.plan ?? slot.plan, mode: slot.mode, checkoutSessionId: slot.checkoutSessionId, ...(next.at != null ? { lastEventAt: next.at } : {}) };
    return this.atomically(key, (d) => { this.putSubscription(d, key, fresh, event, { replace: true, clearCheckout: true }); return 'applied'; }, seen);
  }

  /** Record an event we will not apply: seen (so a retry is a duplicate), and an audit row when it names a Gitcha owner. */
  ignore(provider, ev, seen, key, reason, audit) {
    this.atomically(key ?? null, () => { if (audit) this.store.audit({ event: 'billing.event_ignored', owner: key, provider, eventType: ev.type, eventId: ev.id, reason }); }, seen);
    return { ignored: true, reason };
  }

  /** Apply a verified provider event. Each event id is applied once, and marked seen only together with its effect. */
  async applyEvent(provider, ev) {
    if (!ev) return { ignored: true };
    const seen = `${provider}:${ev.id}`;
    if (this.data.events[seen]) return { duplicate: true };
    const named = typeof ev.owner === 'string' && /^(user|team):/.test(ev.owner);
    const hit = this.accountFor(provider, ev);
    if (!hit) return this.ignore(provider, ev, seen, named ? ev.owner : null, 'unknown_subscription', named);
    if (named && ev.owner !== hit.key) return this.ignore(provider, ev, seen, hit.key, 'owner_mismatch', true);
    const late = this.supersededBy(hit, ev);
    if (late) return this.ignore(provider, ev, seen, hit.key, late, true);
    const pm = this.providers[provider].mode;
    if (typeof ev.livemode === 'boolean' && pm !== 'unknown' && (ev.livemode ? 'live' : 'test') !== pm) return this.ignore(provider, ev, seen, hit.key, 'other_mode', true);
    const outcome = await this.adopt(hit.key, hit.target, { ...ev, provider }, `${provider}:${ev.type}`, { seen });
    if (outcome === 'duplicate') return { duplicate: true };
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
