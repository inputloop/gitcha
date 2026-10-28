#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig(process.env, { trustProxy: /^(1|true)$/i.test(process.env.GITCHA_TRUST_PROXY ?? '') });
const { server, version } = createApp(config);

server.listen(config.port, config.host, () => {
  const h = (ms) => `${Math.round(ms / 60000)} min`;
  console.log(`Gitcha registry v${version}`);
  console.log(`  listening on   http://${config.host}:${config.port}`);
  console.log(`  public URL     ${config.publicUrl}`);
  console.log(`  data dir       ${config.dataDir}`);
  console.log(`  2FA re-check   every ${h(config.policy.stepUpInterval)}; sensitive actions within ${h(config.policy.sensitiveWindow)}`);
  console.log(`  locked checks  ${config.policy.lockedChecks.join(', ') || '(none: users may toggle follow-up checks)'}`);
  console.log(`  registration   ${config.openRegistration ? 'open' : 'closed'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
