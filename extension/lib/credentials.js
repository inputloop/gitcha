// Device credentials. Only the revocable device token is stored, never the
// password or the TOTP secret. The file is created with 0600 permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SERVER = 'http://localhost:4873';

export function configDir(env = process.env) {
  if (env.GITCHA_CONFIG_DIR) return env.GITCHA_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'gitcha');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'gitcha');
}

const file = (env) => path.join(configDir(env), 'credentials.json');

export function normalizeServer(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Refusing to use plain http:// for ${u.hostname}. Use https:// (credentials would be sent in the clear).`);
  }
  return u.origin;
}

export function readAll(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(file(env), 'utf8'));
  } catch {
    return { default: null, servers: {} };
  }
}

function writeAll(data, env) {
  const f = file(env);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  try { fs.chmodSync(f, 0o600); } catch { /* not supported on this platform */ }
}

/** Server URL to use: explicit flag > env > saved default > localhost. */
export function resolveServer(explicit, env = process.env) {
  return normalizeServer(explicit || env.GITCHA_SERVER || readAll(env).default || DEFAULT_SERVER);
}

export function getCredentials(server, env = process.env) {
  return readAll(env).servers[server] ?? null;
}

export function saveCredentials(server, creds, env = process.env) {
  const data = readAll(env);
  data.servers[server] = { ...creds, savedAt: new Date().toISOString() };
  data.default = server;
  writeAll(data, env);
}

export function removeCredentials(server, env = process.env) {
  const data = readAll(env);
  delete data.servers[server];
  if (data.default === server) data.default = Object.keys(data.servers)[0] ?? null;
  writeAll(data, env);
}

export const credentialsPath = file;
