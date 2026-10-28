// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A setting the server cannot honour stops it with one clear line (AUTH-9). The key and data-file rules (AUTH-14,
// STORE-1) are in the same file because they are the same kind of promise: refuse to start rather than start wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { spawnServer } from './spawn.js';

const KEY = crypto.randomBytes(32).toString('base64');
const cfg = (env) => loadConfig({ GITCHA_SECRET_KEY: KEY, GITCHA_DATA_DIR: tmpDir(), ...env });

test('AUTH-9: GITCHA_LOCKED_CHECKS refuses a name that locks nothing', () => {
  assert.deepEqual(cfg({ GITCHA_LOCKED_CHECKS: 'new_network, Interval' }).policy.lockedChecks, ['new_network', 'interval']);
  assert.deepEqual(cfg({}).policy.lockedChecks, []);
  assert.throws(() => cfg({ GITCHA_LOCKED_CHECKS: 'new-network' }), /unknown check.*new-network.*Valid names: interval, new_network, sensitive/);
  assert.throws(() => cfg({ GITCHA_LOCKED_CHECKS: 'interval,sensetive' }), /sensetive/);
});

test('AUTH-9: the real entry point prints one line and exits 1 on a bad setting', async () => {
  const srv = await spawnServer({ env: { GITCHA_LOCKED_CHECKS: 'new-network', GITCHA_SECRET_KEY: KEY } });
  try {
    assert.equal(srv.started, false);
    assert.equal(await srv.exited, 1);
    const lines = srv.err().trim().split('\n');
    assert.equal(lines.length, 1, `one line, got: ${srv.err()}`);
    assert.match(lines[0], /^gitcha: cannot start: GITCHA_LOCKED_CHECKS names unknown check/);
  } finally { await srv.stop(); }
});
