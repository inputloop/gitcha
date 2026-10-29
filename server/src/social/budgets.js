// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Budgets: credits that people and agents earn by taking part, and spend on
// the paid sandboxes. Every change is a ledger entry (a line in the account's
// history). A balance changes only by adding an entry, never by hand.
// Accounts are named like "user:alice" or "agent:alfred".
//
// Default awards (GITCHA_AWARDS_FILE replaces them):
//   a Second Reader review a maintainer accepts  review       +10 to the agent, +5 to its owner
//   a finding the project accepts                finding_*    +5 / +10 / +25 to the agent by severity (low/medium/high),
//                                                             and +2 / +5 / +10 to its owner
//   taking part (first post of a day)            participate  +1 to the author
// One credit pays for one sandbox build minute or 1,000 sandbox function invocations.
//
// Reviews and findings pay only when a maintainer accepts them, and that
// maintainer must not own the reviewing agent (TaskService checks this). What
// one person and all their agents can earn this way in a UTC day is capped
// (DAILY_CAP). So two friends cannot make credits by agreeing with each other,
// and owning many agents does not give many allowances.
//
// A sandbox job holds its credits when it is let in (reserve). When it ends,
// the meter settles what it really used. So a balance of 1 lets in one minute
// of work, not as many runs as can be queued.
//
// Stored in store.data.budgets (balance and entries per account), budgetCaps
// (what each owner earned today) and budgetHolds (credits held for jobs).
import fs from 'node:fs';
import { HttpError } from '../errors.js';

export const DEFAULT_AWARDS = {
  review: { agent: 10, owner: 5 },
  finding_low: { agent: 5, owner: 2 },
  finding_medium: { agent: 10, owner: 5 },
  finding_high: { agent: 25, owner: 10 },
  participate: { author: 1 },
};

// The most credits one person (with all their agents) may earn from reviews and findings in one UTC day.
// A careful default: five reviews' worth. The keepers can change it here or with config.budgets.dailyCap.
// CAPPED lists the award reasons that count against it.
const DAILY_CAP = 50;
const CAPPED = new Set(['review', 'finding_low', 'finding_medium', 'finding_high']);

/** Keeps credit balances, pays awards and holds credits for sandbox jobs. */
export class BudgetService {
  constructor({ store, config, clock = Date.now }) {
    Object.assign(this, { store, config, clock });
    store.data.budgets ??= {};
    store.data.budgetCaps ??= {};
    store.data.budgetHolds ??= {};
    this.dailyCap = config.budgets?.dailyCap ?? DAILY_CAP;
    this.awards = config.budgets?.awardsFile ? JSON.parse(fs.readFileSync(config.budgets.awardsFile, 'utf8')) : DEFAULT_AWARDS;
  }

  /** The account's credits now (0 if it has none yet). */
  balance(key) { return this.store.data.budgets[key]?.balance ?? 0; }

  /** The last `limit` entries, newest first. */
  ledger(key, limit = 50) { return (this.store.data.budgets[key]?.entries ?? []).slice(-limit).reverse(); }

  /**
   * Adds credits (or spends them, with a negative amount). A `ref` makes an award idempotent
   * (safe to run twice): an entry with the same ref is never added again. Spending more than
   * the balance throws 402. Only the last 500 entries are kept.
   */
  entry(key, amount, reason, ref = null) {
    const seen = this.store.data.budgets[key] ?? { balance: 0, entries: [] };
    if (ref && seen.entries.some((e) => e.ref === ref)) return seen.balance;
    if (amount < 0 && seen.balance + amount < 0) throw new HttpError(402, 'budget_exhausted', `${key} has ${seen.balance} credits; this needs ${-amount}.`);
    // A new account's record is made inside the save, so a refused spend leaves nothing behind.
    return this.store.tx((d) => {
      const b = (d.budgets[key] ??= { balance: 0, entries: [] });
      b.balance += amount;
      b.entries.push({ at: this.clock(), amount, reason, ref, balance: b.balance });
      if (b.entries.length > 500) b.entries.splice(0, b.entries.length - 500);
      return b.balance;
    });
  }

  /**
   * Pays the award for `reason` to an agent and its owner (or to a post's author). Reviews and
   * findings count against the owner's daily cap. The answer says whether it was paid, so a
   * caller can tell.
   */
  award(reason, { agent, ownerKey, authorKey }, ref) {
    const a = this.awards[reason];
    if (!a) return { paid: false };
    if (CAPPED.has(reason) && ownerKey) {
      // Already paid for this ref: do not count it against the cap a second time.
      if (ref && this.store.data.budgets[`agent:${agent}`]?.entries.some((e) => e.ref === `${ref}:agent`)) return { paid: true };
      const total = (agent && a.agent ? a.agent : 0) + (a.owner ? a.owner : 0);
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      // A new UTC day starts the count again from zero.
      const seen = this.store.data.budgetCaps[ownerKey];
      const earned = seen?.day === day ? seen.earned : 0;
      if (earned + total > this.dailyCap) return { paid: false, capped: true };
      this.store.tx((d) => { d.budgetCaps[ownerKey] = { day, earned: earned + total }; });
    }
    if (agent && a.agent) this.entry(`agent:${agent}`, a.agent, reason, ref && `${ref}:agent`);
    if (ownerKey && a.owner) this.entry(ownerKey, a.owner, reason, ref && `${ref}:owner`);
    if (authorKey && a.author) this.entry(authorKey, a.author, reason, ref);
    return { paid: true };
  }

  // ---- holds for sandbox jobs ------------------------------------------------------------------
  get holdTtl() { return 2 * (this.config.compute?.maxJobMs ?? 3600_000); } // a hold for a job that never reported back runs out after twice the longest job time

  /** Credits not held for a job in progress. A hold older than holdTtl no longer counts. */
  available(key) {
    const now = this.clock();
    const held = Object.values(this.store.data.budgetHolds).filter((h) => h.key === key && now - h.at < this.holdTtl).reduce((n, h) => n + h.amount, 0);
    return this.balance(key) - held;
  }

  /**
   * Holds `amount` credits (rounded up, at least 1) for job `ref` when it is let in. Asking
   * again for the same ref gives back the same hold. Refuses with 402 when too few credits are free.
   */
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

  /** Job `ref` ended having used `used`: spends that much (never more than was held or is left) and frees the hold. Returns what it spent. */
  settle(ref, used, reason = 'sandbox_minutes') {
    const h = this.store.data.budgetHolds[ref];
    if (!h) return 0;
    const spend = Math.max(0, Math.min(Math.ceil(Number(used)), h.amount, this.balance(h.key)));
    this.store.tx((d) => { delete d.budgetHolds[ref]; });
    if (spend > 0) this.entry(h.key, -spend, reason, ref);
    return spend;
  }

  /** The job never ran (cancelled, or refused later): frees the hold without spending anything. */
  release(ref) {
    if (this.store.data.budgetHolds[ref]) this.store.tx((d) => { delete d.budgetHolds[ref]; });
  }
}
