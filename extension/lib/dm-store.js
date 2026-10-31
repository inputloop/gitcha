// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Where the gitcha CLI keeps its messaging keys and the messages it has opened: one JSON file per server and
// person, in the config folder, readable only by you (folder mode 700, file mode 600), the way SSH keeps
// private keys. It is written to a new file and renamed into place, so a crash never leaves half of it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from './credentials.js';

export function messagesFile(server, username, env = process.env) {
  const host = new URL(server).host.replace(/[^\w.-]+/g, '_');
  return path.join(configDir(env), 'messages', `${host}-${username.replace(/[^\w.-]+/g, '_')}.json`);
}

/** A storage object for DmDevice: get(name) and put(name, value), backed by that file. */
export function fileStorage(file) {
  let cache = null;
  const read = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; cache = {}; }
    return cache;
  };
  return {
    file,
    async get(name) { return read()[name]; },
    async put(name, value) {
      const all = read();
      all[name] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    },
  };
}
