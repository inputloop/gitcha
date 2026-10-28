#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// gitcha-ssh-keys -- OpenSSH AuthorizedKeysCommand for Gitcha.
//   sshd_config:  AuthorizedKeysCommand /usr/bin/gitcha-ssh-keys %f
//                 AuthorizedKeysCommandUser gitcha
// Prints the one authorized_keys line for the offered key's SHA256
// fingerprint, forcing it through gitcha-git-shell; prints nothing otherwise.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fp = process.argv[2] ?? '';
if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp)) process.exit(0);
const dataDir = process.env.GITCHA_DATA_DIR ?? '/var/lib/gitcha';
const base = process.env.GITCHA_INTERNAL_URL ?? 'http://127.0.0.1:4873';
try {
  const secret = readFileSync(path.join(dataDir, 'internal.key'), 'utf8').trim();
  const res = await fetch(`${base}/internal/ssh/keys?fingerprint=${encodeURIComponent(fp)}`, { headers: { 'X-Gitcha-Internal': secret } });
  if (res.ok) process.stdout.write(await res.text());
} catch {
  // Print nothing: sshd then refuses the key, which is the safe failure.
}
