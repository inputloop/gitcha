// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// omni/lib/mcp.js is extension/lib/mcp.js, copied so the plugin stands alone when installed from the marketplace.
// A copy drifts unless a check says it has not: this is that check (as vibrobeast's hub keeps parity by comparison).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('omni/lib/mcp.js is byte for byte extension/lib/mcp.js', () => {
  const a = fs.readFileSync(path.join(here, '..', 'lib', 'mcp.js'));
  const b = fs.readFileSync(path.join(here, '..', '..', 'extension', 'lib', 'mcp.js'));
  assert.ok(a.equals(b), 'they differ: cp extension/lib/mcp.js omni/lib/mcp.js (change the extension\'s, then copy)');
});

test('the plugin manifests name what exists', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(here, '..', plugin.mcpServers), 'utf8'));
  assert.ok(mcp.mcpServers.omni.args[0].endsWith('/bin/omni-hub.js'));
  assert.ok(fs.existsSync(path.join(here, '..', 'bin', 'omni-hub.js')));
  assert.ok(fs.existsSync(path.join(here, '..', plugin.skills, 'omni', 'SKILL.md')));
  const market = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.ok(market.plugins.some((p) => p.name === 'omni' && p.source === './omni'), 'the marketplace lists omni');
});
