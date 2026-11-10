// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Demo encrypted messages for the screenshots. The person in the screenshot makes their keys in the real
// browser; this file plays the other people's devices in Node with the very code the browser and the CLI use
// (extension/lib/dm-client.js), so what it sends is real, sealed, padded, signed ciphertext.
import { DmDevice } from '../extension/lib/dm-client.js';

const devices = new Map();

/** A device for `username` that talks to the running server at `url` with a device token. */
function deviceFor(app, url, username) {
  if (devices.has(username)) return devices.get(username);
  const token = app.auth.createSession(app.store.userByName(username), { kind: 'device', name: 'demo', ip: '127.0.0.1' }).token;
  const mem = {};
  const api = async (method, path, body) => {
    const res = await fetch(`${url}/api/v1/dm${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) { const err = new Error(data.message); err.code = data.error; throw err; }
    return data;
  };
  const d = new DmDevice({ me: username, api, storage: { get: async (n) => mem[n], put: async (n, v) => { mem[n] = v; } }, mode: 'pkcs8' });
  devices.set(username, d);
  return d;
}

/** Send `text` from `from` (played here; keys made on first use) to `to`, encrypted end to end. */
export async function writeAs(app, url, from, to, text) {
  const d = deviceFor(app, url, from);
  if ((await d.status()).state === 'setup') await d.setup(null);
  await d.send(to, text);
}
