#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The program you run to start the Gitcha server. It reads the settings, builds the app (app.js),
// starts listening for web requests, and prints a short summary of the settings it is using.
// With --check it does not stay up: it says whether the server could start here, and if not, why
// (gitcha-check runs it that way with the unit's settings, as the unit's user).
import { loadConfig, StartupError } from './config.js';
import { createApp } from './app.js';
import { installLastResort } from './http.js';

/** One line naming where the database is, for the start-up log and --check. */
function describeStore(config) {
  const c = config.store.cassandra;
  return config.store.kind === 'cassandra'
    ? `Cassandra ${c.contactPoints.join(',')} (data center ${c.datacenter}), keyspace ${c.keyspace}, instance ${c.instance}`
    : `${config.dataDir}/db.json`;
}

/** The address to reach a server listening on `host` from this machine (0.0.0.0 and :: listen everywhere). */
const localHost = (host) => (['0.0.0.0', '::', ''].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host);

if (process.argv.includes('--check')) await check();

// Catch stray errors from here on, so one bad request cannot crash a running server.
installLastResort();

// Load the settings and build the app. If a setting or data file is bad, the server prints one
// line and exits with code 1, instead of a long stack trace (AUTH-9, DEP-5).
function startOrExplain() {
  try {
    const config = loadConfig(process.env);
    // Said before the database opens: reaching Cassandra, or waiting for another server's lease, can take a while.
    console.log(`gitcha: starting; opening the database: ${describeStore(config)}`);
    return { config, ...createApp(config) };
  } catch (err) {
    // The last-resort handlers keep a RUNNING server up. A server that never started must exit with a
    // non-zero code. Otherwise a supervisor (a program that restarts the server, such as systemd with
    // Restart=on-failure, or a container) would think it finished on purpose.
    console.error(`gitcha: cannot start: ${err instanceof StartupError ? err.message : (err?.stack ?? err)}`);
    process.exit(1);
  }
}
const { config, server, version } = startOrExplain();
// If the port cannot be opened (for example, it is already in use), say so in one line and exit 1.
// An error after the server is already listening is passed on, not handled here.
server.once('error', (err) => {
  if (server.listening) throw err;
  console.error(`gitcha: cannot start: could not listen on ${config.host}:${config.port} (${err.code ?? err.message})`);
  process.exit(1);
});

// Start listening, then print the main settings so the operator can check them at a glance.
server.listen(config.port, config.host, () => {
  const h = (ms) => `${Math.round(ms / 60000)} min`;
  console.log(`Gitcha registry v${version}`);
  console.log(`  listening on   http://${config.host}:${config.port}`);
  console.log(`  public URL     ${config.publicUrl}`);
  console.log(`  data dir       ${config.dataDir}`);
  console.log(`  database       ${describeStore(config)}`);
  console.log(`  2FA re-check   every ${h(config.policy.stepUpInterval)}; sensitive actions within ${h(config.policy.sensitiveWindow)}`);
  console.log(`  locked checks  ${config.policy.lockedChecks.join(', ') || '(none: users may toggle follow-up checks)'}`);
  console.log(`  registration   ${config.openRegistration ? 'open' : 'closed'}`);
  const via = config.trustedProxies.hops ? `${config.trustedProxies.hops} proxy hop(s)` : 'the listed proxies';
  console.log(`  client address ${config.trustProxy ? `from X-Forwarded-For through ${via}` : 'the socket (X-Forwarded-For ignored; set GITCHA_TRUST_PROXY=true behind your own proxy)'}`);
});

// On Ctrl+C (SIGINT) or a stop request (SIGTERM), stop taking new connections and exit once the open ones close.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

/**
 * gitcha-server --check: can the server start here, and if not, why? Opens the database and the port the way a start
 * would, then lets go of both. A server that already answers on the port is reported, not disturbed.
 */
async function check() {
  const ok = (msg) => console.log(`  ok       ${msg}`);
  const bad = (msg) => { console.log(`  PROBLEM  ${msg}`); process.exit(1); };
  if (process.getuid?.() === 0) bad('running as root would leave files in the data directory the gitcha user cannot open. Run gitcha-check (it runs this as the unit\'s user), or sudo -u gitcha.');
  let config;
  try { config = loadConfig(process.env); } catch (err) { bad(`settings: ${err.message}`); }
  console.log('gitcha check');
  ok(`settings read: public URL ${config.publicUrl}, listen ${config.host}:${config.port}, data ${config.dataDir}`);
  ok(`database setting: ${describeStore(config)}`);
  if (config.trustProxy && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    console.log(`  WARNING  GITCHA_TRUST_PROXY=true but Gitcha listens on ${config.host}: anyone who reaches that port can choose their own address. Listen on 127.0.0.1 behind a proxy, or set GITCHA_TRUST_PROXY=false without one.`);
  }
  const url = `http://${localHost(config.host)}:${config.port}/api/v1/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => ({}));
    if (body.service === 'gitcha') {
      ok(`a Gitcha server (v${body.version}) is already running and answers at ${url}`);
      console.log(`  So Gitcha is up. If your proxy still cannot reach it, its upstream must be http://${localHost(config.host)}:${config.port} (nginx: proxy_pass), on this same machine.`);
      process.exit(0);
    }
    bad(`something that is not Gitcha already answers on ${config.host}:${config.port} (HTTP ${res.status}); stop it or set GITCHA_PORT`);
  } catch { /* nothing answers yet: go on and try a start */ }
  let app;
  try { app = createApp(config); } catch (err) { bad(`database: ${err instanceof StartupError ? err.message : (err?.stack ?? err)}`); }
  ok(`database opened: ${app.store.userCount()} account(s)`);
  await new Promise((resolve) => {
    app.server.once('error', (err) => bad(`port: cannot listen on ${config.host}:${config.port} (${err.code ?? err.message})`));
    app.server.listen(config.port, config.host, resolve);
  });
  ok(`port ${config.host}:${config.port} can be opened`);
  await new Promise((r) => app.server.close(r));
  console.log('Everything a start needs works. Start it with: systemctl start gitcha   and follow it with: journalctl -u gitcha -f');
  process.exit(0);
}
