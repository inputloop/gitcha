// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Start the real entry point (src/index.js) as a child process, as the shipped unit does.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Start the real server; resolves once it prints its banner, or reports why it did not. */
export async function spawnServer({ dataDir = tmpDir(), env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], {
    env: { PATH: process.env.PATH, GITCHA_PORT: String(port), GITCHA_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  let poll;
  const started = await Promise.race([
    new Promise((resolve) => { poll = setInterval(() => { if (out.includes('listening on')) resolve(true); }, 20); }),
    exited.then(() => false),
  ]);
  clearInterval(poll);
  return {
    child, port, dataDir, started, exited, out: () => out, err: () => err,
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; },
  };
}
