// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Connect Claude page: the config it writes (the same functions run in the browser), merging into an
// existing claude_desktop_config.json, and filling in the folder only for someone on the server's own computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, createUser } from './helpers.js';
import { mcpPath, desktopEntry, desktopConfig, mergeConfig, claudeCodeCommand, loginCommand, isGitchaMcp, guessOs, cleanServer } from '../public/claude-setup.js';

test('CLAUDE-1: the path, the Desktop entry, the Claude Code command and the sign-in command', () => {
  assert.equal(mcpPath('"C:\\gitcha\\server\\gitcha"', 'windows'), 'C:\\gitcha\\server\\gitcha\\extension\\bin\\gitcha-mcp.js', 'Copy as path quotes are dropped');
  assert.equal(mcpPath('C:\\gitcha\\', 'windows'), 'C:\\gitcha\\extension\\bin\\gitcha-mcp.js');
  assert.equal(mcpPath('/home/me/gitcha/', 'linux'), '/home/me/gitcha/extension/bin/gitcha-mcp.js');
  assert.equal(mcpPath('/home/me/gitcha/extension', 'mac'), '/home/me/gitcha/extension/bin/gitcha-mcp.js');
  assert.equal(mcpPath('/x/extension/bin/gitcha-mcp.js', 'mac'), '/x/extension/bin/gitcha-mcp.js');
  assert.equal(mcpPath('  ', 'windows'), '');

  const entry = desktopEntry({ mcp: 'C:\\g\\extension\\bin\\gitcha-mcp.js', server: 'https://gitcha.example.com/some/page' });
  assert.deepEqual(entry, { command: 'node', args: ['C:\\g\\extension\\bin\\gitcha-mcp.js'], env: { GITCHA_SERVER: 'https://gitcha.example.com' } });
  assert.match(desktopConfig(entry), /"C:\\\\g\\\\extension\\\\bin\\\\gitcha-mcp\.js"/, 'backslashes doubled, as JSON needs');
  assert.deepEqual(JSON.parse(desktopConfig(entry)).mcpServers.gitcha, entry);

  assert.equal(claudeCodeCommand({ mcp: 'C:\\Program Files\\g\\extension\\bin\\gitcha-mcp.js' }),
    'claude mcp add --scope user gitcha --env GITCHA_SERVER=http://localhost:4873 -- node "C:\\Program Files\\g\\extension\\bin\\gitcha-mcp.js"');
  assert.equal(loginCommand({ mcp: '/g/extension/bin/gitcha-mcp.js' }), 'node /g/extension/bin/gitcha.js login');
  assert.equal(loginCommand({ mcp: '/g/extension/bin/gitcha-mcp.js', server: 'https://h.example' }), 'node /g/extension/bin/gitcha.js login --server https://h.example');
  assert.equal(cleanServer('not a url'), 'http://localhost:4873');
  assert.equal(guessOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(guessOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'mac');
  assert.equal(guessOs('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.ok(isGitchaMcp(fs.readFileSync(new URL('../../extension/bin/gitcha-mcp.js', import.meta.url), 'utf8')));
  assert.ok(!isGitchaMcp('console.log(1)'));
});

test('CLAUDE-2: merging keeps the other servers and settings, replaces an old gitcha entry, and refuses broken JSON', () => {
  const entry = desktopEntry({ mcp: '/g/extension/bin/gitcha-mcp.js' });
  const mine = '\uFEFF{ "globalShortcut": "Ctrl+Space", "mcpServers": { "files": { "command": "npx", "args": ["fs"] }, "gitcha": { "command": "old" } } }';
  const m = mergeConfig(mine, entry);
  const out = JSON.parse(m.text);
  assert.equal(m.replaced, true);
  assert.equal(out.globalShortcut, 'Ctrl+Space');
  assert.deepEqual(out.mcpServers.files, { command: 'npx', args: ['fs'] });
  assert.deepEqual(out.mcpServers.gitcha, entry);
  assert.equal(mergeConfig('', entry).replaced, false);
  assert.deepEqual(JSON.parse(mergeConfig('', entry).text), { mcpServers: { gitcha: entry } });
  assert.match(mergeConfig('{ "mcpServers": ', entry).error, /not valid JSON/);
  assert.match(mergeConfig('[1,2]', entry).error, /settings object/);
});

test('CLAUDE-3: the page; the folder is filled in only for someone signed in on the server\'s own computer', async () => {
  const srv = await startServer();
  try {
    const anon = await (await fetch(`${srv.url}/claude`)).text();
    assert.match(anon, /<h1>Connect Claude<\/h1>/);
    assert.match(anon, /<script src="\/static\/claude-setup\.js" type="module"><\/script>/);
    assert.match(anon, /id="cs-folder" type="text" spellcheck="false" autocomplete="off" value=""/, 'no path for a visitor');
    assert.match(anon, /claude mcp add --scope user gitcha/);
    createUser(srv, 'alice', 'first long pass!');
    const sid = srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 'b', ip: '127.0.0.1' }).token;
    const own = await (await fetch(`${srv.url}/claude`, { headers: { Cookie: `gitcha_sid=${sid}` } })).text();
    assert.ok(own.includes('extension') && own.includes('gitcha-mcp.js') && /value="[^"]+gitcha-mcp\.js"/.test(own), 'the path is filled in on this machine');
    assert.match(own, /Filled in from where this server runs/);
    const js = await fetch(`${srv.url}/static/claude-setup.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally { await srv.close(); }
});
