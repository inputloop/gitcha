#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// gitcha-git-shell: the forced command for every Gitcha SSH key. (A forced
// command is the one program sshd runs for a key, whatever the user typed.)
// It runs only git-upload-pack or git-receive-pack (the programs behind clone,
// fetch and push). It runs them only on repositories the key's owner (a person
// or an agent) may read or write. The server makes that decision, through
// the loopback endpoints in server/src/git/http.js.
// Arguments: the key's fingerprint. sshd puts the user's command in SSH_ORIGINAL_COMMAND.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fingerprint = process.argv[2] ?? '';
const command = process.env.SSH_ORIGINAL_COMMAND ?? '';
const dataDir = process.env.GITCHA_DATA_DIR ?? '/var/lib/gitcha';
const base = process.env.GITCHA_INTERNAL_URL ?? 'http://127.0.0.1:4873';
// Print an error for the git client and stop.
const fail = (m) => { process.stderr.write(`gitcha: ${m}\n`); process.exit(1); };

if (!command) fail('Hi! You have reached Gitcha over SSH. There is no shell here; use git clone / fetch / push.');
// The shared secret proves to the server that this call comes from this machine.
let secret;
try { secret = readFileSync(path.join(dataDir, 'internal.key'), 'utf8').trim(); } catch { fail('server not configured'); }
// POST JSON to an internal endpoint. Any refusal ends the program with the server's message.
const call = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitcha-Internal': secret }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(j.message ?? `refused (${res.status})`);
  return j;
};
// Ask the server first. Only if it agrees does git run, on the folder the server named.
const auth = await call('/internal/git/authorize', { fingerprint, command });
const child = spawn(auth.service, [auth.repo], { stdio: 'inherit' });
// After a successful push, tell the server so it can record the push.
child.on('close', async (code) => {
  if (code === 0 && auth.service === 'git-receive-pack') {
    try { await call('/internal/git/pushed', { fingerprint, project: auth.project, before: auth.before }); } catch { /* the push itself succeeded */ }
  }
  process.exit(code ?? 1);
});
