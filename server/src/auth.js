// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Accounts, two-factor enrollment, login, sessions/device tokens and the
// intermittent ("step-up") 2FA policy. Pure logic: no HTTP in here.
import crypto from 'node:crypto';
import { hashPassword, verifyPasswordAsync, DUMMY_HASH, randomToken, sha256, createSecretBox, generateRecoveryCodes } from './crypto.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.js';
import { HttpError, mfaRequired } from './errors.js';
import { parseIp } from './http.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;
const ENROLL_TTL = 30 * 60_000;

/**
 * Fixed-window limiter: at most `max` hits per key within `windowMs`. When it holds more than `maxKeys` keys it
 * lets go of expired keys and keys that are not blocked, oldest first, and only then of blocked ones: a flood of
 * new keys must not wipe the counters that are doing their job.
 */
export class RateLimiter {
  constructor({ max, windowMs, clock = Date.now, maxKeys = 50_000 }) {
    Object.assign(this, { max, windowMs, clock, maxKeys, hits: new Map() });
  }
  hit(key) {
    const now = this.clock();
    let e = this.hits.get(key);
    if (!e || now - e.start > this.windowMs) e = { start: now, count: 0 };
    e.count++;
    this.hits.delete(key); // re-insert, so the Map stays in order of last use
    this.hits.set(key, e);
    if (this.hits.size > this.maxKeys) this.evict(now);
    return e.count <= this.max;
  }
  evict(now) {
    const target = Math.floor(this.maxKeys * 0.9);
    for (const [k, e] of this.hits) {
      if (this.hits.size <= target) return;
      if (now - e.start > this.windowMs || e.count < this.max) this.hits.delete(k);
    }
    for (const k of this.hits.keys()) { // still too many, all of them blocked: the oldest go
      if (this.hits.size <= target) return;
      this.hits.delete(k);
    }
  }
  check(key) {
    const e = this.hits.get(key);
    return !e || this.clock() - e.start > this.windowMs || e.count < this.max;
  }
  /** Take back one hit (an attempt that turned out to be fine). */
  refund(key) {
    const e = this.hits.get(key);
    if (e && e.count > 0) e.count--;
  }
  reset(key) { this.hits.delete(key); }
}

