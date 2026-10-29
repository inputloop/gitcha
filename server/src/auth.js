// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Accounts and sign-in: registering, setting up two-factor login (2FA: a code from an authenticator
// app on top of the password), logging in, web sessions and device tokens, and the intermittent
// ("step-up") 2FA policy that asks for a fresh code now and then. Pure logic: no HTTP in here.
// api.js and web.js call these methods; data lives in the store's users, sessions and audit lists.
import crypto from 'node:crypto';
import { hashPassword, verifyPasswordAsync, DUMMY_HASH, randomToken, sha256, createSecretBox, generateRecoveryCodes, normalizeRecoveryCode, deriveKey, hmac } from './crypto.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.js';
import { HttpError, mfaRequired } from './errors.js';
import { parseIp } from './http.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i; // 3 to 32 characters, starting with a letter or digit
const ENROLL_TTL = 30 * 60_000; // an unfinished sign-up expires after 30 minutes

/**
 * A rate limiter with a fixed window: at most `max` hits per key within `windowMs`. A key names who is
 * counted, such as an address or a user. Counts live in memory only. When it holds more than `maxKeys`
 * keys, it lets go of expired keys and keys that are not blocked, oldest first, and only then of blocked
 * ones. A flood of new keys must not wipe the counters that are doing their job.
 */
export class RateLimiter {
  constructor({ max, windowMs, clock = Date.now, maxKeys = 50_000 }) {
    Object.assign(this, { max, windowMs, clock, maxKeys, hits: new Map() });
  }
  /** Count one hit. Returns true while the key is still within its limit. */
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
  /** Shrink the map to 90% of `maxKeys` (see the class comment for the order). */
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
  /** Is the key still under its limit? Looks only, does not count a hit. */
  check(key) {
    const e = this.hits.get(key);
    return !e || this.clock() - e.start > this.windowMs || e.count < this.max;
  }
  /** Take back one hit (an attempt that turned out to be fine). */
  refund(key) {
    const e = this.hits.get(key);
    if (e && e.count > 0) e.count--;
  }
  /** Forget the key's count (for example, after a correct password). */
  reset(key) { this.hits.delete(key); }
}

/**
 * A limiter key for an address: an IPv4 address as it is, an IPv6 one by its /64 (its first 64 bits, which
 * usually belong to one household or one rented host, who can easily get many addresses inside it).
 */
