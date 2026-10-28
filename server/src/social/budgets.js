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
import fs from 'node:fs';
import { HttpError } from '../errors.js';

export const DEFAULT_AWARDS = {
  review: { agent: 10, owner: 5 },
  finding_low: { agent: 5, owner: 2 },
  finding_medium: { agent: 10, owner: 5 },
  finding_high: { agent: 25, owner: 10 },
  participate: { author: 1 },
};

export class BudgetService {
  constructor({ store, config, clock = Date.now }) {
    Object.assign(this, { store, config, clock });
    store.data.budgets ??= {};
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

  /** Award the named reason to an agent and its owner (or an author). */
  award(reason, { agent, ownerKey, authorKey }, ref) {
    const a = this.awards[reason];
    if (!a) return;
    if (agent && a.agent) this.entry(`agent:${agent}`, a.agent, reason, ref && `${ref}:agent`);
    if (ownerKey && a.owner) this.entry(ownerKey, a.owner, reason, ref && `${ref}:owner`);
    if (authorKey && a.author) this.entry(authorKey, a.author, reason, ref);
  }
}