/** A limiter key for an address: an IPv4 address as it is, an IPv6 one by its /64 (one household or one rented host). */
function addressKey(ip) {
  const p = parseIp(ip);
  if (!p) return String(ip ?? 'unknown');
  return p.v4 ? p.text : Array.from(p.bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('') + '/64';
}

/** Coarse network identity: IPv4 /24 or IPv6 /48. */
export function networkOf(ip = '') {
  ip = ip.replace(/^::ffff:/, '');
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  return ip || 'unknown';
}

export class AuthService {
  constructor({ store, config, clock = Date.now }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.box = createSecretBox(config.secretKey);
    this.tickets = new Map(); // password-ok, awaiting second factor
    const lim = (max, mins) => new RateLimiter({ max, windowMs: mins * 60_000, clock });
    this.loginLimiter = lim(10, 15); // wrong passwords per address and username
    this.ipLimiter = lim(30, 15); // wrong passwords per address, whatever the username: checked before any scrypt
    this.mfaLimiter = lim(6, 15); // wrong second-factor guesses per user and network
    this.noted = lim(1, 15); // one 'rate limited' audit row per user per window, so a flood cannot refill the log
    this.registerLimiter = lim(5, 60);
  }

  // ---- registration & enrollment -----------------------------------------

  register({ username, password, confirm, email, emailConfirm, ip }) {
    if (!this.config.openRegistration && this.store.userCount() > 0) {
      throw new HttpError(403, 'registration_closed', 'Registration is closed on this server.');
    }
    if (!this.registerLimiter.hit(`reg:${ip}`)) throw new HttpError(429, 'rate_limited', 'Too many sign-ups from this address.');
    username = String(username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'bad_username', 'Usernames are 3-32 characters: letters, digits, "-" and "_".');
    }
    if (typeof password !== 'string' || password.length < 10) {
      throw new HttpError(400, 'weak_password', 'Passwords must be at least 10 characters.');
    }
    if (password.toLowerCase().includes(username.toLowerCase())) {
      throw new HttpError(400, 'weak_password', 'Your password must not contain your username.');
    }
    if (confirm !== undefined && confirm !== password) throw new HttpError(400, 'password_mismatch', 'The passwords do not match.');
    const sealedEmail = this.sealEmail(email, emailConfirm);
    if (this.store.team(username.toLowerCase()) || this.store.data.agents?.[username.toLowerCase()]) throw new HttpError(409, 'username_taken', 'That name belongs to a team or an agent.');
    const existing = this.store.userByName(username);
    if (existing && existing.status === 'active') throw new HttpError(409, 'username_taken', 'That username is taken.');

    const secret = generateSecret();
    const now = this.clock();
    const user = {
      id: existing?.id ?? crypto.randomUUID(),
      username,
      // scrypt hash, then sealed with AES-256-GCM: the DB alone is useless to an attacker.
      passwordHash: this.box.seal(hashPassword(password)),
      totpSecret: this.box.seal(secret),
      // Optional; encrypted like the other personal secrets.
      email: sealedEmail,
      totpLastStep: -1,
      status: 'pending_mfa',
      role: this.store.userCount() === 0 || existing?.role === 'admin' ? 'admin' : 'user',
      recoveryCodes: [],
      createdAt: now,
    };
    const token = randomToken('gte_');
    this.store.tx((d) => {
      d.users[user.id] = user;
      d.sessions[sha256(token)] = { userId: user.id, kind: 'enroll', createdAt: now, lastSeen: now, mfaAt: null, expiresAt: now + ENROLL_TTL };
    });
    return { user, enrollToken: token, secret, otpauth: this.otpauthFor(user, secret) };
  }

  /** Check an optional email and its confirmation; returns it sealed, or null when none was given. */
  sealEmail(email, emailConfirm) {
    const e = String(email ?? '').trim();
    const c = String(emailConfirm ?? '').trim();
    if (!e && !c) return null;
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'bad_email', 'That email address does not look right.');
    if (e.toLowerCase() !== c.toLowerCase()) throw new HttpError(400, 'email_mismatch', 'The email addresses do not match.');
    return this.box.seal(e);
  }

  emailOf(user) { return user.email ? this.box.open(user.email) : null; }

  /** Add, change or (with both fields empty) remove the account's email. */
  updateEmail(user, { email, emailConfirm }, ip) {
    const sealed = this.sealEmail(email, emailConfirm);
    this.store.tx((d) => {
      d.users[user.id].email = sealed;
      this.store.audit({ userId: user.id, event: sealed ? 'account.email_changed' : 'account.email_removed', ip });
    });
  }

  otpauthFor(user, secret = this.box.open(user.totpSecret)) {
    return otpauthUrl({ secret, account: user.username, issuer: this.config.issuer });
  }

  enrollmentFor(token) {
    const s = this.store.sessionByHash(sha256(token ?? ''));
    if (!s || s.kind !== 'enroll' || s.expiresAt < this.clock()) return null;
    const user = this.store.userById(s.userId);
    if (!user || user.status !== 'pending_mfa') return null;
    const secret = this.box.open(user.totpSecret);
    return { user, secret, otpauth: this.otpauthFor(user, secret) };
  }

  /** Confirm the authenticator app works; activates the account. */
  confirmEnrollment({ enrollToken, code, ip }) {
    const enrollment = this.enrollmentFor(enrollToken);
    if (!enrollment) throw new HttpError(400, 'enrollment_expired', 'This enrollment link has expired. Please register again.');
    const { user, secret } = enrollment;
    const lockKey = this.mfaKey(user, ip);
    if (!this.mfaLimiter.check(lockKey)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait 15 minutes.');
    const step = verifyTotp(secret, code, { now: this.clock(), lastStep: user.totpLastStep });
    if (step === null) {
      this.mfaLimiter.hit(lockKey); // only wrong guesses count
      throw new HttpError(400, 'bad_code', 'That code is not valid. Check the time on your phone and try again.');
    }
    const codes = generateRecoveryCodes();
    this.store.tx((d) => {
      Object.assign(d.users[user.id], { status: 'active', totpLastStep: step, recoveryCodes: codes.map((c) => sha256(c)), activatedAt: this.clock() });
      delete d.sessions[sha256(enrollToken)];
      this.store.audit({ userId: user.id, event: 'account.activated', ip });
    });
    this.mfaLimiter.reset(lockKey);
    return { user: this.store.userById(user.id), recoveryCodes: codes };
  }

  // ---- second-factor verification ----------------------------------------

  /** The second-factor lock is per user and per network (AUTH-6): a stranger's guesses lock the stranger, not the owner. */
  mfaKey(user, ip) { return `mfa:${user.id}:${networkOf(ip)}`; }

  /** Verify a TOTP code (replay-protected) or consume a recovery code. */
  verifySecondFactor(user, code, ip) {
    // Checked before the guess is looked at: a locked network gets no answer, right or wrong. Only wrong guesses count.
    const lockKey = this.mfaKey(user, ip);
    if (!this.mfaLimiter.check(lockKey)) {
      this.noteRateLimited(user, ip, 'mfa');
      throw new HttpError(429, 'rate_limited', 'Too many two-factor attempts from this network. Wait 15 minutes.');
    }
    code = String(code ?? '').trim().toLowerCase().replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(this.box.open(user.totpSecret), code, { now: this.clock(), lastStep: user.totpLastStep });
      if (step !== null) {
        this.store.tx((d) => { d.users[user.id].totpLastStep = step; });
        this.mfaLimiter.reset(lockKey);
        return 'totp';
      }
    } else if (/^[a-f0-9]{5}-?[a-f0-9]{5}$/.test(code)) {
      const normalized = code.includes('-') ? code : `${code.slice(0, 5)}-${code.slice(5)}`;
      const h = sha256(normalized);
      if (user.recoveryCodes.includes(h)) {
        this.store.tx((d) => {
          d.users[user.id].recoveryCodes = d.users[user.id].recoveryCodes.filter((x) => x !== h);
          this.store.audit({ userId: user.id, event: 'mfa.recovery_code_used', ip, remaining: d.users[user.id].recoveryCodes.length });
        });
        this.mfaLimiter.reset(lockKey);
        return 'recovery';
      }
    }
    this.mfaLimiter.hit(lockKey);
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'mfa.failed', ip }));
    throw new HttpError(401, 'bad_code', 'That two-factor code is not valid.');
  }

  /** One 'rate limited' row per user per window (AUTH-19): the refusals themselves must not refill the log. */
  noteRateLimited(user, ip, what) {
    if (!user || !this.noted.hit(`${what}:${user.id}`)) return;
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'login.rate_limited', ip, what }));
  }

  // ---- login --------------------------------------------------------------

  /** Step 1: password. Returns a short-lived ticket for the second factor. */
  async beginLogin({ username, password, ip }) {
    const who = String(username ?? '').toLowerCase();
    const key = `login:${ip}:${who}`;
    const ipKey = `ip:${addressKey(ip)}`;
    // Both caps are looked at before any scrypt runs (AUTH-7): a refused attempt costs the server nothing.
    if (!this.loginLimiter.check(key) || !this.ipLimiter.check(ipKey)) {
      this.noteRateLimited(this.store.userByName(username ?? ''), ip, 'password');
      throw new HttpError(429, 'rate_limited', 'Too many login attempts. Wait 15 minutes.');
    }
    // The attempt is counted before the await, so a burst of parallel requests cannot all slip under the cap; a
    // correct password takes the count back below.
    this.loginLimiter.hit(key);
    this.ipLimiter.hit(ipKey);
    const user = this.store.userByName(username ?? '');
    const ok = await verifyPasswordAsync(String(password ?? ''), user ? this.box.open(user.passwordHash) : DUMMY_HASH);
    if (!user || !ok) {
      if (user) this.store.tx(() => this.store.audit({ userId: user.id, event: 'login.bad_password', ip }));
      throw new HttpError(401, 'bad_credentials', 'Incorrect username or password.');
    }
    this.loginLimiter.reset(key);
    this.ipLimiter.refund(ipKey);
    if (user.status !== 'active') {
      throw new HttpError(403, 'mfa_not_enrolled', 'This account has not finished two-factor setup. Register again to restart setup.');
    }
    const ticket = randomToken('gtt_');
    this.pruneTickets();
    this.tickets.set(sha256(ticket), { userId: user.id, expiresAt: this.clock() + this.config.policy.mfaTicketTtl, attempts: 0 });
    return { ticket, user };
  }

  pruneTickets() {
    const now = this.clock();
    for (const [k, t] of this.tickets) if (t.expiresAt < now) this.tickets.delete(k);
  }

  /** Step 2: second factor. Creates a web session or a device token. */
  completeLogin({ ticket, code, kind = 'device', name, ip, userAgent }) {
    const th = sha256(String(ticket ?? ''));
    const t = this.tickets.get(th);
    if (!t || t.expiresAt < this.clock()) {
      this.tickets.delete(th);
      throw new HttpError(401, 'ticket_expired', 'Your login has expired. Start again with your password.');
    }
    const user = this.store.userById(t.userId);
    try {
      this.verifySecondFactor(user, code, ip);
    } catch (err) {
      if (++t.attempts >= 5) this.tickets.delete(th);
      throw err;
    }
    this.tickets.delete(th);
    return this.createSession(user, { kind, name, ip, userAgent });
  }

  createSession(user, { kind, name, ip, userAgent }) {
    const now = this.clock();
    const token = randomToken(kind === 'web' ? 'gtw_' : 'gtd_');
    const record = {
      userId: user.id, kind, name: (name || (kind === 'web' ? 'Web browser' : 'Device')).slice(0, 80),
      createdAt: now, lastSeen: now, mfaAt: now, lastIp: ip, networks: [networkOf(ip)],
      userAgent: String(userAgent ?? '').slice(0, 200), expiresAt: now + this.config.policy.sessionMaxAge,
    };
    this.store.tx((d) => {
      d.sessions[sha256(token)] = record;
      this.store.audit({ userId: user.id, event: kind === 'web' ? 'login.web' : 'device.created', ip, name: record.name });
    });
    return { token, session: record, user };
  }

  // ---- authenticating requests & the intermittent 2FA policy -------------

  /** Resolve a bearer/cookie token. Returns null for unknown/expired tokens. */
  authenticate(token, ip) {
    if (!token) return null;
    const hash = sha256(token);
    const session = this.store.sessionByHash(hash);
    const now = this.clock();
    if (!session || session.kind === 'enroll') return null;
    if (session.expiresAt < now || now - session.lastSeen > this.config.policy.sessionIdle) {
      this.store.tx((d) => { delete d.sessions[hash]; });
      return null;
    }
    const user = this.store.userById(session.userId);
    if (!user || user.status !== 'active') return null;
    const net = networkOf(ip);
    const newNetwork = !session.networks.includes(net);
    if (now - session.lastSeen > 60_000 || session.lastIp !== ip) {
      this.store.tx((d) => Object.assign(d.sessions[hash], { lastSeen: now, lastIp: ip }));
    }
    return { user, session, hash, network: net, newNetwork };
  }

  /**
   * Per-user switches for the checks that happen *after* install / first login.
   * Signing in always needs a code; these only govern the follow-up checks.
   */
  checkSettings(user) {
    const { policy } = this.config;
    const s = { interval: true, new_network: policy.stepUpOnNewNetwork, sensitive: true, ...(user.mfaChecks ?? {}) };
    for (const k of policy.lockedChecks) s[k] = true;
    return { ...s, locked: [...policy.lockedChecks], intervalMs: policy.stepUpInterval };
  }

  /** Validate a requested change to the follow-up checks; returns what the user's settings would become. */
  planCheckChanges(user, changes) {
    const allowed = ['interval', 'new_network', 'sensitive'];
    const next = { ...(user.mfaChecks ?? {}) };
    for (const [k, v] of Object.entries(changes ?? {})) {
      if (!allowed.includes(k)) throw new HttpError(400, 'bad_setting', `Unknown check "${k}". Use: ${allowed.join(', ')}.`);
      if (typeof v !== 'boolean') throw new HttpError(400, 'bad_setting', `"${k}" must be true or false.`);
      if (!v && this.config.policy.lockedChecks.includes(k)) {
        throw new HttpError(403, 'check_locked', `Your administrator requires the "${k}" check; it cannot be turned off.`);
      }
      next[k] = v;
    }
    return next;
  }

  /** Toggle follow-up checks. The caller must have spent a code for it: see changeChecks. */
  updateCheckSettings(user, changes, ip) {
    const next = this.planCheckChanges(user, changes);
    this.store.tx((d) => {
      d.users[user.id].mfaChecks = next;
      this.store.audit({ userId: user.id, event: 'mfa.checks_updated', ip, checks: next });
    });
    return this.checkSettings(this.store.userById(user.id));
  }

  /**
   * A code sent with ONE request: asked for, checked and used up there. Unlike a step-up it opens no window for
   * other work, so a code typed for some other reason cannot be spent on this (AUTH-4 / EXT-3).
   */
  confirmAction(auth, code, ip, what) {
    if (String(code ?? '').trim() === '') {
      throw mfaRequired('sensitive_action', `${what} needs a code from your authenticator app, sent with this request.`);
    }
    this.verifySecondFactor(auth.user, code, ip);
  }

  /** Change the follow-up checks: the code must be in the request; a bad request spends none. */
  changeChecks(auth, { changes, code }, ip) {
    if (String(code ?? '').trim() === '') this.confirmAction(auth, code, ip, 'Changing security settings');
    this.planCheckChanges(auth.user, changes);
    this.confirmAction(auth, code, ip, 'Changing security settings');
    return this.updateCheckSettings(auth.user, changes, ip);
  }

  /**
   * Decide whether the caller must re-enter a 2FA code.
   * `fresh` (ms) tightens the window for sensitive actions.
   */
  mfaState(auth, { fresh } = {}) {
    const { policy } = this.config;
    const checks = this.checkSettings(auth.user);
    const age = this.clock() - (auth.session.mfaAt ?? 0);
    if (fresh !== undefined && checks.sensitive && age > fresh) return { ok: false, reason: 'sensitive_action' };
    if (checks.interval && age > policy.stepUpInterval) return { ok: false, reason: 'interval' };
    if (checks.new_network && auth.newNetwork) return { ok: false, reason: 'new_network' };
    return { ok: true, nextCheckAt: checks.interval ? (auth.session.mfaAt ?? 0) + policy.stepUpInterval : null, checks };
  }

  /** Like mfaState, but always demands a fresh code regardless of user toggles. */
  requireFreshMfa(auth) {
    if (this.clock() - (auth.session.mfaAt ?? 0) > this.config.policy.sensitiveWindow) {
      throw mfaRequired('sensitive_action', 'Changing security settings needs a fresh code from your authenticator app.');
    }
  }

  requireMfa(auth, opts) {
    const state = this.mfaState(auth, opts);
    if (!state.ok) {
      const messages = {
        interval: 'It has been a while: please confirm it is you with a code from your authenticator app.',
        new_network: 'This device is connecting from a new network: please confirm with a code from your authenticator app.',
        sensitive_action: 'This action is sensitive: please confirm with a fresh code from your authenticator app.',
      };
      throw mfaRequired(state.reason, messages[state.reason]);
    }
    return state;
  }

  /** Re-verify 2FA for an existing session (the intermittent check). */
  stepUp(auth, code, ip) {
    const method = this.verifySecondFactor(auth.user, code, ip);
    const now = this.clock();
    this.store.tx((d) => {
      const s = d.sessions[auth.hash];
      s.mfaAt = now;
      if (!s.networks.includes(auth.network)) s.networks = [...s.networks.slice(-9), auth.network];
      this.store.audit({ userId: auth.user.id, event: 'mfa.step_up', ip, session: s.name, method });
    });
    auth.session = this.store.sessionByHash(auth.hash);
    auth.newNetwork = false;
    return { method, nextCheckAt: now + this.config.policy.stepUpInterval };
  }

  revoke(hash, actor, ip) {
    this.store.tx((d) => {
      const s = d.sessions[hash];
      if (!s) return;
      delete d.sessions[hash];
      this.store.audit({ userId: s.userId, event: 'session.revoked', ip, name: s.name, by: actor });
    });
  }

  regenerateRecoveryCodes(user, ip) {
    const codes = generateRecoveryCodes();
    this.store.tx((d) => {
      d.users[user.id].recoveryCodes = codes.map((c) => sha256(c));
      this.store.audit({ userId: user.id, event: 'mfa.recovery_codes_regenerated', ip });
    });
    return codes;
  }
}
