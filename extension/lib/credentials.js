// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Device credentials. Only the revocable device token is stored, never the
// password or the TOTP secret. The file is created with 0600 permissions where the platform has them.
import crypto from 'node:crypto';
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

/**
 * Write the file through a fresh, randomly named temp file opened with `wx` and mode 0600, so a leftover or planted
 * `credentials.json.tmp` (a looser mode, or a symlink) is never written through. Returns whether the result is
 * really private (read back with stat, so the CLI says "mode 600" only where it is true) and any chmod problem.
 */
function writeAll(data, env) {
  const f = file(env);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let warning = null;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    try { fs.fchmodSync(fd, 0o600); } catch (err) { warning = `could not set mode 600 (${err.code ?? err.message})`; }
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, f);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const mode = fs.statSync(f).mode;
  return { path: f, private: process.platform !== 'win32' && (mode & 0o077) === 0, warning };
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
  return writeAll(data, env);
}

export function removeCredentials(server, env = process.env) {
  const data = readAll(env);
  delete data.servers[server];
  if (data.default === server) data.default = Object.keys(data.servers)[0] ?? null;
  return writeAll(data, env);
}

export const credentialsPath = file;
