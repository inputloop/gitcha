// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Reads the server's settings from environment variables (GITCHA_*, STRIPE_*, PAYPAL_*, NEXTTIME_*)
// and turns them into one config object. It also loads or creates the secret key that encrypts
// stored secrets. A bad setting stops the server at start-up with a clear message (StartupError).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTrustedProxies } from './http.js';

const HOUR = 3600_000;
const MINUTE = 60_000;

/** A setting or file the server cannot start with. index.js prints the message as one line and exits 1. */
export class StartupError extends Error {
  constructor(message) { super(message); this.name = 'StartupError'; }
}

// The names of the follow-up two-factor checks an admin can lock on (see auth.js checkSettings).
export const CHECK_NAMES = ['interval', 'new_network', 'sensitive'];

/**
 * Read GITCHA_LOCKED_CHECKS, a comma list of check names. A typo must stop the server. Otherwise it
 * would quietly lock nothing while /health says the check is locked (AUTH-9).
 */
export function parseLockedChecks(value) {
  const names = String(value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !CHECK_NAMES.includes(n));
  if (unknown.length) {
    throw new StartupError(`GITCHA_LOCKED_CHECKS names unknown check(s): ${unknown.join(', ')}. Valid names: ${CHECK_NAMES.join(', ')}.`);
  }
  return [...new Set(names)];
}

/** Read a time length such as "12h" or "30m" as milliseconds. A plain number means seconds. Empty uses `fallback`. */
function duration(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) throw new StartupError(`invalid duration: ${value} (use a number with ms, s, m, h or d, for example 12h)`);
  const mult = { ms: 1, s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR }[m[2] || 's'];
  return Number(m[1]) * mult;
}

/** Read a comma list as lowercase, trimmed words, skipping empty ones. */
function list(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Read a yes/no setting: 1, true, yes or on mean yes (any case); anything else means no. Empty uses `fallback`. */
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * A key is 32 bytes written in base64 (a way to write bytes as text). Anything else, such as an empty
 * or half-written file or a typo, must stop the server instead of letting it run.
 */
function checkKey(key, where) {
  if (Buffer.from(String(key), 'base64').length !== 32) {
    throw new StartupError(`${where} is not a 32-byte key in base64. Restore the key you backed up, or (only for a brand-new install) delete it so a new one is made.`);
  }
  return key;
}

/**
 * A new key over a database that already has accounts would make all of them unreadable. Their sealed
 * passwords and authenticator secrets could not be opened: known users would get 500 errors and unknown
 * ones 401s. So if db.json has accounts, or cannot be read to find out, no key is made. The operator must
 * restore the key that belongs to it (AUTH-14).
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

/**
 * Load (or create) the 32-byte key used to encrypt secrets at rest (stored on disk), such as TOTP secrets
 * (TOTP: the 6-digit codes an authenticator app shows). GITCHA_SECRET_KEY wins; otherwise <dataDir>/secret.key.
 */
function loadSecretKey(dataDir, envKey) {
  if (envKey) return checkKey(envKey, 'GITCHA_SECRET_KEY');
  const file = path.join(dataDir, 'secret.key');
  const read = () => checkKey(fs.readFileSync(file, 'utf8').trim(), file);
  if (fs.existsSync(file)) return read();
  refuseIfAccounts(dataDir, file);
  // The new key is written whole under a temporary name, then linked into place. The link fails if another
  // start got there first, and then we read that one's key. Nobody can ever read a half-written key (a second
  // start that read an empty file would have run with no key).
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

// Cassandra's consistency levels Gitcha accepts for its reads and writes.
const CONSISTENCIES = ['ONE', 'TWO', 'THREE', 'QUORUM', 'ALL', 'LOCAL_QUORUM', 'EACH_QUORUM', 'LOCAL_ONE'];

/**
 * Where the database lives (GITCHA_STORE and GITCHA_CASSANDRA_*). "file" is db.json in the data folder;
 * "cassandra" is an Apache Cassandra keyspace (store-cassandra.js). Anything unclear stops the start.
 */
export function parseStore(env) {
  const kind = String(env.GITCHA_STORE ?? 'file').trim().toLowerCase() || 'file';
  if (!['file', 'cassandra'].includes(kind)) throw new StartupError(`GITCHA_STORE must be file or cassandra, not "${env.GITCHA_STORE}".`);
  const name = (setting, value) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)) throw new StartupError(`${setting} must be a letter then up to 47 letters, digits or _ (a Cassandra name), not "${value}".`);
    return value;
  };
  const replication = String(env.GITCHA_CASSANDRA_REPLICATION ?? 'SimpleStrategy:1').trim();
  if (!/^(SimpleStrategy:\d+|NetworkTopologyStrategy:[A-Za-z0-9_-]+=\d+(,[A-Za-z0-9_-]+=\d+)*)$/.test(replication)) {
    throw new StartupError(`GITCHA_CASSANDRA_REPLICATION must look like SimpleStrategy:1 or NetworkTopologyStrategy:dc1=3,dc2=3, not "${replication}".`);
  }
  const consistency = String(env.GITCHA_CASSANDRA_CONSISTENCY ?? 'LOCAL_QUORUM').trim().toUpperCase();
  if (!CONSISTENCIES.includes(consistency)) throw new StartupError(`GITCHA_CASSANDRA_CONSISTENCY must be one of ${CONSISTENCIES.join(', ')}.`);
  const contactPoints = String(env.GITCHA_CASSANDRA_CONTACT_POINTS ?? '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'cassandra' && !contactPoints.length) throw new StartupError('GITCHA_CASSANDRA_CONTACT_POINTS is empty: name at least one Cassandra node (host or host:port).');
  return {
    kind,
    cassandra: {
      contactPoints,
      // Cassandra's own default data center name is datacenter1.
      datacenter: env.GITCHA_CASSANDRA_DATACENTER || 'datacenter1',
      keyspace: name('GITCHA_CASSANDRA_KEYSPACE', env.GITCHA_CASSANDRA_KEYSPACE || 'gitcha'),
      // Several Gitcha servers may share one keyspace, each under its own instance name.
      instance: name('GITCHA_CASSANDRA_INSTANCE', env.GITCHA_CASSANDRA_INSTANCE || 'main'),
      // Used only to create the keyspace when it does not exist yet.
      replication,
      createKeyspace: bool(env.GITCHA_CASSANDRA_CREATE_KEYSPACE, true),
      consistency,
      // Lightweight transactions (the lease) use the serial level that matches: local to the data center or not.
      serialConsistency: consistency.startsWith('LOCAL_') ? 'LOCAL_SERIAL' : 'SERIAL',
      username: env.GITCHA_CASSANDRA_USERNAME || null,
      password: env.GITCHA_CASSANDRA_PASSWORD || null,
      tls: bool(env.GITCHA_CASSANDRA_TLS, false),
      caFile: env.GITCHA_CASSANDRA_CA_FILE || null,
      timeoutMs: duration(env.GITCHA_CASSANDRA_TIMEOUT, 15_000),
    },
  };
}

