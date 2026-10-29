// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Plans, usage metering (counting what each account uses) and quotas
// (limits), with Stripe and PayPal as payment providers. A billing account
// belongs to a user or a team, and the team's owners manage it. Payment
// happens on the provider's own pages, so card data never touches Gitcha.
// Provider events arrive by signed webhook. When the browser comes back from
// checkout, the server also asks the provider what happened, so nothing the
// browser says is trusted.
//
// Everything lives in store.data.billing: `accounts` (by "user:NAME" or
// "team:NAME"), `usage` (counts by account and month), `events` (webhook ids
// already handled), `pendingCancels` (subscriptions still to cancel at the
// provider) and `closed` (the last 200 closed accounts).
import fs from 'node:fs';
import { HttpError } from '../errors.js';
import { StripeProvider } from './stripe.js';
import { PayPalProvider } from './paypal.js';

// What is counted against a plan's limits, with the words used in messages.
export const METRICS = {
  fn_invocations: 'function invocations',
  build_minutes: 'build minutes',
  sites: 'sites',
};

// The default plans. An operator can replace them with GITCHA_PLANS_FILE (same shape). A number price is
// per month in GITCHA_CURRENCY; a text price is shown as written.
export const DEFAULT_PLANS = {
  free: { name: 'Free', price: null, limits: { fn_invocations: 10_000, build_minutes: 300, sites: 3 }, paid: false },
  pro: { name: 'Pro', price: 5, limits: { fn_invocations: 1_000_000, build_minutes: 3000, sites: 50 }, paid: true },
  team: { name: 'Team', price: 20, limits: { fn_invocations: 5_000_000, build_minutes: 10_000, sites: 200 }, paid: true },
};

// "2026-10" for a time in October 2026: usage is counted per calendar month (UTC).
const month = (t) => new Date(t).toISOString().slice(0, 7);
const GRACE_MS = 7 * 86_400_000; // a failed payment keeps the paid limits this long
const EVENT_KEEP_MS = 30 * 86_400_000; // a delivered event is remembered this long (providers retry for days); an older one is refused
const READONLY_GRACE_MS = 14 * 86_400_000; // after the paid limits end, sites over the new limit keep taking changes this long
const GONE = '(gone)'; // the binding of an account whose owner no longer exists

// Billing services holding usage counts that are not on disk yet. A stop signal ends in process.exit, and the
// 'exit' handler below writes them then.
const unflushed = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const b of unflushed) { try { b.flushNow(); } catch { /* the process is ending: nothing more can be done */ } } });
}

