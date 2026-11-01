#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// omni-gateway: run on a host you own; puts the stdio MCP servers named in a members file behind HTTP, each
// behind its own bearer token, for the hub (or Claude directly) to reach.
//   omni-gateway [--members FILE] [--tokens DIR] [--listen 127.0.0.1:8769]
//   omni-gateway --check            read the members file, start each member, list its tools, and exit
//   omni-gateway --mint NAME        write a fresh token for member NAME to DIR/NAME (mode 600) unless one is there,
//                                   and print it once: carry it to the cloud environment's secrets as OMNI_TOKEN_NAME
//   OMNI_MEMBERS   the members file (default /etc/inputloop/omni/members.json)
//   OMNI_TOKENS    the token files' folder (default /etc/inputloop/omni/tokens); a member with no tokenFile uses DIR/NAME
//   OMNI_LISTEN    host:port (default 127.0.0.1:8769; put nginx with TLS in front, never expose this port)
import { createGateway, readMembers, Member, mintToken } from '../lib/gateway.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const membersFile = opt('--members', process.env.OMNI_MEMBERS || '/etc/inputloop/omni/members.json');
const tokensDir = opt('--tokens', process.env.OMNI_TOKENS || '/etc/inputloop/omni/tokens');
const listen = opt('--listen', process.env.OMNI_LISTEN || '127.0.0.1:8769');
const log = (s) => process.stderr.write(`omni-gateway: ${s}\n`);

if (args.includes('--mint')) {
  const name = opt('--mint');
  if (!name) { log('--mint needs a member name'); process.exit(2); }
  try {
    const { file, token, fresh } = mintToken(tokensDir, name);
    process.stderr.write(`omni-gateway: ${fresh ? 'minted' : 'already there'}: ${file} (mode 600). The token, once; put it in the cloud environment as OMNI_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}:\n`);
    process.stdout.write(`${token}\n`);
    process.exit(0);
  } catch (err) { log(err.message); process.exit(1); }
}

let members;
try { members = readMembers(membersFile, { tokensDir }); } catch (err) { log(err.message); process.exit(2); }

if (args.includes('--check')) {
  let bad = 0;
  for (const [name, spec] of Object.entries(members)) {
    const m = new Member(name, spec, { log });
    try { const info = await m.ready(); console.log(`${name}: ${info.serverInfo?.name ?? '?'} ${info.serverInfo?.version ?? ''}: ${m.tools.length} tool(s): ${m.tools.map((t) => t.name).join(', ')}`); }
    catch (err) { bad++; console.log(`${name}: FAILED: ${err.message}`); }
    m.stop();
  }
  process.exit(bad ? 1 : 0);
}

const [host, port] = listen.includes(':') ? [listen.slice(0, listen.lastIndexOf(':')), Number(listen.slice(listen.lastIndexOf(':') + 1))] : ['127.0.0.1', Number(listen)];
const server = createGateway({ members, log });
server.listen(port, host, () => log(`listening on http://${host}:${port}/mcp/{${Object.keys(members).join(',')}} (loopback unless OMNI_LISTEN says otherwise)`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.stopMembers(); server.close(() => process.exit(0)); });
