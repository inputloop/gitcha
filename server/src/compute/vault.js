// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Secret settings for CI pipelines: values a build needs but its source must not hold, like a signing key.
//
// A secret belongs to an account (a person, or a team) and has a name in capitals (APT_SIGNING_KEY). Its
// value is sealed with AES-256-GCM under a key of its own, derived from the server's secret key, and is
// never shown again: not on a page, not in the API, not in the CLI. Only names and dates are listed.
//
// A pipeline names the secrets it uses ("secrets": ["APT_SIGNING_KEY"]). A build gets them only when the
// person who started it may use the account's secrets (the person themselves, or a maintainer of the
// team), never in an agent's sandbox run. They are opened when a runner takes the job and handed to that
// runner alone; the job record keeps only their names. Logs are masked (log-mask.js).
// Changing a secret is a sensitive action: it needs a fresh two-factor code (the API checks that).
import { HttpError } from '../errors.js';
import { createSecretBox, deriveKey } from '../crypto.js';
import { SECRET_NAME_RE } from '../../../extension/lib/log-mask.js';

const MAX_VALUE = 64 * 1024; // enough for an armored GPG key or a certificate chain
const MAX_PER_ACCOUNT = 50;

export class SecretService {
  constructor({ store, teams, config, clock = Date.now }) {
    Object.assign(this, { store, teams, clock });
    this.box = createSecretBox(deriveKey(config.secretKey, 'ci-secrets').toString('base64'));
    store.data.ciSecrets ??= {};
  }

  get data() { return this.store.data.ciSecrets; }

  /** The account a request is about: the person ("user:NAME" or nothing), or "team:NAME". */
  account(user, owner) {
    if (!owner || owner === `user:${user.username}`) return { type: 'user', name: user.username };
    const m = /^team:([a-z0-9][a-z0-9_-]{1,31})$/.exec(String(owner));
    if (!m) throw new HttpError(400, 'bad_owner', 'The account is "user:NAME" (yourself) or "team:NAME".');
    return { type: 'team', name: m[1] };
  }

  key(o) { return `${o.type}:${o.name}`; }

  /** May this person use (and change) the account's secrets? Themselves, or a team's maintainers and owners. */
  mayUse(user, o) {
    if (!user || user.status !== 'active') return false;
    if (o.type === 'user') return o.name === user.username;
    const t = this.store.team(o.name);
    return Boolean(t && this.teams.has(t, user, 'maintainer'));
  }

  /** May this person see the names? The same people, and a team's plain members too. */
  maySee(user, o) {
    if (o.type === 'user') return o.name === user.username;
    const t = this.store.team(o.name);
    return Boolean(t && this.teams.has(t, user, 'member'));
  }

  list(user, owner) {
    const o = this.account(user, owner);
    if (!this.maySee(user, o)) throw new HttpError(404, 'not_found', 'No such account.');
    const all = this.data[this.key(o)] ?? {};
    return { owner: this.key(o), secrets: Object.entries(all).map(([name, s]) => ({ name, updatedAt: s.updatedAt, updatedBy: s.updatedBy })).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  set(user, owner, name, value, ip) {
    const o = this.account(user, owner);
    if (!this.mayUse(user, o)) throw new HttpError(403, 'forbidden', o.type === 'team' ? 'Only the team\'s maintainers and owners can set its secrets.' : 'You can only set your own secrets.');
    if (!SECRET_NAME_RE.test(String(name))) throw new HttpError(400, 'bad_name', 'A secret\'s name is capitals, digits and _, starting with a letter or _ (like APT_SIGNING_KEY).');
    if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'no_value', 'The secret has no value.');
    if (Buffer.byteLength(value) > MAX_VALUE) throw new HttpError(413, 'too_large', `A secret holds at most ${MAX_VALUE / 1024} KB.`);
    const k = this.key(o);
    const had = Boolean(this.data[k]?.[name]);
    if (!had && Object.keys(this.data[k] ?? {}).length >= MAX_PER_ACCOUNT) throw new HttpError(409, 'too_many', `An account holds at most ${MAX_PER_ACCOUNT} secrets.`);
    this.store.tx((d) => {
      d.ciSecrets[k] ??= {};
      d.ciSecrets[k][name] = { sealed: this.box.seal(value), updatedAt: this.clock(), updatedBy: user.username };
      this.store.audit({ userId: user.id, event: had ? 'ci.secret_changed' : 'ci.secret_added', ip, name, owner: k });
    });
    return { owner: k, name, updatedAt: this.clock() };
  }

  remove(user, owner, name, ip) {
    const o = this.account(user, owner);
    if (!this.mayUse(user, o)) throw new HttpError(403, 'forbidden', 'You cannot change these secrets.');
    const k = this.key(o);
    if (!this.data[k]?.[name]) throw new HttpError(404, 'not_found', `There is no secret ${name}.`);
    this.store.tx((d) => {
      delete d.ciSecrets[k][name];
      this.store.audit({ userId: user.id, event: 'ci.secret_removed', ip, name, owner: k });
    });
    return { owner: k, name, removed: true };
  }

  /** The names in `names` this account has no secret for. */
  missing(o, names) { return names.filter((n) => !this.data[this.key(o)]?.[n]); }

  /** Open the named secrets of an account, for a runner that has just taken a job: { NAME: value }. */
  open(o, names) {
    const out = {};
    for (const n of names) {
      const s = this.data[this.key(o)]?.[n];
      if (s) out[n] = this.box.open(s.sealed);
    }
    return out;
  }
}