/** Plans, limits, usage counts, checkout, cancelling and provider webhooks. */
export class BillingService {
  constructor({ store, config, teams, clock = Date.now, fetchImpl = globalThis.fetch, log = { info: (m) => console.log(m), error: (m) => console.error(m) } }) {
    Object.assign(this, { store, config, teams, clock, log, flushMs: 2000, flushFailures: 0 });
    this.pending = new Map(); // usage counts not saved yet: account -> month -> { metric: count }
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

  /**
   * Runs once when billing is on. Logs which mode (live or test) each provider's keys are in,
   * binds old accounts to their owner, closes accounts whose owner is gone, and repeats the
   * checks every 5 minutes while the server runs.
   */
  startUp() {
    for (const [name, p] of Object.entries(this.providers)) {
      this.log.info(p.mode === 'unknown' ? `billing: ${name} keys are neither live nor test keys; records of the two modes cannot be told apart` : `billing: ${name} is in ${p.mode} mode`);
    }
    let changed = 0;
    try {
      this.store.tx(() => {
        for (const [key, a] of Object.entries(this.data.accounts)) {
          if (a.ownerRef === undefined) { a.ownerRef = this.ownerRef(key) ?? GONE; changed++; }
          // A record from before modes existed is taken to be in the mode the keys are in now.
          if (a.subscription && a.subscription.mode === undefined && this.providers[a.subscription.provider]) { a.subscription.mode = this.providers[a.subscription.provider].mode; changed++; }
        }
      });
      if (changed) this.log.info(`billing: bound ${changed} billing record(s) to their owner or mode`);
    } catch (err) { this.log.error(`billing: could not save the bindings: ${err.message}`); }
    const other = Object.keys(this.data.accounts).filter((k) => { const s = this.data.accounts[k].subscription; return s && !this.modeOk(s); }).length;
    if (other) this.log.info(`billing: ${other} subscription record(s) were written in the other mode and are not honoured`);
    const upkeep = () => this.reconcile().then(() => this.refresh()).catch((err) => this.log.error(`billing: ${err.message}`));
    upkeep();
    // Within minutes, a team deleted since the last look has its subscription cancelled, and a subscription past its paid period is checked with the provider.
    this.upkeepTimer = setInterval(upkeep, 5 * 60_000);
    this.upkeepTimer.unref?.();
  }

  get enabled() { return this.config.billing.enabled; }
  get data() { return this.store.data.billing; }

  /** What a plan says it costs, for showing. The real charge is whatever the Stripe Price or PayPal Plan says; nothing here compares them. */
  priceLabel(p) { return typeof p.price === 'number' ? `${p.price} ${this.config.billing.currency ?? 'USD'} per month` : p.price ?? null; }

  /** For the ring manifest: what this server sells. */
  paidFeatures() {
    if (!this.enabled) return [];
    return Object.entries(this.plans).filter(([, p]) => p.paid).map(([id, p]) => `${p.name} plan (${this.priceLabel(p) ?? 'priced on request'})`);
  }

  // ---- accounts and permissions ------------------------------------------------------
  /** Reads a billing owner: "user:NAME" (or nothing, meaning the caller) or "team:NAME". */
  parseOwner(user, owner) {
    if (!owner || owner === `user:${user.username}`) return { key: `user:${user.username}`, type: 'user', name: user.username };
    const m = /^team:([a-z0-9][a-z0-9_-]{1,31})$/.exec(owner);
    if (!m) throw new HttpError(400, 'bad_owner', 'Billing owner must be "user:NAME" or "team:NAME".');
    return { key: owner, type: 'team', name: m[1] };
  }

  /**
   * Users see and pay for themselves. Team owners pay for their team, and team members can look.
   * If the stored account no longer belongs to its owner, a clean-up (reconcile) starts.
   */
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
  /**
   * What an account is bound to: the user's id, or the team as it was created. Teams may have no
   * id, so the creation time and creator tell apart a team that took a freed name.
   */
  ownerRef(key) {
    const [type, ...rest] = key.split(':');
    const name = rest.join(':');
    if (type === 'user') return this.store.userByName(name)?.id ?? null;
    const t = this.store.team(name);
    return t ? t.id ?? `${t.createdAt}:${t.createdBy}` : null;
  }

  /** The account, if it still belongs to the owner it was opened for. A team name reused by someone else gets nothing. */
  accountOf(key) {
    const a = this.data.accounts[key];
    if (!a) return null;
    if (a.ownerRef !== undefined && a.ownerRef !== this.ownerRef(key)) return null;
    return a;
  }

  /** The account to write to: the existing one if it is this owner's, else a new one. An old account under the same name is closed first. */
  ensureAccount(d, key) {
    let a = d.billing.accounts[key];
    if (a && a.ownerRef !== undefined && a.ownerRef !== this.ownerRef(key)) { this.retireInto(d, key, 'owner_changed'); a = undefined; }
    return (d.billing.accounts[key] ??= { ownerRef: this.ownerRef(key) });
  }

  /** Closes an account inside a write: its record goes, its live provider subscriptions are queued to be cancelled, and the closing is logged. */
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

  /** Used when a team is deleted: closes its billing account and cancels its subscription at the provider. Never throws. */
  async closeAccount(key, who = {}) {
    try {
      this.store.tx((d) => this.retireInto(d, key, who.reason ?? 'team_deleted', who));
    } catch (err) { this.log.error(`billing: could not close ${key}: ${err.message}`); }
    await this.drainCancels();
  }

  /** Closes every account whose owner is gone or was replaced, then cancels what they left at the providers. */
  async reconcile() {
    const stale = Object.keys(this.data.accounts).filter((k) => !this.accountOf(k));
    if (stale.length) {
      try { this.store.tx((d) => { for (const k of stale) this.retireInto(d, k, this.ownerRef(k) === null ? 'owner_gone' : 'owner_changed'); }); } catch (err) { this.log.error(`billing: could not retire ${stale.join(', ')}: ${err.message}`); return; }
    }
    await this.drainCancels();
  }

  /** Cancels, at the provider, the subscriptions of closed accounts. A cancel that fails stays queued for the next pass. Only one pass runs at a time. */
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

  /** A record written with test keys is not a paid plan once the keys are live, and the other way round. Unknown modes are let through. */
  modeOk(s) {
    const pm = this.providers[s.provider]?.mode;
    return !s.mode || !pm || pm === 'unknown' || s.mode === 'unknown' || s.mode === pm;
  }

  /** Asks the provider about subscriptions whose paid period has run out: a renewal PayPal never announces, or an event that never came. */
  async refresh() {
    const now = this.clock();
    for (const key of Object.keys(this.data.accounts)) {
      const s = this.subscription(key);
      if (!s?.subscriptionId || !['active', 'past_due'].includes(s.status) || s.currentPeriodEnd == null || s.currentPeriodEnd >= now) continue;
      const p = this.providers[s.provider];
      if (!p) continue;
      try {
        const found = await p.lookup({ subscriptionId: s.subscriptionId });
        if (found?.owner === key && found.subscriptionId === s.subscriptionId) await this.adopt(key, 'current', { ...found, provider: s.provider }, 'refreshed', { authoritative: true, actor: { by: 'refresh' } });
      } catch (err) { this.log.error(`billing: could not refresh ${key}: ${err.message}`); }
    }
  }

  /** The account's subscription, if the account is still its owner's and the record is in the current mode. */
  subscription(key) {
    const s = this.accountOf(key)?.subscription;
    return s && this.modeOk(s) ? s : null;
  }

  /**
   * How a subscription stands:
   *   'paid'  paid up. This includes one its owner cancelled, until the period they paid for ends.
   *   'grace' a failed payment, or a paid period that ran out with no word from the provider. The
   *           paid limits stay for seven days from when that began.
   *   'none'  anything else.
   * A record with no period end never runs out by itself.
   */
  standing(s) {
    const now = this.clock();
    let since;
    if (s.status === 'past_due') since = s.pastDueSince ?? s.updatedAt;
    else if (s.status === 'active') {
      if (s.currentPeriodEnd == null || s.currentPeriodEnd >= now) return 'paid';
      since = s.currentPeriodEnd;
    } else if (s.status === 'canceled' && s.keepUntil != null && s.keepUntil >= now) return 'paid'; // cancelled by its owner, the paid period runs on
    else return 'none';
    return now - since < GRACE_MS ? 'grace' : 'none';
  }

  /** The plan whose limits apply now: the subscribed plan while it is paid or in grace, otherwise 'free'. */
  planFor(key) {
    const s = this.subscription(key);
    if (s && Object.hasOwn(this.plans, s.plan) && this.standing(s) !== 'none') return s.plan;
    return 'free';
  }

  /** This month's counts for an account (a copy). */
  usage(key, t = this.clock()) {
    const m = month(t);
    const out = { ...(this.data.usage[key]?.[m] ?? {}) };
    // Add the counts that are not saved yet (see record).
    for (const [metric, n] of Object.entries(this.pending.get(key)?.get(m) ?? {})) out[metric] = Math.max(0, (out[metric] ?? 0) + n);
    return out;
  }

  /** Adds `n` to this month's count, or to the month `at` falls in. `n` may be negative, but a count never goes below zero. */
  record(key, metric, n = 1, at = this.clock()) {
    if (!METRICS[metric]) return;
    const m = month(at);
    // Usage is written to disk soon after, not with every count. A stop signal writes it too (see hookExit).
    // Until then the count waits here, beside the database and not in it: if the store has to go back to
    // what is on disk (a failed write, or a change that failed halfway), the waiting counts are not lost.
    if (!this.pending.has(key)) this.pending.set(key, new Map());
    const byMonth = this.pending.get(key);
    const counts = byMonth.get(m) ?? {};
    counts[metric] = (counts[metric] ?? 0) + n;
    byMonth.set(m, counts);
    unflushed.add(this);
    hookExit();
    this.scheduleFlush();
  }

  /** Writes the store after `delay` ms, unless a write is already waiting. A failed write is tried again later, waiting longer each time (at most a minute). */
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

  /**
   * Writes the waiting usage counts to disk now, in one save. If the save fails, the counts stay
   * waiting, so the next try writes them.
   */
  flushNow() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.size) {
      const batch = this.pending;
      this.store.tx((d) => {
        for (const [key, byMonth] of batch) {
          const u = (d.billing.usage[key] ??= {});
          for (const [m, counts] of byMonth) {
            const row = (u[m] ??= {});
            for (const [metric, n] of Object.entries(counts)) row[metric] = Math.max(0, (row[metric] ?? 0) + n);
          }
        }
      });
      // Only after the save worked: counts made during it would be lost if a new map had been started earlier.
      if (this.pending === batch) this.pending = new Map();
    }
    unflushed.delete(this);
  }

  /** The sites an account owns (from store.data.sites). */
  sitesOf(key) {
    const [type, ...rest] = key.split(':');
    const name = rest.join(':');
    return Object.values(this.store.data.sites ?? {}).filter((s) => s.owner?.type === type && s.owner?.name === name);
  }

  /** How much of a metric an account has used: this month's count, or for sites how many it owns. */
  held(key, metric) {
    return metric === 'sites' ? this.sitesOf(key).length : this.usage(key)[metric] ?? 0;
  }

  /**
   * The accounts that share one Free allowance: a person's own account and those of the teams they
   * created, so making more teams does not give more free use. A paid account stands alone, and so
   * does a team with no creator on record.
   */
  poolOf(key) {
    if (this.plans[this.planFor(key)]?.paid) return [key];
    const [type, ...rest] = key.split(':');
    const name = rest.join(':');
    const creator = type === 'user' ? name : this.store.team(name)?.createdBy;
    if (!creator) return [key];
    const made = Object.values(this.store.data.teams ?? {}).filter((t) => t.createdBy === creator).map((t) => `team:${t.name}`);
    return [...new Set([key, `user:${creator}`, ...made])].filter((k) => !this.plans[this.planFor(k)]?.paid);
  }

  /**
   * Throws 402 (payment required) when taking `n` more would pass the owner's plan limit. `current`
   * replaces this account's count (e.g. its number of sites). On Free the count is shared by the
   * person's own account and the teams they created (see poolOf). Does nothing when billing is off.
   */
  check(key, metric, current, n = 1) {
    if (!this.enabled) return;
    const plan = this.plans[this.planFor(key)];
    const limit = plan.limits?.[metric];
    if (limit === undefined || limit === null) return;
    const pool = this.poolOf(key);
    const used = pool.reduce((sum, k) => sum + (k === key && current !== undefined ? current : this.held(k, metric)), 0);
    if (used + n > limit) {
      const shared = pool.length > 1 ? ` (Free is one allowance for ${pool.length} accounts: a person's own and the teams they created)` : '';
      throw new HttpError(402, 'quota_exceeded', `${key} has used ${used} of ${limit} ${METRICS[metric]} on the ${plan.name} plan${current === undefined && metric !== 'sites' ? ' this month' : ''}${shared}. Upgrade at ${this.config.publicUrl}/billing.`, { metric, limit, used, plan: this.planFor(key) });
    }
  }

  /**
   * Takes `n` of a metered resource before the work starts. It refuses (402) if that passes the
   * limit, and counts it now, so jobs let in at the same time all count. Returns plain data to keep
   * with the job; give it to settle() when the work ends.
   */
  reserve(key, metric, n = 1) {
    this.check(key, metric, undefined, n);
    this.record(key, metric, n);
    return { key, metric, n, at: this.clock() };
  }

  /** The work ended having used `actual` (0 if it never ran): fixes the count made at reserve(). Works once per reservation; a second call does nothing. */
  settle(reservation, actual) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    const diff = Math.max(0, actual) - reservation.n;
    if (diff) this.record(reservation.key, reservation.metric, diff, reservation.at);
  }

  /** The work never ran (a platform failure, or a job that never started): gives the whole count back. */
  release(reservation) { this.settle(reservation, 0); }

  /**
   * The sites beyond what the plan now allows (the newest ones; deleting an older site frees a
   * place), and from when they stop taking changes: the end of the paid period or its grace,
   * plus fourteen days. `readOnlyFrom` is null while no such date is known: an account that never
   * paid keeps what it has (it just cannot add more). Nothing is deleted, and the sites stay online.
   */
  overQuota(key) {
    const none = { over: [], limit: null, plan: null, readOnlyFrom: null };
    if (!this.enabled) return none;
    const plan = this.plans[this.planFor(key)];
    const limit = plan.limits?.sites;
    if (limit === undefined || limit === null) return none;
    const all = this.poolOf(key).flatMap((k) => this.sitesOf(k)).sort((x, y) => x.createdAt - y.createdAt || x.name.localeCompare(y.name));
    const [type, ...rest] = key.split(':');
    const over = all.slice(limit).filter((x) => x.owner.type === type && x.owner.name === rest.join(':')).map((x) => x.name);
    const ended = this.paidUntil(key);
    return { over, limit, plan: plan.name, readOnlyFrom: over.length && ended != null ? ended + READONLY_GRACE_MS : null };
  }

  /** For a deploy or an activation: throws 402 if this site is over its owner's plan and the grace after the paid period has run out. */
  requireWritableSite(key, site) {
    const q = this.overQuota(key);
    if (!q.over.includes(site) || q.readOnlyFrom === null || this.clock() < q.readOnlyFrom) return;
    throw new HttpError(402, 'site_read_only', `${site} is over the ${q.plan} plan's ${q.limit} sites and takes no more changes (it is still served). Remove ${q.over.length} site(s) or upgrade at ${this.config.publicUrl}/billing.`, { metric: 'sites', limit: q.limit, over: q.over, since: q.readOnlyFrom });
  }

  /** The billing page's data: plan, limits, usage, subscription, plans for sale and (for managers) the history. */
  view(user, owner) {
    const o = this.account(user, owner);
    const plan = this.planFor(o.key);
    const sub = this.subscription(o.key);
    const pool = this.poolOf(o.key);
    const over = this.overQuota(o.key);
    return {
      owner: o.key, enabled: this.enabled, plan, planName: this.plans[plan].name, limits: this.plans[plan].limits, usage: this.countedUsage(o.key),
      ...(pool.length > 1 ? { sharedWith: pool.length - 1 } : {}), ...(over.over.length ? { overQuota: { sites: over.over, limit: over.limit, readOnlyFrom: over.readOnlyFrom } } : {}),
      subscription: sub ? { provider: sub.provider, plan: sub.plan, status: sub.status === 'active' && this.standing(sub) !== 'paid' ? 'past_due' : sub.status, currentPeriodEnd: sub.currentPeriodEnd ?? null, endsAt: sub.status === 'canceled' && this.standing(sub) === 'paid' ? sub.keepUntil : null } : null,
      pendingCheckout: this.accountOf(o.key)?.checkout ? { provider: this.accountOf(o.key).checkout.provider, plan: this.accountOf(o.key).checkout.plan } : null,
      plans: Object.entries(this.plans).map(([id, p]) => ({ id, name: p.name, price: this.priceLabel(p), limits: p.limits, paid: Boolean(p.paid) })),
      providers: Object.keys(this.providers).filter((k) => this.providers[k].canSell),
      // The money history is for the people who manage the account, not for every member of a team.
      ...(this.mayManage(user, o) ? { history: [...(this.accountOf(o.key)?.history ?? [])].reverse().slice(0, 25) } : {}),
    };
  }

  /** What counts against the limits: this month's metered use and the sites held, summed over the accounts that share the allowance. */
  countedUsage(key) {
    const out = {};
    for (const m of Object.keys(METRICS)) out[m] = this.poolOf(key).reduce((sum, k) => sum + this.held(k, m), 0);
    return out;
  }

  /** A person manages their own account; for a team, only its owners do. */
  mayManage(user, o) {
    return o.type === 'user' || this.teams.has(this.teams.get(o.name), user, 'owner');
  }

  // ---- writes ---------------------------------------------------------------------------------
  /**
   * Runs `change(d)` in one write and, if `seen` is given, marks that event as seen in the same
   * write. If the write fails, the memory copy is put back (the account, the close queues and the
   * marker), so nothing half-done is kept and the provider's retry starts clean.
   */
  atomically(key, change, seen = null) {
    const bd = this.data;
    const was = { account: key ? structuredClone(bd.accounts[key]) : undefined, closed: structuredClone(bd.closed), pending: structuredClone(bd.pendingCancels), marker: seen ? bd.events[seen] : undefined };
    const put = (obj, k, v) => { if (v === undefined) delete obj[k]; else obj[k] = v; };
    try {
      return this.store.tx((d) => {
        const out = change(d);
        if (seen) this.markSeen(d, seen);
        return out;
      });
    } catch (err) {
      // A failed write already put the store's memory back to match the file (audit rows too); a throw before the write did not. Either way, put the billing state back as it was.
      const now = this.data;
      if (key) put(now.accounts, key, was.account);
      put(now, 'closed', was.closed);
      put(now, 'pendingCancels', was.pending);
      if (seen) put(now.events, seen, was.marker);
      throw err;
    }
  }

  /**
   * Remembers an event id for EVENT_KEEP_MS (30 days). Old ids are dropped by age, not by count, so a
   * flood of other events cannot make an old one usable again (a "replay"). Only verified events get here.
   */
  markSeen(d, seen) {
    const now = this.clock();
    d.billing.events[seen] = now;
    for (const [k, at] of Object.entries(d.billing.events)) if (!(now - at <= EVENT_KEEP_MS)) delete d.billing.events[k];
  }

  /** Who should see a money row in their audit trail: the people who manage the account, and whoever acted. */
  audience(key, actor = {}) {
    const [type, ...rest] = key.split(':');
    const name = rest.join(':');
    const ids = new Set();
    if (type === 'user') { const u = this.store.userByName(name); if (u) ids.add(u.id); } else {
      for (const [id, m] of Object.entries(this.store.team(name)?.members ?? {})) if (m.role === 'owner') ids.add(id);
    }
    if (actor.userId) ids.add(actor.userId);
    return [...ids];
  }

  /** Writes the history row (the last 50 are kept) and the audit rows for one change: what changed, who or what did it, and (for a webhook) which event. */
  trail(d, key, a, event, actor = {}, { status, plan, provider } = {}) {
    // `via` is what made the change (the member, the return page, a webhook, the refresh). `by` is the member's name, as the audit log reads it.
    const row = { status, plan, provider, via: actor.by, ...(actor.username ? { by: actor.username } : {}), ...(actor.eventId ? { eventId: actor.eventId } : {}), ...(a.subscription?.subscriptionId ? { subscriptionId: a.subscription.subscriptionId } : {}) };
    a.history = [...(a.history ?? []).slice(-49), { at: this.clock(), event, ...row }];
    const entry = { event: `billing.${event}`, owner: key, ...row };
    const who = this.audience(key, actor);
    if (!who.length) this.store.audit(entry);
    for (const userId of who) this.store.audit({ userId, ...entry, ...(userId === actor.userId && actor.ip ? { ip: actor.ip } : {}) });
  }

  /** Changes the account's subscription record inside a write. `replace` starts a fresh record instead of merging into the old one. */
  putSubscription(d, key, patch, event, { replace = false, clearCheckout = false, actor } = {}) {
    const a = this.ensureAccount(d, key);
    const prior = a.subscription;
    const before = replace ? {} : prior ?? {};
    a.subscription = { ...before, ...patch, updatedAt: this.clock() };
    // The grace is counted from the first moment of a past-due spell. A later write that keeps it past due cannot move that moment.
    if (a.subscription.status !== 'past_due') delete a.subscription.pastDueSince;
    else a.subscription.pastDueSince = before.status === 'past_due' ? before.pastDueSince ?? before.updatedAt : this.clock();
    this.markPaidSpell(a, before, prior);
    if (clearCheckout) delete a.checkout;
    this.trail(d, key, a, event, actor, a.subscription);
  }

  /** A checkout for a new plan on an account that already pays waits in its own slot (null empties it). The paid record is not touched. */
  putCheckout(d, key, slot, event, actor) {
    const a = this.ensureAccount(d, key);
    if (slot) a.checkout = slot; else delete a.checkout;
    this.trail(d, key, a, event, actor, { status: 'pending', plan: slot?.plan, provider: slot?.provider });
  }

  /**
   * Remembers when a paid spell began and ended, so a downgrade can be dated (see overQuota).
   * `kept` is the record the new one grew from (so activatedAt carries over). `prior` is the record
   * it replaced, whose end counts if the new one is not paid.
   */
  markPaidSpell(a, kept, prior) {
    const s = a.subscription;
    const now = this.clock();
    if (s.status === 'active') s.activatedAt = kept.activatedAt ?? now;
    else if (kept.activatedAt !== undefined) s.activatedAt = kept.activatedAt;
    if (s.status === 'canceled') s.canceledAt = kept.canceledAt ?? now; else delete s.canceledAt;
    if (this.plans[s.plan]?.paid && this.standing(s) !== 'none') { delete a.paidEnded; return; }
    const ended = this.endOf(s) ?? this.endOf(prior);
    if (ended != null) a.paidEnded = ended;
  }

  /** When a subscription's paid limits stopped (grace included), or null if it never had them. For a live one this is a future time; callers check that it is not paid. */
  endOf(s) {
    if (!s || !this.plans[s.plan]?.paid) return null;
    if (s.status === 'active') return s.currentPeriodEnd == null ? null : s.currentPeriodEnd + GRACE_MS;
    if (s.status === 'past_due') return (s.pastDueSince ?? s.updatedAt) + GRACE_MS;
    if (s.status === 'canceled' && s.activatedAt !== undefined) return Math.max(s.canceledAt ?? s.updatedAt, s.keepUntil ?? 0);
    return null;
  }

  /** When this account last stopped being on a paid plan (null while it is on one, or if it never was). */
  paidUntil(key) {
    const a = this.accountOf(key);
    if (!a || this.plans[this.planFor(key)]?.paid) return null;
    if (a.subscription && !this.modeOk(a.subscription)) return null;
    return a.paidEnded ?? this.endOf(a.subscription);
  }

  // The same two changes, each as one write of its own.
  setSubscription(key, patch, event, opts) { this.atomically(key, (d) => this.putSubscription(d, key, patch, event, opts)); }
  setCheckout(key, slot, event, actor) { this.atomically(key, (d) => this.putCheckout(d, key, slot, event, actor)); }

  // ---- checkout ---------------------------------------------------------------------------
  /** A configured provider by the name a client sent. Names like "constructor" are not providers. */
  providerNamed(name) { return typeof name === 'string' && Object.hasOwn(this.providers, name) ? this.providers[name] : undefined; }

  /** Like providerNamed, but throws 400 when billing is off or the provider is not set up. */
  provider(name) {
    const p = this.providerNamed(name);
    if (!this.enabled || !p) throw new HttpError(400, 'provider_unavailable', `Payments with ${name} are not set up on this instance.`);
    return p;
  }

  /**
   * Starts paying for a plan and returns the provider's checkout page. Only an account's managers
   * may do this. Buying the plan the account already pays for is refused (409).
   */
  async checkout(user, { owner, plan, provider }, ip) {
    const o = this.account(user, owner, { manage: true });
    if (!this.plans[plan]?.paid) throw new HttpError(400, 'bad_plan', `"${plan}" is not a paid plan.`);
    const current = this.subscription(o.key);
    const paying = Boolean(current && (['active', 'past_due'].includes(current.status) || this.standing(current) === 'paid'));
    if (paying && current.status !== 'canceled' && current.plan === plan) {
      throw new HttpError(409, 'already_subscribed', `${o.key} is already on the ${this.plans[plan].name} plan.`);
    }
    const p = this.provider(provider);
    const base = this.config.publicUrl;
    const out = await p.createCheckout({
      owner: o.key, plan,
      successUrl: `${base}/billing/return?provider=${provider}&owner=${encodeURIComponent(o.key)}`,
      cancelUrl: `${base}/billing?owner=${encodeURIComponent(o.key)}&msg=cancelled`,
    });
    // On an account that already pays, the new plan waits in its own slot. The paid subscription stays until the new one is confirmed.
    const actor = { by: 'user', userId: user.id, username: user.username, ip };
    if (paying) this.setCheckout(o.key, { provider, plan, mode: p.mode, ...out.ids, startedAt: this.clock() }, 'checkout_started', actor);
    else this.setSubscription(o.key, { provider, plan, mode: p.mode, status: 'pending', ...out.ids }, 'checkout_started', { replace: true, clearCheckout: true, actor });
    return { url: out.url };
  }

  /**
   * The browser came back from the provider: ask the provider what really happened. The found
   * subscription must name this account and be one the account is waiting on or already holds.
   */
  async confirmReturn(user, { owner, provider, sessionId, subscriptionId }, ip) {
    const o = this.account(user, owner);
    const p = this.provider(provider);
    const sub = this.subscription(o.key);
    const slot = this.accountOf(o.key)?.checkout;
    const found = await p.lookup({ sessionId, subscriptionId: subscriptionId ?? sub?.subscriptionId ?? slot?.subscriptionId });
    if (!found || found.owner !== o.key) throw new HttpError(400, 'not_confirmed', 'The payment provider has no matching subscription for this account yet.');
    // The subscription must be one this account is waiting on or already holds. Its owner field alone proves nothing, since anyone can type it.
    const target = this.targetOf(o.key, provider, { subscriptionId: found.subscriptionId, checkoutSessionId: sessionId });
    if (!target) throw new HttpError(400, 'not_confirmed', 'That subscription is not the one this account is waiting on.');
    await this.adopt(o.key, target, { ...found, provider }, 'confirmed', { authoritative: true, actor: { by: 'confirm', userId: user.id, username: user.username, ip } });
    return this.view(user, o.key);
  }

  /** A manager cancels the account's subscription, at the provider and here. */
  async cancel(user, { owner }, ip) {
    const o = this.account(user, owner, { manage: true });
    const sub = this.subscription(o.key);
    if (!sub || !['active', 'past_due', 'pending'].includes(sub.status)) throw new HttpError(409, 'no_subscription', 'There is no subscription to cancel.');
    // A paid-up subscription stops renewing and keeps its plan to the end of the period already paid for. One with no paid period left ends now.
    const keepUntil = sub.status === 'active' && sub.currentPeriodEnd != null && sub.currentPeriodEnd > this.clock() ? sub.currentPeriodEnd : null;
    await this.provider(sub.provider).cancel(sub, { atPeriodEnd: keepUntil != null });
    this.setSubscription(o.key, { status: 'canceled', ...(keepUntil != null ? { keepUntil } : {}) }, 'canceled_by_user', { actor: { by: 'user', userId: user.id, username: user.username, ip } });
    return this.view(user, o.key);
  }

  /** A link to Stripe's customer portal (change the card, see invoices). Only for Stripe subscriptions. */
  async portal(user, { owner }) {
    const o = this.account(user, owner, { manage: true });
    const sub = this.subscription(o.key);
    if (sub?.provider !== 'stripe' || !sub.customerId) throw new HttpError(409, 'no_portal', 'The billing portal is available for Stripe subscriptions.');
    return { url: await this.provider('stripe').portal(sub.customerId, `${this.config.publicUrl}/billing?owner=${encodeURIComponent(o.key)}`) };
  }

  // ---- webhooks -------------------------------------------------------------------------------
  /** Which of this account's records does the provider's subscription or session belong to: 'current' (the paid one), 'checkout' (the waiting one) or null? */
  targetOf(key, provider, { subscriptionId, checkoutSessionId }) {
    const hit = (r) => r?.provider === provider && ((subscriptionId && r.subscriptionId === subscriptionId) || (checkoutSessionId && r.checkoutSessionId === checkoutSessionId));
    if (hit(this.subscription(key))) return 'current';
    if (hit(this.accountOf(key)?.checkout)) return 'checkout';
    return null;
  }

  /** Finds the account an event is about by the ids we saved, never by the owner the event claims. */
  accountFor(provider, ids) {
    for (const key of Object.keys(this.data.accounts)) {
      const target = this.targetOf(key, provider, ids);
      if (target) return { key, target };
    }
    return null;
  }

  /** Why an event for this account must not be applied, if it must not: it is older than one already applied, or the subscription has ended. Otherwise null. */
  supersededBy(hit, ev) {
    if (hit.target !== 'current') return null;
    const s = this.subscription(hit.key);
    // Cancelled is final for a subscription (buying again makes a new subscription), whatever order the events arrive in.
    if (s.status === 'canceled' && s.subscriptionId === ev.subscriptionId && ev.status && ev.status !== 'canceled') return 'subscription_ended';
    // Events carry the provider's own time. One older than the last applied is a late delivery. Ids are random and give no order, so an event from the same second still applies.
    if (ev.at != null && s.lastEventAt != null && ev.at < s.lastEventAt) return 'older_than_applied';
    return null;
  }

  /**
   * Takes what the provider says about a subscription into the account. When a waiting checkout
   * becomes active, the old paid subscription is cancelled first. `seen` marks the event in the same
   * write. Returns 'applied', 'dropped', 'waiting' or 'duplicate'.
   */
  async adopt(key, target, next, event, { authoritative = false, seen = null, actor } = {}) {
    const patch = {};
    for (const k of ['status', 'plan', 'subscriptionId', 'customerId', 'currentPeriodEnd']) if (next[k] !== undefined && (next[k] !== null || (authoritative && k === 'currentPeriodEnd'))) patch[k] = next[k];
    // mark: note the event as seen without changing the account.
    const mark = (outcome) => { if (seen) this.atomically(null, () => {}, seen); return outcome; };
    if (target === 'current') {
      // A subscription its owner cancelled keeps running at Stripe until the period ends. That is not it coming back to life.
      const cur = this.subscription(key);
      if (cur.status === 'canceled' && cur.keepUntil != null && cur.subscriptionId === next.subscriptionId && patch.status && patch.status !== 'canceled') delete patch.status;
      if (next.at != null) patch.lastEventAt = Math.max(next.at, this.subscription(key).lastEventAt ?? 0);
      return this.atomically(key, (d) => { this.putSubscription(d, key, { provider: next.provider, ...patch }, event, { actor }); return 'applied'; }, seen);
    }
    const slot = this.accountOf(key).checkout;
    if (next.status === 'canceled') { // the buyer never paid, or the provider dropped the new subscription
      return this.atomically(key, (d) => { this.putCheckout(d, key, null, 'checkout_dropped', actor); return 'dropped'; }, seen);
    }
    if (next.status !== 'active') return mark('waiting');
    const old = this.subscription(key);
    if (old && ['active', 'past_due'].includes(old.status) && old.subscriptionId !== next.subscriptionId) await this.provider(old.provider).cancel(old);
    // The cancel took a while. If another delivery or a confirm got here first, there is nothing left to do.
    if ((seen && this.data.events[seen]) || this.accountOf(key)?.checkout !== slot) return 'duplicate';
    const fresh = { provider: next.provider, ...patch, plan: patch.plan ?? slot.plan, mode: slot.mode, checkoutSessionId: slot.checkoutSessionId, ...(next.at != null ? { lastEventAt: next.at } : {}) };
    return this.atomically(key, (d) => { this.putSubscription(d, key, fresh, event, { replace: true, clearCheckout: true, actor }); return 'applied'; }, seen);
  }

  /** Records an event we will not apply: marks it seen (so a retry is a duplicate), and writes an audit row when it names a Gitcha owner. */
  ignore(provider, ev, seen, key, reason, audit) {
    this.atomically(key ?? null, () => { if (audit) this.store.audit({ event: 'billing.event_ignored', owner: key, provider, eventType: ev.type, eventId: ev.id, reason }); }, seen);
    return { ignored: true, reason };
  }

  /**
   * Applies a verified provider event. Each event id is applied once, and it is marked seen only
   * together with its effect. The checks, in order: already seen, too old, no matching account,
   * owner mismatch, out of date, and live/test mode mismatch.
   */
  async applyEvent(provider, ev) {
    if (!ev) return { ignored: true };
    const seen = `${provider}:${ev.id}`;
    if (this.data.events[seen]) return { duplicate: true };
    const named = typeof ev.owner === 'string' && /^(user|team):/.test(ev.owner);
    // Once an id has aged out of the table it could be sent again. The provider's own time on the event stops that (Stripe's signature also has a 5 minute limit).
    if (ev.at != null && this.clock() - ev.at > EVENT_KEEP_MS) return this.ignore(provider, ev, seen, named ? ev.owner : null, 'too_old', named);
    const hit = this.accountFor(provider, ev);
    if (!hit) return this.ignore(provider, ev, seen, named ? ev.owner : null, 'unknown_subscription', named);
    if (named && ev.owner !== hit.key) return this.ignore(provider, ev, seen, hit.key, 'owner_mismatch', true);
    const late = this.supersededBy(hit, ev);
    if (late) return this.ignore(provider, ev, seen, hit.key, late, true);
    const pm = this.providers[provider].mode;
    if (typeof ev.livemode === 'boolean' && pm !== 'unknown' && (ev.livemode ? 'live' : 'test') !== pm) return this.ignore(provider, ev, seen, hit.key, 'other_mode', true);
    const outcome = await this.adopt(hit.key, hit.target, { ...ev, provider }, `${provider}:${ev.type}`, { seen, actor: { by: 'webhook', eventId: ev.id } });
    if (outcome === 'duplicate') return { duplicate: true };
    if (outcome !== 'applied') return { ignored: true, reason: outcome };
    return { applied: true, owner: hit.key, status: ev.status };
  }

  /** Handles a webhook: the provider checks the signature, then the event is applied. Unknown providers, or billing turned off, get a 404. */
  async webhook(provider, rawBody, headers) {
    const p = this.providerNamed(provider);
    if (!this.enabled || !p) throw new HttpError(404, 'not_found', 'Not found.');
    const ev = await p.verifyWebhook(rawBody, headers); // throws 400 on a bad signature
    return this.applyEvent(provider, ev);
  }
}
