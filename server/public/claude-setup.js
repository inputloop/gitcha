// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The "Connect Claude" page, in the browser: it writes the Claude Desktop and Claude Code settings for the
// Gitcha MCP server from what the person types and picks. Nothing leaves the browser: the files picked are
// read here, and the finished config is offered as a download.
//
// Browsers never tell a page where a picked file lives (only its name), so the folder is typed or pasted;
// the file pickers check that the right file was found, and merge Gitcha into an existing config file.
// The functions below are also used by the server (to draw the page before this script runs) and the tests.

export const DEFAULT_SERVER = 'http://localhost:4873';
const MARKER = 'The Gitcha Claude extension: an MCP server';

/** Where Claude Desktop keeps its settings file, on each system. */
export const CONFIG_LOCATION = {
  windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
  mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
  linux: '~/.config/Claude/claude_desktop_config.json',
};

/**
 * The full path of gitcha-mcp.js from what was typed: the Gitcha folder, or the file itself. Quotes from
 * "Copy as path" and trailing slashes are dropped; Windows paths keep "\", the others "/".
 */
export function mcpPath(input, os = 'windows') {
  let p = String(input ?? '').trim().replace(/^["']|["']$/g, '').trim();
  if (!p) return '';
  const sep = p.includes('\\') || (os === 'windows' && !p.includes('/')) ? '\\' : '/';
  p = p.replace(/[\\/]+$/, '');
  if (/gitcha-mcp\.js$/i.test(p)) return p;
  // The extension folder or its bin folder are fine too.
  if (/[\\/]bin$/i.test(p) && /extension[\\/]bin$/i.test(p)) return `${p}${sep}gitcha-mcp.js`;
  if (/[\\/]extension$/i.test(p)) return `${p}${sep}bin${sep}gitcha-mcp.js`;
  return [p, 'extension', 'bin', 'gitcha-mcp.js'].join(sep);
}

/** The CLI beside the MCP server: the same folder, gitcha.js. */
export const cliPath = (mcp) => mcp.replace(/gitcha-mcp\.js$/i, 'gitcha.js');

/** A server address as the CLI stores it: scheme, host and port, nothing after. */
export function cleanServer(s) {
  try { return new URL(String(s ?? '').trim() || DEFAULT_SERVER).origin; } catch { return DEFAULT_SERVER; }
}

/** The "gitcha" entry for claude_desktop_config.json's mcpServers. */
export function desktopEntry({ mcp, server = DEFAULT_SERVER, node = 'node' }) {
  return { command: String(node || 'node').trim().replace(/^["']|["']$/g, '') || 'node', args: [mcp || 'PATH\\TO\\gitcha\\extension\\bin\\gitcha-mcp.js'], env: { GITCHA_SERVER: cleanServer(server) } };
}

/** A whole claude_desktop_config.json holding only Gitcha. */
export const desktopConfig = (entry) => JSON.stringify({ mcpServers: { gitcha: entry } }, null, 2);

/**
 * Add Gitcha to an existing claude_desktop_config.json (its text). Everything already in it is kept; an
 * older "gitcha" entry is replaced. Returns { text, replaced } or { error }.
 */
export function mergeConfig(existing, entry) {
  const src = String(existing ?? '').replace(/^﻿/, '').trim();
  let cfg = {};
  if (src) {
    try { cfg = JSON.parse(src); } catch (err) { return { error: `That file is not valid JSON (${err.message}). Fix it, or start from the snippet above.` }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { error: 'That file does not hold a settings object ({ ... }).' };
  }
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers) ? cfg.mcpServers : {};
  const replaced = Object.hasOwn(servers, 'gitcha');
  cfg.mcpServers = { ...servers, gitcha: entry };
  return { text: `${JSON.stringify(cfg, null, 2)}\n`, replaced };
}

const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
/** The Claude Code command that adds the server for every folder (--scope user). */
export function claudeCodeCommand({ mcp, server = DEFAULT_SERVER, node = 'node' }) {
  return `claude mcp add --scope user gitcha --env GITCHA_SERVER=${cleanServer(server)} -- ${q(String(node || 'node'))} ${q(mcp || 'PATH/TO/gitcha/extension/bin/gitcha-mcp.js')}`;
}

/** The sign-in command (the one step Claude never does). */
export function loginCommand({ mcp, server = DEFAULT_SERVER, node = 'node' }) {
  const s = cleanServer(server);
  return `${q(String(node || 'node'))} ${q(cliPath(mcp || 'PATH/TO/gitcha/extension/bin/gitcha-mcp.js'))} login${s === DEFAULT_SERVER ? '' : ` --server ${s}`}`;
}

/** Is this text Gitcha's MCP server? (It names itself in its opening comment.) */
export const isGitchaMcp = (text) => String(text ?? '').includes(MARKER);

/** Which system the browser runs on, as a best guess. */
export function guessOs(ua = '') {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'mac';
  return /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : 'windows';
}

// ---- the page ---------------------------------------------------------------------------------------------
if (typeof document !== 'undefined' && document.getElementById('cs')) {
  const $ = (id) => document.getElementById(id);
  const root = $('cs');
  const read = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsText(file); });
  const note = (id, text, ok) => { const e = $(id); e.textContent = text; e.className = `small ${ok === true ? 'cs-ok' : ok === false ? 'cs-bad' : 'muted'}`; e.hidden = !text; };
  let existing = null; // the picked claude_desktop_config.json, as text

  if (!root.dataset.osChosen) $('cs-os').value = guessOs(navigator.userAgent);

  const draw = () => {
    const os = $('cs-os').value;
    const opts = { mcp: mcpPath($('cs-folder').value, os), server: $('cs-server').value, node: $('cs-node').value };
    const entry = desktopEntry(opts);
    $('cs-path').textContent = opts.mcp || '(type the folder above)';
    $('cs-login').textContent = loginCommand(opts);
    $('cs-desktop').textContent = desktopConfig(entry);
    $('cs-code').textContent = claudeCodeCommand(opts);
    $('cs-where').textContent = CONFIG_LOCATION[os];
    if (existing !== null) {
      const m = mergeConfig(existing, entry);
      $('cs-merged-box').hidden = false;
      if (m.error) { $('cs-merged').textContent = ''; note('cs-merged-note', m.error, false); $('cs-download').hidden = true; } else {
        $('cs-merged').textContent = m.text;
        note('cs-merged-note', m.replaced ? 'Your other settings are kept; the old "gitcha" entry is replaced.' : 'Your other settings are kept; "gitcha" is added.', true);
        $('cs-download').hidden = false;
      }
    }
  };
  for (const id of ['cs-os', 'cs-folder', 'cs-server', 'cs-node']) $(id).addEventListener('input', draw);

  // Check the picked gitcha-mcp.js. Its folder cannot be known from here, so this only confirms the file.
  $('cs-check').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const ok = isGitchaMcp(await read(f.slice(0, 4096)));
    note('cs-check-note', ok ? `Found it: ${f.name} is Gitcha's MCP server. Make sure the folder above is the one it is in.` : `${f.name} is not Gitcha's MCP server. Pick extension/bin/gitcha-mcp.js in your Gitcha folder.`, ok);
  });
  // Merge into the person's own claude_desktop_config.json.
  $('cs-config').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    existing = f.size > 1024 * 1024 ? '!' : await read(f);
    draw();
  });
  $('cs-download').addEventListener('click', () => {
    const blob = new Blob([$('cs-merged').textContent], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'claude_desktop_config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  // Copy buttons: the clipboard where the browser allows it (https or localhost), else select the text.
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const el = $(b.dataset.copy);
      try { await navigator.clipboard.writeText(el.textContent); b.textContent = 'Copied'; } catch {
        const range = document.createRange(); range.selectNodeContents(el);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); b.textContent = 'Selected: press Ctrl+C';
      }
      setTimeout(() => { b.textContent = 'Copy'; }, 2500);
    });
  }
  draw();
}
