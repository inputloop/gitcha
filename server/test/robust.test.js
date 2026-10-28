// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A stranger's request must never end the process (AUTH-1 / OPS-1 / DEP-1), and a second process must not share a
// data directory (STORE-1). These run the real entry point, as the shipped unit does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const started = await Promise.race([
    new Promise((resolve) => { const t = setInterval(() => { if (out.includes('listening on')) { clearInterval(t); resolve(true); } }, 20); }),
    exited.then(() => false),
  ]);
  return {
    child, port, dataDir, started, exited, out: () => out, err: () => err,
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; },
  };
}

/** Send raw bytes and return the first line of the answer ('' when the connection closes silently). */
function raw(port, bytes) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
    let buf = '';
    s.on('data', (c) => { buf += c; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('close', () => resolve(buf.split('\r\n')[0]));
    s.on('error', () => resolve(buf.split('\r\n')[0]));
    setTimeout(() => { s.destroy(); resolve(buf.split('\r\n')[0]); }, 3000);
  });
}

const get = (target, headers = '') => `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers}\r\n`;

test('AUTH-1: a bad cookie, a bad request target and a bad path escape never end the process', async () => {
  const srv = await spawnServer();
  try {
    assert.ok(srv.started, `server did not start: ${srv.err()}`);
    assert.match(await raw(srv.port, get('/api/v1/health')), / 200 /);
    // The three shapes from the probes: Cookie a=%, request target //, and a % escape in a route parameter.
    const cookie = await raw(srv.port, get('/login', 'Cookie: a=%\r\n'));
    assert.match(cookie, / 200 /, 'a bad cookie is kept as it came, not an error');
    assert.ok(srv.alive(), `the process must survive a bad cookie (stderr: ${srv.err().split('\n')[0]})`);
    const slashes = await raw(srv.port, get('//'));
    assert.match(slashes, / (200|400|404) /, `request target // answers a clean status, got ${slashes}`);
    assert.ok(srv.alive(), `the process must survive the request target // (stderr: ${srv.err().split('\n')[0]})`);
    const escape = await raw(srv.port, get('/api/v1/packages/%E0%A4%A/1.0.0/tarball'));
    assert.match(escape, / 400 /, `a malformed % escape in a path is a 400, got ${escape}`);
    const weird = await raw(srv.port, get('*'));
    assert.match(weird, / 400 /, 'asterisk-form is refused');
    assert.ok(srv.alive());
    assert.match(await raw(srv.port, get('/api/v1/health')), / 200 /, 'health still answers after all of them');
  } finally { await srv.stop(); }
});

test('AUTH-1: the last-resort handlers log and return instead of ending the process', async () => {
  const { EventEmitter } = await import('node:events');
  const { installLastResort } = await import('../src/http.js');
  const fake = new EventEmitter();
  const lines = [];
  installLastResort(fake, (l) => lines.push(l));
  fake.emit('unhandledRejection', new Error('nobody awaited me'));
  fake.emit('uncaughtException', new Error('no listener on this socket'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /unhandled rejection \(kept serving\).*nobody awaited me/s);
  assert.match(lines[1], /uncaught exception \(kept serving\).*no listener/s);
});
