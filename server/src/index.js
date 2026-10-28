#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { loadConfig, StartupError } from './config.js';
import { createApp } from './app.js';
import { installLastResort } from './http.js';

installLastResort();

// A setting or data file the server cannot start with is one line and exit 1, not a stack trace (AUTH-9, DEP-5).
function startOrExplain() {
  try {
    const config = loadConfig(process.env);
    return { config, ...createApp(config) };
  } catch (err) {
    if (!(err instanceof StartupError)) throw err;
    console.error(`gitcha: cannot start: ${err.message}`);
    process.exit(1);
  }
}
const { config, server, version } = startOrExplain();

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

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