function addressKey(ip) {
  const p = parseIp(ip);
  if (!p) return String(ip ?? 'unknown');
  return p.v4 ? p.text : Array.from(p.bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('') + '/64';
}

/**
 * A rough network identity: the IPv4 /24 (first three numbers) or the IPv6 /48 (first three groups). It is
 * built from the parsed address, so every spelling of one network gives the same answer (AUTH-17).
 */
export function networkOf(ip = '') {
  const p = parseIp(ip);
  if (!p) return String(ip || 'unknown');
  if (p.v4) return p.text.split('.').slice(0, 3).join('.') + '.0/24';
  const groups = [0, 1, 2].map((i) => ((p.bytes[i * 2] << 8) | p.bytes[i * 2 + 1]).toString(16));
  return `${groups.join(':')}::/48`;
}

/** Accounts, login, sessions and the 2FA policy. One instance per server, made in app.js. */
export class AuthService {
  constructor({ store, config, clock = Date.now }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.box = createSecretBox(config.secretKey);
    this.recoveryKey = deriveKey(config.secretKey, 'recovery codes v1');
    this.tickets = new Map(); // logins whose password was right, waiting for the second factor (memory only)
    const lim = (max, mins) => new RateLimiter({ max, windowMs: mins * 60_000, clock });
    this.loginLimiter = lim(10, 15); // wrong passwords per address and username
    this.ipLimiter = lim(30, 15); // wrong passwords per address, whatever the username: checked before any scrypt
    this.mfaLimiter = lim(6, 15); // wrong second-factor guesses per user and network
    this.noted = lim(1, 15); // one 'rate limited' audit row per user per window, so a flood cannot refill the log
    this.registerLimiter = lim(5, 60); // sign-ups per address per hour
  }

  // ---- registration & enrollment -----------------------------------------

  /**
   * Remove sign-ups that never finished (older than the 30-minute enrolment window) together with their
   * enrolment sessions, and sessions past their life or idle limit (AUTH-15, AUTH-19). Called before a sign-up
   * is judged and by the server's sweeper. It writes only when there is something to remove.
   * Returns how many users and sessions it removed.
   */
  sweep() {
    const now = this.clock();
    const { users, sessions } = this.store.data;
    const staleUsers = Object.values(users).filter((u) => u.status === 'pending_mfa' && now - u.createdAt > ENROLL_TTL).map((u) => u.id);
    const staleSessions = Object.entries(sessions)
      .filter(([, s]) => staleUsers.includes(s.userId) || s.expiresAt < now || (s.kind !== 'enroll' && now - s.lastSeen > this.config.policy.sessionIdle))
      .map(([hash]) => hash);
    if (!staleUsers.length && !staleSessions.length) return 0;
    this.store.tx((d) => {
      for (const id of staleUsers) delete d.users[id];
      for (const hash of staleSessions) delete d.sessions[hash];
    });
    return staleUsers.length + staleSessions.length;
  }

  /**
   * Start a sign-up. Checks the name and password, then makes a 'pending_mfa' user and a short-lived
   * enrolment token. The account works only after confirmEnrollment proves the authenticator app works.
   * Returns the new TOTP secret and its otpauth link so the page can show a QR code.
   */
  register({ username, password, confirm, email, emailConfirm, ip }) {
    this.sweep();
    // With registration closed, only the very first account may sign up. An unfinished first sign-up no longer
    // strands a closed server: once it has expired, sweep() removes it (PROD-3).
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
    // A name with an unfinished sign-up is not taken over (AUTH-15). The person who started it can still finish in the
    // browser that holds the enrolment link. Anyone else waits for it to expire (a keepers' choice: refuse, not replace).
    const existing = this.store.userByName(username);
    if (existing && existing.status === 'active') throw new HttpError(409, 'username_taken', 'That username is taken.');
    if (existing) throw new HttpError(409, 'username_pending', 'That username has a sign-up that is not finished. Finish it in the browser where you started, or try again in 30 minutes.');

    const secret = generateSecret();
    const now = this.clock();
    const user = {
      id: crypto.randomUUID(),
      username,
      // A scrypt hash, then sealed with AES-256-GCM (encrypted with the server key). The database alone is useless to an attacker.
      passwordHash: this.box.seal(hashPassword(password)),
      totpSecret: this.box.seal(secret),
      // Optional; encrypted like the other personal secrets.
      email: sealedEmail,
      totpLastStep: -1,
      status: 'pending_mfa',
      role: this.store.userCount() === 0 ? 'admin' : 'user', // the first person on a server; never inherited from an earlier record of the same name
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

  /** The user's email in plain text, or null. */
  emailOf(user) { return user.email ? this.box.open(user.email) : null; }

  /** Add, change or (with both fields empty) remove the account's email. */
  updateEmail(user, { email, emailConfirm }, ip) {
    const sealed = this.sealEmail(email, emailConfirm);
    this.store.tx((d) => {
      d.users[user.id].email = sealed;
      this.store.audit({ userId: user.id, event: sealed ? 'account.email_changed' : 'account.email_removed', ip });
    });
  }

  /** The otpauth:// link for the user's authenticator secret. */
  otpauthFor(user, secret = this.box.open(user.totpSecret)) {
    return otpauthUrl({ secret, account: user.username, issuer: this.config.issuer });
  }

  /** The unfinished sign-up an enrolment token belongs to, or null if the token is unknown, used up or expired. */
  enrollmentFor(token) {
    const s = this.store.sessionByHash(sha256(token ?? ''));
    if (!s || s.kind !== 'enroll' || s.expiresAt < this.clock()) return null;
    const user = this.store.userById(s.userId);
    if (!user || user.status !== 'pending_mfa') return null;
    const secret = this.box.open(user.totpSecret);
    return { user, secret, otpauth: this.otpauthFor(user, secret) };
  }

  /**
   * Confirm the authenticator app works by checking one code. This activates the account, makes its
   * recovery codes (returned once, stored only as keyed hashes) and uses up the enrolment token.
   */
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
      Object.assign(d.users[user.id], { status: 'active', totpLastStep: step, recoveryCodes: codes.map((c) => this.recoveryHash(c)), activatedAt: this.clock() });
      delete d.sessions[sha256(enrollToken)];
      this.store.audit({ userId: user.id, event: 'account.activated', ip });
    });
    this.mfaLimiter.reset(lockKey);
    return { user: this.store.userById(user.id), recoveryCodes: codes };
  }

  // ---- second-factor verification ----------------------------------------

  /** How a recovery code is stored: an HMAC under a key made from the server key, never the code itself. */
  recoveryHash(normalized) { return `hm1.${hmac(this.recoveryKey, normalized)}`; }

  /** The second-factor lock is per user and per network (AUTH-6). A stranger's guesses lock out the stranger, not the owner. */
  mfaKey(user, ip) { return `mfa:${user.id}:${networkOf(ip)}`; }

  /**
   * Check a second factor: a 6-digit TOTP code (a code cannot be used twice) or a recovery code (used up
   * once it works). Returns 'totp' or 'recovery'. Throws 401 for a wrong code, 429 when locked out.
   */
  verifySecondFactor(user, code, ip) {
    // The lock is checked before the guess is looked at, so a locked network gets no answer, right or wrong.
    // Only wrong guesses count toward the lock.
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
    } else if (normalizeRecoveryCode(code)) {
      // Stored as a keyed hash (using the server key). The 40-bit codes issued before are plain SHA-256 and work until
      // the user makes new ones.
      const normalized = normalizeRecoveryCode(code);
      const h = [this.recoveryHash(normalized), sha256(normalized)].find((x) => user.recoveryCodes.includes(x));
      if (h) {
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

  /** Write at most one 'rate limited' audit row per user per window (AUTH-19), so the refusals themselves cannot refill the log. */
  noteRateLimited(user, ip, what) {
    if (!user || !this.noted.hit(`${what}:${user.id}`)) return;
    this.store.tx(() => this.store.audit({ userId: user.id, event: 'login.rate_limited', ip, what }));
  }

  // ---- login --------------------------------------------------------------

  /**
   * Login step 1: the password. Returns a short-lived ticket (5 minutes by default) to use with the second
   * factor in completeLogin. An unknown name and a wrong password give the same error and take the same time.
   */
  async beginLogin({ username, password, ip }) {
    const who = String(username ?? '').toLowerCase();
    const key = `login:${ip}:${who}`;
    const ipKey = `ip:${addressKey(ip)}`;
    // Both caps are checked before any scrypt runs (AUTH-7), so a refused attempt costs the server nothing.
    if (!this.loginLimiter.check(key) || !this.ipLimiter.check(ipKey)) {
      this.noteRateLimited(this.store.userByName(username ?? ''), ip, 'password');
      throw new HttpError(429, 'rate_limited', 'Too many login attempts. Wait 15 minutes.');
    }
    // The attempt is counted before the await, so a burst of parallel requests cannot all slip under the cap.
    // A correct password takes the count back below.
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
      throw new HttpError(403, 'mfa_not_enrolled', 'This account has not finished two-factor setup. Finish it in the browser where you started, or register again once it has expired (30 minutes).');
    }
    const ticket = randomToken('gtt_');
    this.pruneTickets();
    this.tickets.set(sha256(ticket), { userId: user.id, expiresAt: this.clock() + this.config.policy.mfaTicketTtl, attempts: 0 });
    return { ticket, user };
  }

  /** Drop expired login tickets. */
  pruneTickets() {
    const now = this.clock();
    for (const [k, t] of this.tickets) if (t.expiresAt < now) this.tickets.delete(k);
  }

  /**
   * Login step 2: the second factor. Creates a web session or a device token. A ticket allows 5 wrong
   * codes; after that it is thrown away and the login must start again with the password.
   */
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

  /**
   * Make a new session token and store only its SHA-256 hash, so a copy of the database cannot be used
   * to log in. 'web' sessions start with gtw_, device tokens with gtd_. The plain token is returned once.
   */
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

  /**
   * Look up the session for a bearer or cookie token. Returns null for unknown, expired or idle tokens,
   * and for enrolment tokens. Notes whether the request comes from a network this session has not used.
   * It saves lastSeen at most once a minute (or when the address changes) to avoid a disk write per request.
   */
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
   * Per-user switches for the checks that happen *after* install or first login. Signing in always needs a
   * code; these only control the follow-up checks. Checks the admin locked are always on.
   */
  checkSettings(user) {
    const { policy } = this.config;
    const s = { interval: true, new_network: policy.stepUpOnNewNetwork, sensitive: true, ...(user.mfaChecks ?? {}) };
    for (const k of policy.lockedChecks) s[k] = true;
    return { ...s, locked: [...policy.lockedChecks], intervalMs: policy.stepUpInterval };
  }

  /** Check a requested change to the follow-up checks. Returns what the user's settings would become; saves nothing. */
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

  /** Save new follow-up check settings. The caller must have spent a code for it first: see changeChecks. */
  updateCheckSettings(user, changes, ip) {
    const next = this.planCheckChanges(user, changes);
    this.store.tx((d) => {
      d.users[user.id].mfaChecks = next;
      this.store.audit({ userId: user.id, event: 'mfa.checks_updated', ip, checks: next });
    });
    return this.checkSettings(this.store.userById(user.id));
  }

  /**
   * Check a code sent with ONE request: it is asked for, checked and used up there. Unlike a step-up, it opens
   * no time window for other work, so a code typed for some other reason cannot be spent on this (AUTH-4 / EXT-3).
   * `what` names the action in the error message.
   */
  confirmAction(auth, code, ip, what) {
    if (String(code ?? '').trim() === '') {
      throw mfaRequired('sensitive_action', `${what} needs a code from your authenticator app, sent with this request.`);
    }
    this.verifySecondFactor(auth.user, code, ip);
  }

  /**
   * Change the follow-up checks. The code must be in the request (a missing code is asked for first). The
   * change itself is checked before the code, so a bad request does not use up a code.
   */
  changeChecks(auth, { changes, code }, ip) {
    if (String(code ?? '').trim() === '') this.confirmAction(auth, code, ip, 'Changing security settings');
    this.planCheckChanges(auth.user, changes);
    this.confirmAction(auth, code, ip, 'Changing security settings');
    return this.updateCheckSettings(auth.user, changes, ip);
  }

  /**
   * Decide whether the caller must re-enter a 2FA code. Returns { ok: true, ... } or { ok: false, reason }.
   * `fresh` (in ms) asks for a more recent code, for sensitive actions.
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

  /** Like mfaState, but always demands a code within the sensitive window, whatever the user's switches say. */
  requireFreshMfa(auth) {
    if (this.clock() - (auth.session.mfaAt ?? 0) > this.config.policy.sensitiveWindow) {
      throw mfaRequired('sensitive_action', 'Changing security settings needs a fresh code from your authenticator app.');
    }
  }

  /** Throw an 'mfa_required' error (with a reason and a friendly message) unless mfaState says ok. */
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

  /**
   * Re-check 2FA for an existing session (the intermittent check). On success it resets the session's
   * code time and adds the current network to the session's known networks (up to the last 10).
   */
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

  /** End a session (log out or remove a device). `actor` is the username who did it, for the audit log. */
  revoke(hash, actor, ip) {
    this.store.tx((d) => {
      const s = d.sessions[hash];
      if (!s) return;
      delete d.sessions[hash];
      this.store.audit({ userId: s.userId, event: 'session.revoked', ip, name: s.name, by: actor });
    });
  }

  /** Replace all of a user's recovery codes with new ones. The old ones stop working. Returns the new codes once. */
  regenerateRecoveryCodes(user, ip) {
    const codes = generateRecoveryCodes();
    this.store.tx((d) => {
      d.users[user.id].recoveryCodes = codes.map((c) => this.recoveryHash(c));
      this.store.audit({ userId: user.id, event: 'mfa.recovery_codes_regenerated', ip });
    });
    return codes;
  }
}
