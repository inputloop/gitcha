#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// gitcha-git-shell -- the forced command for every Gitcha SSH key.
// Runs only git-upload-pack / git-receive-pack, and only for repositories the
// key's owner (a person or an agent) may read or write, as the server decides.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fingerprint = process.argv[2] ?? '';
const command = process.env.SSH_ORIGINAL_COMMAND ?? '';
const dataDir = process.env.GITCHA_DATA_DIR ?? '/var/lib/gitcha';
const base = process.env.GITCHA_INTERNAL_URL ?? 'http://127.0.0.1:4873';
const fail = (m) => { process.stderr.write(`gitcha: ${m}\n`); process.exit(1); };

if (!command) fail('Hi! You have reached Gitcha over SSH. There is no shell here; use git clone / fetch / push.');
let secret;
try { secret = readFileSync(path.join(dataDir, 'internal.key'), 'utf8').trim(); } catch { fail('server not configured'); }
const call = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitcha-Internal': secret }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(j.message ?? `refused (${res.status})`);
  return j;
};
const auth = await call('/internal/git/authorize', { fingerprint, command });
const child = spawn(auth.service, [auth.repo], { stdio: 'inherit' });
child.on('close', async (code) => {
  if (code === 0 && auth.service === 'git-receive-pack') {
    try { await call('/internal/git/pushed', { fingerprint, project: auth.project, before: auth.before }); } catch { /* the push itself succeeded */ }
  }
  process.exit(code ?? 1);
});
