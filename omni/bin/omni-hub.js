#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// omni-hub: the stdio MCP server Claude starts in a sandbox. Settings, all from the environment:
//   OMNI_ROSTER        path to the roster JSON ({"members":{NAME:{"url":...,"tokenEnv":...}}}); default ~/.omni/roster.json,
//                      or OMNI_ROSTER_JSON holding the JSON itself (handy for a cloud environment's variables)
//   OMNI_SKILLS        comma list of folders holding skills (checkouts of vibrobeast-skills, jarvis, or any skills/ tree)
//   OMNI_TOKEN_*       each member's bearer token, named by its tokenEnv (a cloud environment's secret)
//   omni-hub --status  connect, print omni_status as JSON, and exit (for a receipt or a setup check)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHub } from '../lib/hub.js';

const rosterPath = process.env.OMNI_ROSTER || path.join(os.homedir(), '.omni', 'roster.json');
let rosterText = process.env.OMNI_ROSTER_JSON || '';
if (!rosterText) {
  try { rosterText = fs.readFileSync(rosterPath, 'utf8'); } catch { rosterText = '{"members":{}}'; process.stderr.write(`omni-hub: no roster at ${rosterPath} and no OMNI_ROSTER_JSON; serving the hub's own tools only\n`); }
}
const skillsRoots = (process.env.OMNI_SKILLS || '').split(',').map((s) => s.trim()).filter(Boolean);

const hub = await buildHub({ rosterText, skillsRoots });
if (process.argv.includes('--status')) { console.log(JSON.stringify(hub.status(), null, 2)); process.exit(hub.members.some((m) => m.error) ? 1 : 0); }
for (const m of hub.members) if (m.error) process.stderr.write(`omni-hub: ${m.error}\n`);
for (const c of hub.clashes) process.stderr.write(`omni-hub: tool name clash: ${c}\n`);
hub.server.listen();
