// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTrustedProxies } from './http.js';

const HOUR = 3600_000;
const MINUTE = 60_000;

/** A setting or file the server cannot start with: index.js prints the message as one line and exits 1. */
export class StartupError extends Error {
  constructor(message) { super(message); this.name = 'StartupError'; }
}

export const CHECK_NAMES = ['interval', 'new_network', 'sensitive'];

/** GITCHA_LOCKED_CHECKS: a typo must stop the server, not quietly lock nothing while /health says it is locked (AUTH-9). */
export function parseLockedChecks(value) {
  const names = String(value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !CHECK_NAMES.includes(n));
  if (unknown.length) {
    throw new StartupError(`GITCHA_LOCKED_CHECKS names unknown check(s): ${unknown.join(', ')}. Valid names: ${CHECK_NAMES.join(', ')}.`);
  }
  return [...new Set(names)];
}

function duration(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) throw new StartupError(`invalid duration: ${value} (use a number with ms, s, m, h or d, for example 12h)`);
  const mult = { ms: 1, s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR }[m[2] || 's'];
  return Number(m[1]) * mult;
}

function list(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/** A key is 32 bytes in base64; anything else (an empty or half-written file, a typo) must stop the server, not run it. */
function checkKey(key, where) {
  if (Buffer.from(String(key), 'base64').length !== 32) {
    throw new StartupError(`${where} is not a 32-byte key in base64. Restore the key you backed up, or (only for a brand-new install) delete it so a new one is made.`);
  }
  return key;
}

/**
 * A new key over a database that already holds accounts would make every one of them unreadable (sealed passwords
 * and authenticator secrets, 500s for known users and 401s for unknown ones). So with accounts, or with a db.json
 * that cannot be read to find out, no key is made: the operator restores the one that belongs to it (AUTH-14).
 */
function refuseIfAccounts(dataDir, file) {
  const dbFile = path.join(dataDir, 'db.json');
  if (!fs.existsSync(dbFile)) return;
  let users;
  try {
    users = Object.keys(JSON.parse(fs.readFileSync(dbFile, 'utf8')).users ?? {}).length;
  } catch (err) {
    throw new StartupError(`${dbFile} exists but cannot be read (${err.message}), and there is no ${file}. Not making a new key over it: restore db.json and its key from the same backup.`);
  }
  if (users > 0) {
    throw new StartupError(`${dbFile} holds ${users} account(s) but there is no ${file} and GITCHA_SECRET_KEY is not set. A new key would lock every account out. Restore the key that goes with this database (set GITCHA_SECRET_KEY or put it in ${file}).`);
  }
}

/** Load (or create) the 32-byte key used to encrypt TOTP secrets at rest. */
function loadSecretKey(dataDir, envKey) {
  if (envKey) return checkKey(envKey, 'GITCHA_SECRET_KEY');
  const file = path.join(dataDir, 'secret.key');
  const read = () => checkKey(fs.readFileSync(file, 'utf8').trim(), file);
  if (fs.existsSync(file)) return read();
  refuseIfAccounts(dataDir, file);
  // Written whole under a temporary name and then linked into place: link fails if another start got there first, and
  // nobody can ever read a half-written key (a second start that read an empty file would have run with no key).
  const key = crypto.randomBytes(32).toString('base64');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600, flag: 'w' });
  try {
    fs.linkSync(tmp, file);
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return read();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? env.GITCHA_DATA_DIR ?? './gitcha-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const publicUrl = overrides.publicUrl ?? env.GITCHA_PUBLIC_URL ?? `http://localhost:${env.GITCHA_PORT ?? 4873}`;
  const config = {
    host: env.GITCHA_HOST ?? '127.0.0.1',
    port: Number(env.GITCHA_PORT ?? 4873),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    // Behind your own reverse proxy only. GITCHA_TRUSTED_PROXIES says which proxies (a hop count, default 1, or addresses).
    trustProxy: bool(env.GITCHA_TRUST_PROXY, false),
    trustedProxies: parseTrustedProxies(env.GITCHA_TRUSTED_PROXIES),
    dataDir,
    secretKey: loadSecretKey(dataDir, env.GITCHA_SECRET_KEY),
    issuer: env.GITCHA_ISSUER ?? 'Gitcha',
    openRegistration: bool(env.GITCHA_OPEN_REGISTRATION, true),
    // Anonymous users may not browse or install unless explicitly allowed.
    publicRead: bool(env.GITCHA_PUBLIC_READ, false),
    maxPackageBytes: Number(env.GITCHA_MAX_PACKAGE_BYTES ?? 25 * 1024 * 1024),
    policy: {
      // Intermittent 2FA: every session/device must re-enter a TOTP code this often.
      stepUpInterval: duration(env.GITCHA_STEPUP_INTERVAL, 12 * HOUR),
      // Publishing, yanking and managing devices need a code at most this old.
      sensitiveWindow: duration(env.GITCHA_SENSITIVE_WINDOW, 10 * MINUTE),
      // A device token seen from a new network must re-verify.
      stepUpOnNewNetwork: bool(env.GITCHA_STEPUP_ON_NEW_NETWORK, true),
      // Hard lifetime and idle timeout of sessions and device tokens.
      sessionMaxAge: duration(env.GITCHA_SESSION_MAX_AGE, 30 * 24 * HOUR),
      sessionIdle: duration(env.GITCHA_SESSION_IDLE, 7 * 24 * HOUR),
      mfaTicketTtl: 5 * MINUTE,
      // Checks users may NOT switch off (comma list of: interval,new_network,sensitive).
      lockedChecks: parseLockedChecks(env.GITCHA_LOCKED_CHECKS),
    },
    hosting: {
      // Domains this instance hands out subdomains on, e.g. "pages.example.net,apps.example.org".
      // Use a registrable domain separate from the Gitcha UI so user content can't touch its cookies.
      domains: list(env.GITCHA_HOSTING_DOMAINS),
      maxSiteBytes: Number(env.GITCHA_MAX_SITE_BYTES ?? 100 * 1024 * 1024),
      keepDeploys: Number(env.GITCHA_KEEP_DEPLOYS ?? 10),
      // What custom domains should point at (CNAME target), shown to users.
      cnameTarget: env.GITCHA_HOSTING_CNAME ?? null,
    },
    compute: {
      // Image CI steps and functions run in when they don't name one (a bContain/OCI reference).
      defaultImage: env.GITCHA_DEFAULT_IMAGE ?? 'docker.io/library/node:22-alpine',
      maxJobMs: duration(env.GITCHA_MAX_JOB_TIME, 60 * MINUTE),
      // How long an invocation may wait for a free runner before answering 503.
      queueWaitMs: duration(env.GITCHA_QUEUE_WAIT, 20_000),
      // Accept functions with runtime "orgvm" (needs runners labelled orgvm).
      orgvm: bool(env.GITCHA_ORGVM, false),
    },
    billing: {
      // Off by default: self-hosted instances that don't charge never see it.
      enabled: bool(env.GITCHA_BILLING, false),
      plansFile: env.GITCHA_PLANS_FILE ?? null,
      currency: env.GITCHA_CURRENCY ?? 'USD',
      // Secrets come only from the environment; nothing here is ever written to disk.
      stripe: {
        secretKey: env.STRIPE_SECRET_KEY ?? null,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
        api: env.STRIPE_API_BASE ?? 'https://api.stripe.com',
      },
      paypal: {
        clientId: env.PAYPAL_CLIENT_ID ?? null,
        clientSecret: env.PAYPAL_CLIENT_SECRET ?? null,
        webhookId: env.PAYPAL_WEBHOOK_ID ?? null,
        api: env.PAYPAL_API_BASE ?? (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
      },
      priceIds: { stripe: { pro: env.STRIPE_PRICE_PRO ?? null, team: env.STRIPE_PRICE_TEAM ?? null }, paypal: { pro: env.PAYPAL_PLAN_PRO ?? null, team: env.PAYPAL_PLAN_TEAM ?? null } },
    },
    git: {
      // Host name shown in SSH clone URLs (git@HOST:owner/name.git); unset hides SSH URLs.
      sshHost: env.GITCHA_SSH_HOST ?? null,
      // The account OpenSSH runs gitcha-git-shell as (the "git" in git@HOST:...).
      sshUser: env.GITCHA_SSH_USER ?? 'git',
      // The forced command OpenSSH runs for every Gitcha key.
      shellPath: env.GITCHA_GIT_SHELL ?? '/usr/bin/gitcha-git-shell',
    },
    social: {
      maxMediaBytes: Number(env.GITCHA_MAX_MEDIA_BYTES ?? 50 * 1024 * 1024),
    },
    budgets: {
      awardsFile: env.GITCHA_AWARDS_FILE ?? null,
    },
    nexttime: {
      // Mirror project tasks into a NextTime (Nextcloud "timebank") instance. Off unless all are set.
      url: env.NEXTTIME_URL ?? null,
      user: env.NEXTTIME_USER ?? null,
      appPassword: env.NEXTTIME_APP_PASSWORD ?? null,
      categoryId: env.NEXTTIME_CATEGORY_ID ? Number(env.NEXTTIME_CATEGORY_ID) : null,
      hoursBudget: Number(env.NEXTTIME_HOURS ?? 1),
      // Complete the NextTime request when its task is done (on unless "no").
      complete: !/^(no|false|0|off)$/i.test(env.NEXTTIME_COMPLETE ?? ''),
    },
    ring: {
      name: env.GITCHA_RING_NAME ?? env.GITCHA_ISSUER ?? 'Gitcha',
      description: env.GITCHA_RING_DESCRIPTION ?? '',
      operator: env.GITCHA_RING_OPERATOR ?? '',
      peers: String(env.GITCHA_RING_PEERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      refresh: duration(env.GITCHA_RING_REFRESH, 6 * HOUR),
    },
  };
  return {
    ...config, ...overrides,
    policy: { ...config.policy, ...overrides.policy },
    hosting: { ...config.hosting, ...overrides.hosting },
    ring: { ...config.ring, ...overrides.ring },
    compute: { ...config.compute, ...overrides.compute },
    billing: { ...config.billing, ...overrides.billing },
    git: { ...config.git, ...overrides.git },
    nexttime: { ...config.nexttime, ...overrides.nexttime },
    social: { ...config.social, ...overrides.social },
  };
}
