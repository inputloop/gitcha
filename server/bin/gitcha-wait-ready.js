#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// gitcha-wait-ready: the unit's ExecStartPost. It waits until the server it just started answers its health
// URL. Until then the start is not finished, so "systemctl start gitcha" waits too, and says so when the start
// fails, instead of reporting success for a server that exits a second later (and leaves the proxy with
// "connection refused"). If the server stops first, systemd ends this and marks the start failed.
const host = process.env.GITCHA_HOST ?? '127.0.0.1';
const port = process.env.GITCHA_PORT ?? '4873';
const local = ['0.0.0.0', '::', ''].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
const url = `http://${local}:${port}/api/v1/health`;
// Under the unit's TimeoutStartSec (180 s): long enough to wait out another server's Cassandra lease (90 s).
const deadline = Date.now() + 170_000;
for (;;) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) process.exit(0);
  } catch { /* not listening yet */ }
  if (Date.now() > deadline) {
    console.error(`gitcha: the server did not answer ${url} within 170 s; see journalctl -u gitcha`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
