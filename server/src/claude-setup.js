// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The "Connect Claude" page (/claude): step-by-step setup of the Gitcha MCP server for Claude Desktop and
// Claude Code, with the config written for you. The page is drawn complete here (so it works without
// scripts), and /static/claude-setup.js redraws it as the person types, checks a picked gitcha-mcp.js, and
// merges Gitcha into their own claude_desktop_config.json, all inside the browser.
//
// The one thing a web page cannot learn is where Gitcha's code is on the person's computer. When the page is
// opened on the computer the server runs on (the request comes from this machine's own address) by someone
// signed in, the server fills that in from where it is running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { h, raw, site } from './views.js';
import { CONFIG_LOCATION, DEFAULT_SERVER, mcpPath, desktopEntry, desktopConfig, claudeCodeCommand, loginCommand } from '../public/claude-setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// This checkout's own gitcha-mcp.js, when the server runs from a checkout (packages ship without it).
const OWN_MCP = path.resolve(here, '..', '..', 'extension', 'bin', 'gitcha-mcp.js');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const OS_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

/** Adds the page. */
export function registerClaudeSetup(router, { web, config }) {
  router.get('/claude', (ctx) => {
    const a = web.current(ctx);
    const local = Boolean(a) && LOOPBACK.has(ctx.ip) && fs.existsSync(OWN_MCP);
    const os = local ? ({ win32: 'windows', darwin: 'mac' }[process.platform] ?? 'linux') : 'windows';
    web.page(ctx, 'Connect Claude', claudeSetupPage({ folder: local ? OWN_MCP : '', os, osChosen: local, server: config.publicUrl || DEFAULT_SERVER, local }), { user: a?.user, wide: true });
  });
}

const copyable = (id, text) => h`<div class="cs-copy"><pre class="install"><code id="${id}">${text}</code></pre><button type="button" class="btn ghost small" data-copy="${id}">Copy</button></div>`;

/** The page. Every value the script changes is drawn here first from the same functions. */
export function claudeSetupPage({ folder, os, osChosen, server, local }) {
  const opts = { mcp: mcpPath(folder, os), server, node: 'node' };
  return h`<div class="page-head"><div><h1>Connect Claude</h1>
  <p class="lead">Let Claude search, install and publish on ${site.name}, with its MCP server (the
  <code>extension/</code> folder of the code you cloned). Your password and two-factor codes never go to Claude.</p></div></div>
<div id="cs" class="cs" ${osChosen ? raw('data-os-chosen="1"') : ''}>
<section class="card"><h2>1. Tell this page about your computer</h2>
  <label>Your computer <select id="cs-os">${Object.entries(OS_NAMES).map(([k, v]) => h`<option value="${k}" ${k === os ? raw('selected') : ''}>${v}</option>`)}</select></label>
  <label>The code's folder on that computer (where you ran <code>git clone</code>)
    <input id="cs-folder" type="text" spellcheck="false" autocomplete="off" value="${folder}" placeholder="${os === 'windows' ? 'C:\\gitcha' : '/home/you/gitcha'}"></label>
  <p class="small muted">${local ? 'Filled in from where this server runs, because you opened this page on the same computer.'
    : h`Browsers do not tell a page where a file is, so type or paste it. On Windows: Shift + right-click the folder in File Explorer, then <strong>Copy as path</strong>. On a Mac: right-click it while holding Option, then <strong>Copy as Pathname</strong>.`}</p>
  <label>Check that it is the right file (optional): pick <code>extension/bin/gitcha-mcp.js</code>
    <input id="cs-check" type="file" accept=".js,text/javascript"></label>
  <p id="cs-check-note" class="small muted" hidden></p>
  <p class="small">The MCP server is: <code id="cs-path">${opts.mcp || '(type the folder above)'}</code></p>
  <label>${site.name}'s address, as that computer reaches it <input id="cs-server" type="url" value="${server}" spellcheck="false"></label>
  <p class="small muted">Use <code>https://</code>, or <code>http://localhost:4873</code> on the same computer (or through a WireGuard port forward, see the README). Plain http to any other address is refused, so passwords never cross a network unencrypted.</p>
  <details><summary class="small">Node is not found?</summary>
    <label>The node program <input id="cs-node" type="text" value="node" spellcheck="false"></label>
    <p class="small muted">Claude Desktop does not always see your PATH. Put the full path here: <code>where node</code> (Windows) or <code>which node</code> (macOS, Linux) prints it.</p></details>
</section>

<section class="card"><h2>2. Sign in once, in a terminal</h2>
  <p>Claude never signs in for you. On that computer, run this and type your password and an authenticator code:</p>
  ${copyable('cs-login', loginCommand(opts))}
</section>

<section class="card"><h2>3a. Claude Desktop</h2>
  <p>In Claude Desktop: <strong>Settings &gt; Developer &gt; Edit Config</strong>. That opens
  <code id="cs-where">${CONFIG_LOCATION[os]}</code>. If the file is empty, replace it with:</p>
  ${copyable('cs-desktop', desktopConfig(desktopEntry(opts)))}
  <p><strong>Already has settings?</strong> Pick that file here and this page adds ${site.name} to it, keeping everything else.
  The file is read in your browser only.</p>
  <label>Your claude_desktop_config.json <input id="cs-config" type="file" accept=".json,application/json"></label>
  <div id="cs-merged-box" hidden>
    <p id="cs-merged-note" class="small muted" hidden></p>
    <div class="cs-copy"><pre class="install"><code id="cs-merged"></code></pre><button type="button" class="btn ghost small" data-copy="cs-merged">Copy</button></div>
    <button type="button" id="cs-download" class="btn small" hidden>Download the new claude_desktop_config.json</button>
    <p class="small muted">Save it over the old one (or paste the copy into the editor), then quit Claude Desktop completely (from the tray or menu bar) and open it again.</p>
  </div>
</section>

<section class="card"><h2>3b. Claude Code</h2>
  <p>One command, in a terminal on that computer. <code>--scope user</code> makes it available in every folder, not just this one:</p>
  ${copyable('cs-code', claudeCodeCommand(opts))}
  <p class="small muted">Or, as a plugin with its skill and commands: <code>/plugin marketplace add</code> followed by the code's folder, then <code>/plugin install gitcha@gitcha</code>.</p>
</section>

<section class="card"><h2>4. Try it</h2>
  <p>Ask Claude: <em>“What's my ${site.name} status?”</em> It should name your account and when the next two-factor check is due.
  When a check is due, Claude asks you for a code; publishing always asks for a fresh one.</p>
  <ul class="small">
    <li><strong>“not signed in”</strong>: run step 2 on the same computer (and the same system: Windows or WSL) that Claude runs on.</li>
    <li><strong>No ${site.name} tools</strong> (they are named <code>gitcha_…</code>): check the path in step 1 exists, that <code>node -v</code> works, then restart Claude fully.</li>
    <li><strong>A Claude session in the cloud</strong> (claude.ai/code) runs on Anthropic's computers, so it cannot reach a copy running on yours, only one on the internet with https.</li>
  </ul>
</section>
</div>
<script src="/static/claude-setup.js" type="module"></script>`;
}