/**
 * Build the config object from environment variables. `overrides` (used by tests) replace any value,
 * and nested groups such as `policy` are merged one level deep. Also creates the data folder.
 */
export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? env.GITCHA_DATA_DIR ?? './gitcha-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const publicUrl = overrides.publicUrl ?? env.GITCHA_PUBLIC_URL ?? `http://localhost:${env.GITCHA_PORT ?? 4873}`;
  const config = {
    host: env.GITCHA_HOST ?? '127.0.0.1',
    port: Number(env.GITCHA_PORT ?? 4873),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    // Turn on only behind your own reverse proxy (a server that passes requests on to this one). Then the client
    // address comes from X-Forwarded-For. GITCHA_TRUSTED_PROXIES says which proxies to trust (a hop count, default 1, or addresses).
    trustProxy: bool(env.GITCHA_TRUST_PROXY, false),
    trustedProxies: parseTrustedProxies(env.GITCHA_TRUSTED_PROXIES),
    dataDir,
    store: parseStore(env),
    secretKey: loadSecretKey(dataDir, env.GITCHA_SECRET_KEY),
    issuer: env.GITCHA_ISSUER ?? 'Gitcha',
    openRegistration: bool(env.GITCHA_OPEN_REGISTRATION, true),
    // Anonymous users may not browse or install unless explicitly allowed.
    publicRead: bool(env.GITCHA_PUBLIC_READ, false),
    maxPackageBytes: Number(env.GITCHA_MAX_PACKAGE_BYTES ?? 25 * 1024 * 1024),
    policy: {
      // Intermittent 2FA (two-factor authentication): every session or device must re-enter a TOTP code this often.
      stepUpInterval: duration(env.GITCHA_STEPUP_INTERVAL, 12 * HOUR),
      // Publishing, yanking and managing devices need a code at most this old.
      sensitiveWindow: duration(env.GITCHA_SENSITIVE_WINDOW, 10 * MINUTE),
      // A device token seen from a new network must enter a code again.
      stepUpOnNewNetwork: bool(env.GITCHA_STEPUP_ON_NEW_NETWORK, true),
      // The longest a session or device token can live, and how long it may sit unused before it ends.
      sessionMaxAge: duration(env.GITCHA_SESSION_MAX_AGE, 30 * 24 * HOUR),
      sessionIdle: duration(env.GITCHA_SESSION_IDLE, 7 * 24 * HOUR),
      // How long the password-ok ticket from login step 1 waits for the second factor.
      mfaTicketTtl: 5 * MINUTE,
      // Checks users may NOT switch off (a comma list of: interval,new_network,sensitive).
      lockedChecks: parseLockedChecks(env.GITCHA_LOCKED_CHECKS),
    },
    hosting: {
      // Domains this server hands out subdomains on, for example "pages.example.net,apps.example.org".
      // Use a domain you register separately from the Gitcha site, so user content cannot touch its cookies.
      domains: list(env.GITCHA_HOSTING_DOMAINS),
      maxSiteBytes: Number(env.GITCHA_MAX_SITE_BYTES ?? 100 * 1024 * 1024),
      keepDeploys: Number(env.GITCHA_KEEP_DEPLOYS ?? 10),
      // What custom domains should point at (the CNAME target, a DNS alias), shown to users.
      cnameTarget: env.GITCHA_HOSTING_CNAME ?? null,
    },
    compute: {
      // The container image CI steps and functions run in when they do not name one (a bContain/OCI reference).
      defaultImage: env.GITCHA_DEFAULT_IMAGE ?? 'docker.io/library/node:22-alpine',
      maxJobMs: duration(env.GITCHA_MAX_JOB_TIME, 60 * MINUTE),
      // How long an invocation may wait for a free runner before answering 503.
      queueWaitMs: duration(env.GITCHA_QUEUE_WAIT, 20_000),
      // Accept functions with runtime "orgvm" (this needs runners labelled orgvm).
      orgvm: bool(env.GITCHA_ORGVM, false),
    },
    billing: {
      // Off by default, so self-hosted servers that do not charge never see it.
      enabled: bool(env.GITCHA_BILLING, false),
      plansFile: env.GITCHA_PLANS_FILE ?? null,
      currency: env.GITCHA_CURRENCY ?? 'USD',
      // Payment secrets come only from the environment. Nothing here is ever written to disk.
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
      // Host name shown in SSH clone URLs (git@HOST:owner/name.git). If unset, SSH URLs are hidden.
      sshHost: env.GITCHA_SSH_HOST ?? null,
      // The account OpenSSH runs gitcha-git-shell as (the "git" in git@HOST:...).
      sshUser: env.GITCHA_SSH_USER ?? 'git',
      // The forced command OpenSSH runs for every Gitcha key (the only program that key may run).
      shellPath: env.GITCHA_GIT_SHELL ?? '/usr/bin/gitcha-git-shell',
    },
    social: {
      maxMediaBytes: Number(env.GITCHA_MAX_MEDIA_BYTES ?? 50 * 1024 * 1024),
    },
    budgets: {
      awardsFile: env.GITCHA_AWARDS_FILE ?? null,
    },
    nexttime: {
      // Copy project tasks into a NextTime (Nextcloud "timebank") server. Off unless url, user, appPassword and categoryId are all set.
      url: env.NEXTTIME_URL ?? null,
      user: env.NEXTTIME_USER ?? null,
      appPassword: env.NEXTTIME_APP_PASSWORD ?? null,
      categoryId: env.NEXTTIME_CATEGORY_ID ? Number(env.NEXTTIME_CATEGORY_ID) : null,
      hoursBudget: Number(env.NEXTTIME_HOURS ?? 1),
      // Complete the NextTime request when its task is done (on unless set to no, false, 0 or off).
      complete: !/^(no|false|0|off)$/i.test(env.NEXTTIME_COMPLETE ?? ''),
    },
    // How this server describes itself to other Gitcha servers in its ring (a group of linked servers).
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
    store: { ...config.store, ...overrides.store, cassandra: { ...config.store.cassandra, ...overrides.store?.cassandra } },
  };
}
