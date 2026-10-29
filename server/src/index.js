#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The program you run to start the Gitcha server. It reads the settings, builds the app (app.js),
// starts listening for web requests, and prints a short summary of the settings it is using.
import { loadConfig, StartupError } from './config.js';
import { createApp } from './app.js';
import { installLastResort } from './http.js';

// Catch stray errors from here on, so one bad request cannot crash a running server.
installLastResort();

// Load the settings and build the app. If a setting or data file is bad, the server prints one
// line and exits with code 1, instead of a long stack trace (AUTH-9, DEP-5).
function startOrExplain() {
  try {
    const config = loadConfig(process.env);
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
  console.log(`  2FA re-check   every ${h(config.policy.stepUpInterval)}; sensitive actions within ${h(config.policy.sensitiveWindow)}`);
  console.log(`  locked checks  ${config.policy.lockedChecks.join(', ') || '(none: users may toggle follow-up checks)'}`);
  console.log(`  registration   ${config.openRegistration ? 'open' : 'closed'}`);
  const via = config.trustedProxies.hops ? `${config.trustedProxies.hops} proxy hop(s)` : 'the listed proxies';
  console.log(`  client address ${config.trustProxy ? `from X-Forwarded-For through ${via}` : 'the socket (X-Forwarded-For ignored; set GITCHA_TRUST_PROXY=true behind your own proxy)'}`);
});

// On Ctrl+C (SIGINT) or a stop request (SIGTERM), stop taking new connections and exit once the open ones close.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
