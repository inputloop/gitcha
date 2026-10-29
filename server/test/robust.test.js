// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A stranger's request must never end the process (AUTH-1 / OPS-1 / DEP-1), and a second process must not share a
// data directory (STORE-1). These run the real entry point, as the shipped unit does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnServer } from './spawn.js';

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

test('DEP-1: a server that cannot listen says so in one line and exits 1, not 0 "kept serving"', async () => {
  const net = await import('node:net');
  const held = net.createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const { port } = held.address();
  const srv = await spawnServer({ env: { GITCHA_PORT: String(port) } });
  try {
    assert.equal(srv.started, false);
    assert.equal(await srv.exited, 1, `exit code, stderr: ${srv.err()}`);
    const lines = srv.err().trim().split('\n');
    assert.equal(lines.length, 1, srv.err());
    assert.match(lines[0], /^gitcha: cannot start: could not listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
  } finally { await srv.stop(); held.close(); }
});
