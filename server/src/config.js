import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOUR = 3600_000;
const MINUTE = 60_000;

function duration(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid duration: ${value}`);
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

/** Load (or create) the 32-byte key used to encrypt TOTP secrets at rest. */
function loadSecretKey(dataDir, envKey) {
  if (envKey) return envKey;
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
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
      lockedChecks: String(env.GITCHA_LOCKED_CHECKS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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
  };
}
