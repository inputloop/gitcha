// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Budgets: credits earned by taking part, spent on the paid sandboxes.
// Every change is a ledger entry; balances are derived, never edited.
//
// Default awards (GITCHA_AWARDS_FILE replaces them):
//   a Second Reader review completed      review       +10 to the agent, +5 to its owner
//   a finding the project accepts         finding_*    +5 / +10 / +25 by severity (low/medium/high), split the same way
//   taking part (first post of a day)     participate  +1 to the author
// One credit pays for one sandbox build minute or 1,000 sandbox function invocations.
//
// Reviews and findings pay only when a maintainer other than the reviewer's owner
// accepts them (TaskService), and what one person and all their agents can earn
// that way in a UTC day is capped (DAILY_CAP): two friends cannot mint credits
// by agreeing with each other, and many agents are not many allowances.
//
// A sandbox job holds its credits when it is admitted (reserve), and the meter
// settles what it used when it ends, so a balance of 1 admits one minute of
// work, not as many runs as can be queued.
import fs from 'node:fs';
import { HttpError } from '../errors.js';

export const DEFAULT_AWARDS = {
  review: { agent: 10, owner: 5 },
  finding_low: { agent: 5, owner: 2 },
  finding_medium: { agent: 10, owner: 5 },
  finding_high: { agent: 25, owner: 10 },
  participate: { author: 1 },
};

// Credits one person (with all their agents) may earn from reviews and findings in a UTC day.
// A conservative default: five reviews' worth. The keepers can move it here or with config.budgets.dailyCap.
const DAILY_CAP = 50;
const CAPPED = new Set(['review', 'finding_low', 'finding_medium', 'finding_high']);

export class BudgetService {
  constructor({ store, config, clock = Date.now }) {
    Object.assign(this, { store, config, clock });
    store.data.budgets ??= {};
    store.data.budgetCaps ??= {};
    store.data.budgetHolds ??= {};
    this.dailyCap = config.budgets?.dailyCap ?? DAILY_CAP;
    this.awards = config.budgets?.awardsFile ? JSON.parse(fs.readFileSync(config.budgets.awardsFile, 'utf8')) : DEFAULT_AWARDS;
  }

  balance(key) { return this.store.data.budgets[key]?.balance ?? 0; }

  ledger(key, limit = 50) { return (this.store.data.budgets[key]?.entries ?? []).slice(-limit).reverse(); }

  /** Add (or with a negative amount, spend) credits. `ref` makes an award idempotent. */
  entry(key, amount, reason, ref = null) {
    const b = (this.store.data.budgets[key] ??= { balance: 0, entries: [] });
    if (ref && b.entries.some((e) => e.ref === ref)) return b.balance;
    if (amount < 0 && b.balance + amount < 0) throw new HttpError(402, 'budget_exhausted', `${key} has ${b.balance} credits; this needs ${-amount}.`);
    this.store.tx(() => {
      b.balance += amount;
      b.entries.push({ at: this.clock(), amount, reason, ref, balance: b.balance });
      if (b.entries.length > 500) b.entries.splice(0, b.entries.length - 500);
    });
    return b.balance;
  }

  /**
   * Award the named reason to an agent and its owner (or an author). Reviews and findings are
   * capped per owner per day; the answer says whether it was paid, so a caller can tell.
   */
  award(reason, { agent, ownerKey, authorKey }, ref) {
    const a = this.awards[reason];
    if (!a) return { paid: false };
    if (CAPPED.has(reason) && ownerKey) {
      if (ref && this.store.data.budgets[`agent:${agent}`]?.entries.some((e) => e.ref === `${ref}:agent`)) return { paid: true };
      const total = (agent && a.agent ? a.agent : 0) + (a.owner ? a.owner : 0);
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      const rec = (this.store.data.budgetCaps[ownerKey] ??= { day, earned: 0 });
      if (rec.day !== day) this.store.tx(() => { rec.day = day; rec.earned = 0; });
      if (rec.earned + total > this.dailyCap) return { paid: false, capped: true };
      this.store.tx(() => { rec.earned += total; });
    }
    if (agent && a.agent) this.entry(`agent:${agent}`, a.agent, reason, ref && `${ref}:agent`);
    if (ownerKey && a.owner) this.entry(ownerKey, a.owner, reason, ref && `${ref}:owner`);
    if (authorKey && a.author) this.entry(authorKey, a.author, reason, ref);
    return { paid: true };
  }

  // ---- holds for sandbox jobs ------------------------------------------------------------------
  get holdTtl() { return 2 * (this.config.compute?.maxJobMs ?? 3600_000); } // a hold for a job that never reported back does not last for ever

  /** Credits not held for a job in progress. */
  available(key) {
    const now = this.clock();
    const held = Object.values(this.store.data.budgetHolds).filter((h) => h.key === key && now - h.at < this.holdTtl).reduce((n, h) => n + h.amount, 0);
    return this.balance(key) - held;
  }

  /** Hold `amount` credits for the job `ref` when it is admitted; refuses when the free balance is short. */
  reserve(key, amount, ref) {
    amount = Math.max(1, Math.ceil(Number(amount)));
    const holds = this.store.data.budgetHolds;
    if (holds[ref]) return holds[ref];
    const free = this.available(key);
    if (free < amount) throw new HttpError(402, 'budget_exhausted', `${key} has ${free} credits free (the rest are held for jobs in progress); this needs ${amount}.`);
    const hold = { key, amount, at: this.clock() };
    this.store.tx((d) => { d.budgetHolds[ref] = hold; });
    return hold;
  }

  /** The job `ref` ended having used `used`: spend that much (never more than was held or is left), free the hold. */
  settle(ref, used, reason = 'sandbox_minutes') {
    const h = this.store.data.budgetHolds[ref];
    if (!h) return 0;
    const spend = Math.max(0, Math.min(Math.ceil(Number(used)), h.amount, this.balance(h.key)));
    this.store.tx((d) => { delete d.budgetHolds[ref]; });
    if (spend > 0) this.entry(h.key, -spend, reason, ref);
    return spend;
  }

  /** The job never ran (cancelled, refused later): free the hold. */
  release(ref) {
    if (this.store.data.budgetHolds[ref]) this.store.tx((d) => { delete d.budgetHolds[ref]; });
  }
}
