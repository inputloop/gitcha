// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The medic's own settings (GITCHA_MEDIC_*, from /etc/inputloop/gitcha/medic.env and the environment), and the
// Gitcha settings it reads to know what it is watching (gitcha.env, then debconf.env, as the unit reads them).
import fs from 'node:fs';
import os from 'node:os';

export const ETC = '/etc/inputloop/gitcha';
export const STATE_DIR = '/var/lib/gitcha-medic';
export const CHANNELS = ['syslog', 'tavern', 'chadgram', 'webhook', 'c4'];
export const VENDORS = ['none', 'claude', 'local', 'inputloop', 'openai'];
export const HEAL_MODES = ['report', 'safe'];

/** Read one systemd EnvironmentFile: KEY=value lines, # comments, optional "..." or '...' quoting. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else {
      v = v.replace(/\s+#.*$/, ''); // a trailing comment, as in gitcha.env's example lines
    }
    out[m[1]] = v;
  }
  return out;
}

/** Read several files in order; later files win; a file that is not there is skipped. */
export function readEnvFiles(paths, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const out = {};
  for (const p of paths) {
    let text;
    try { text = readFile(p); } catch { continue; }
    Object.assign(out, parseEnvFile(text));
  }
  return out;
}

/** The parts of Gitcha's settings the medic cares about, with the server's own defaults. */
export function gitchaSettings(env) {
  const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const store = env.GITCHA_STORE === 'cassandra' ? 'cassandra' : 'file';
  const contact = list(env.GITCHA_CASSANDRA_CONTACT_POINTS);
  const points = (contact.length ? contact : ['127.0.0.1']).map((p) => {
    const m = /^(.*?)(?::(\d+))?$/.exec(p);
    return { host: m[1], port: Number(m[2] ?? 9042) };
  });
  const local = (h) => ['127.0.0.1', 'localhost', '::1', os.hostname()].includes(h);
  return {
    store,
    contactPoints: points,
    cassandraIsLocal: store === 'cassandra' && points.some((p) => local(p.host)),
    datacenter: env.GITCHA_CASSANDRA_DATACENTER || 'datacenter1',
    keyspace: env.GITCHA_CASSANDRA_KEYSPACE || 'gitcha',
    instance: env.GITCHA_CASSANDRA_INSTANCE || 'main',
    host: env.GITCHA_HOST || '127.0.0.1',
    port: Number(env.GITCHA_PORT || 4873),
    publicUrl: (env.GITCHA_PUBLIC_URL || '').replace(/\/$/, ''),
    dataDir: env.GITCHA_DATA_DIR || '/var/lib/gitcha',
  };
}

const ms = (s, dflt) => {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(s ?? '').trim());
  if (!m) return dflt;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 's'];
};

/**
 * The medic's settings. `env` is the process environment with medic.env already read into it (loadMedicEnv does
 * that). Unknown channel or vendor names are reported, not silently dropped.
 */
export function medicConfig(env, { hostname = os.hostname() } = {}) {
  const warnings = [];
  const channels = String(env.GITCHA_MEDIC_CHANNELS ?? 'syslog').split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of channels) if (!CHANNELS.includes(c)) warnings.push(`GITCHA_MEDIC_CHANNELS names an unknown channel "${c}" (one of ${CHANNELS.join(', ')})`);
  const vendor = env.GITCHA_MEDIC_AGENT || 'none';
  if (!VENDORS.includes(vendor)) warnings.push(`GITCHA_MEDIC_AGENT is "${vendor}"; it must be one of ${VENDORS.join(', ')}`);
  const heal = env.GITCHA_MEDIC_HEAL || 'report';
  if (!HEAL_MODES.includes(heal)) warnings.push(`GITCHA_MEDIC_HEAL is "${heal}"; it must be report or safe`);
  const defaultModel = { claude: 'claude-opus-5-5', local: 'llama3.1', openai: 'gpt-4o-mini', inputloop: 'mentat' }[vendor] ?? '';
  return {
    identity: env.GITCHA_MEDIC_IDENTITY || `gitcha-medic@${hostname}`,
    channels: channels.filter((c) => CHANNELS.includes(c)),
    heal: HEAL_MODES.includes(heal) ? heal : 'report',
    repeat: ms(env.GITCHA_MEDIC_REPEAT, 6 * 3_600_000),
    stateDir: env.GITCHA_MEDIC_STATE_DIR || STATE_DIR,
    agent: {
      vendor: VENDORS.includes(vendor) ? vendor : 'none',
      model: env.GITCHA_MEDIC_AGENT_MODEL || defaultModel,
      url: env.GITCHA_MEDIC_AGENT_URL || (vendor === 'claude' ? 'https://api.anthropic.com' : vendor === 'local' ? 'http://127.0.0.1:11434' : ''),
      key: env.GITCHA_MEDIC_AGENT_KEY || '',
      keyFile: env.GITCHA_MEDIC_AGENT_KEY_FILE || '',
      effort: env.GITCHA_MEDIC_AGENT_EFFORT || 'medium',
      fallbacks: (env.GITCHA_MEDIC_AGENT_FALLBACKS ?? 'yes') !== 'no',
      maxRounds: Number(env.GITCHA_MEDIC_AGENT_ROUNDS || 8),
    },
    tavern: {
      agentJson: env.GITCHA_MEDIC_TAVERN_AGENT_JSON || '',
      as: env.GITCHA_MEDIC_TAVERN_AS || `medic@${hostname}`,
      room: env.GITCHA_MEDIC_TAVERN_ROOM || 'main',
    },
    chadgram: {
      file: env.GITCHA_MEDIC_CHADGRAM_FILE || '',
      net: env.GITCHA_MEDIC_CHADGRAM_NET || 'ops',
    },
    webhook: { url: env.GITCHA_MEDIC_WEBHOOK_URL || '' },
    c4: { dir: env.GITCHA_MEDIC_C4_DIR || '' },
    gitchaEnvFiles: (env.GITCHA_MEDIC_GITCHA_ENV || `${ETC}/gitcha.env,${ETC}/debconf.env`).split(',').map((s) => s.trim()).filter(Boolean),
    warnings,
  };
}

/** medic.env merged under the process environment (the environment wins, so a test or a one-off run can override). */
export function loadMedicEnv(processEnv = process.env, { path = `${ETC}/medic.env`, readFile } = {}) {
  return { ...readEnvFiles([path], readFile ? { readFile } : {}), ...processEnv };
}

/** Names whose values are secrets: never shown, never sent to an agent or a channel. */
export const SECRET_NAME = /(PASSWORD|SECRET|_KEY|TOKEN|CLIENT_ID|WEBHOOK_ID)$/;
const SECRET_VALUE = /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;

/** A deep copy with secret-named keys and secret-looking strings replaced. Applied to everything that leaves the host. */
export function redact(value, key = '') {
  if (typeof value === 'string') return SECRET_NAME.test(key) && value !== '' ? '[redacted]' : value.replace(SECRET_VALUE, '[redacted]');
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
