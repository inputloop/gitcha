#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Regenerates docs/screenshots/*.png from a real, freshly started Gitcha
// server: browser pages via Playwright, plus real CLI output and real MCP tool
// calls rendered as terminal/transcript images.
//
//   node scripts/screenshots.mjs        (needs Playwright + Chromium installed)
//
// It waits for new TOTP time steps between codes (codes are single-use), so a
// full run takes about two minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config.js';
import { createApp } from '../server/src/app.js';
import { totp, timeStep } from '../server/src/totp.js';
import { sha256 } from '../server/src/crypto.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'screenshots');
const CLI = path.join(root, 'extension', 'bin', 'gitcha.js');
const MCP = path.join(root, 'extension', 'bin', 'gitcha-mcp.js');
const PORT = 4873;
const URL_ = `http://localhost:${PORT}`;
const USER = 'alice';
const PASSWORD = 'correct horse battery staple';

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-shots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStep = -1;
/** A code from a time step that has not been used yet. */
async function freshCode(secret) {
  while (timeStep() <= lastStep) await sleep(500);
  lastStep = timeStep();
  return totp(secret);
}

// ---- server -----------------------------------------------------------------
// Billing is switched on with placeholder keys so its page renders; no provider is ever called.
const config = loadConfig({ GITCHA_PORT: String(PORT), GITCHA_HOSTING_DOMAINS: 'pages.example.net', GITCHA_SSH_HOST: 'gitcha.example.org', GITCHA_SSH_USER: 'gitcha' }, {
  dataDir: path.join(tmp, 'data'), publicUrl: URL_,
  billing: { enabled: true, currency: 'USD', plansFile: null, stripe: { secretKey: 'sk_test_placeholder', webhookSecret: null, api: 'https://stripe.invalid' }, paypal: { clientId: 'placeholder', clientSecret: 'placeholder', webhookId: null, api: 'https://paypal.invalid' }, priceIds: { stripe: { pro: 'price_demo', team: 'price_demo_team' }, paypal: { pro: 'P-DEMO', team: null } } },
  ring: { name: 'inputloop Gitcha', description: 'The inputloop community forge.', operator: 'inputloop', peers: ['https://forge.example.org', 'https://code.example.net'], refresh: 3600_000 },
});
const app = createApp(config);
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
console.log(`server on ${URL_}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await ctx.newPage();
const shot = async (name, opts = {}) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  console.log(`  ✓ ${name}.png`);
};

// ---- browser: sign-up with mandatory 2FA -----------------------------------------
await page.goto(URL_);
await shot('01-landing');

await page.goto(`${URL_}/register`);
await page.fill('input[name=username]', USER);
await page.fill('input[name=password]', PASSWORD);
await page.fill('input[name=confirm]', PASSWORD);
await page.fill('input[name=email]', 'alice@example.org');
await page.fill('input[name=email_confirm]', 'alice@example.org');
await shot('02-register');
await page.click('main button.btn');

await page.waitForURL('**/setup-2fa');
const secret = (await page.textContent('.secret')).replace(/\s/g, '');
await shot('03-setup-2fa', { fullPage: true });
await page.fill('input[name=code]', await freshCode(secret));
await page.click('main form button.btn');
await page.waitForSelector('.codes');
await shot('04-recovery-codes', { fullPage: true });

await page.click('main a.btn');
await page.waitForURL('**/login?msg=activated');
await page.fill('input[name=username]', USER);
await page.fill('input[name=password]', PASSWORD);
await shot('05-login');
await page.click('main form button.btn');
await page.waitForURL('**/login/2fa**');
const webCode = await freshCode(secret);
await page.fill('input[name=code]', webCode.replace(/(\d{3})(\d{3})/, '$1 $2'));
await shot('06-login-2fa');
await page.click('main form button.btn');
await page.waitForURL('**/packages');

// ---- CLI: first-run login, publish, install --------------------------------------
const cliEnv = { ...process.env, GITCHA_CONFIG_DIR: path.join(tmp, 'cli'), GITCHA_SERVER: URL_, FORCE_COLOR: '1' };
delete cliEnv.NO_COLOR;
const project = path.join(tmp, 'my-app');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'gitcha.json'), JSON.stringify({ name: 'my-app', version: '0.1.0', license: 'MIT' }, null, 2));

// Async on purpose: a synchronous spawn would block this process, which is also the server.
async function cli(args, { input = '', cwd = project, show = [] } = {}) {
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: cliEnv, cwd });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  // Interleave stderr (prompts) and stdout as a terminal would show them.
  let text = r.stderr + r.stdout;
  if (args[0] === 'login') {
    // Rebuild the order a terminal shows: banner, user/password prompts, "accepted", code prompt, result.
    const o = r.stdout.split('\n'), e = r.stderr.split('\n');
    text = [o[0], e[0], e[1], o[1], e[2], ...o.slice(2)].join('\n')
      .replace(cliEnv.GITCHA_CONFIG_DIR + path.sep, '~/.config/gitcha/');
  }
  for (const [prompt, typed] of show) text = text.replace(`${prompt}\x1b[0m: \n`, `${prompt}\x1b[0m: ${typed}\n`);
  if (r.status !== 0) throw new Error(`gitcha ${args.join(' ')} failed:\n${text}`);
  return { cmd: `gitcha ${args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`, text };
}

const cliCode = await freshCode(secret);
const loginRun = await cli(['login', '--device', 'laptop'], {
  input: `${USER}\n${PASSWORD}\n${cliCode}\n`, show: [['Username', USER], ['Password', ''], ['Authenticator code', cliCode]],
});
const statusRun = await cli(['status']);
const publishRuns = [];
for (const p of ['hello-world', 'tiny-logger', 'color-utils']) publishRuns.push(await cli(['publish', path.join(root, 'examples', p)], { cwd: root }));
publishRuns.forEach((r) => { r.cmd = r.cmd.replace(root + path.sep, ''); });
// Teams: a second and third user, a shared team, and a team-only package.
for (const [name, pw] of [['bob', 'blue whale passphrase'], ['carol', 'green field passphrase']]) {
  const r = app.auth.register({ username: name, password: pw, ip: '127.0.0.1' });
  app.auth.confirmEnrollment({ enrollToken: r.enrollToken, code: totp(r.secret), ip: '127.0.0.1' });
}
const teamRuns = [
  await cli(['team', 'create', 'acme', '--description', 'Acme platform team']),
  await cli(['team', 'add', 'acme', 'bob', '--role', 'maintainer']),
  await cli(['team', 'add', 'acme', 'carol']),
  await cli(['publish', path.join(root, 'examples', 'design-tokens')], { cwd: root }),
  await cli(['transfer', 'color-utils', 'acme']),
  await cli(['team', 'info', 'acme']),
];
teamRuns[3].cmd = teamRuns[3].cmd.replace(root + path.sep, '');
const searchRun = await cli(['search']);
const installRun = await cli(['install', 'tiny-logger']);
const securityRun = await cli(['security']);

// ---- browser: registry pages -----------------------------------------------------
await page.goto(`${URL_}/packages`);
await shot('07-packages');
await page.goto(`${URL_}/packages/tiny-logger`);
await shot('08-package', { fullPage: true });
await page.goto(`${URL_}/account`);
await shot('09-account', { fullPage: true });
await page.goto(`${URL_}/teams`);
await shot('15-teams');
await page.goto(`${URL_}/teams/acme`);
await shot('16-team', { fullPage: true });
await page.goto(`${URL_}/verify?reason=interval&next=/packages`);
await shot('10-step-up');

// ---- the forge and the community: agents, a Second Reader review, the crawl -------------
{
  const { execFile } = await import('node:child_process');
  const run = (args, cwd) => new Promise((res, rej) => execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
  const u = (n) => app.store.userByName(n);
  app.social.updateProfile(u('alice'), { displayName: 'Alice', bio: 'Parsers, compilers and long walks.' });
  app.social.updateProfile(u('bob'), { displayName: 'Bob' });
  app.social.updateProfile(u('carol'), { displayName: 'Carol' });
  app.agents.register(u('alice'), { handle: 'ada', name: 'Ada', model: 'claude-opus-5-5', description: 'Writes parsers and the tests that keep them honest.' }, 'demo');
  app.agents.register(u('bob'), { handle: 'bix', name: 'Bix', model: 'claude-sonnet-5-5', description: 'Edge cases are my hobby.' }, 'demo');
  app.agents.register(u('carol'), { handle: 'cora', name: 'Cora', model: 'claude-haiku-5-5', description: 'An independent second reader.' }, 'demo');
  app.agents.setReviewPrefs(u('carol'), 'cora', { enabled: true, anything: true }, 'demo');
  app.agents.setReviewPrefs(u('alice'), 'ada', { enabled: true, tags: ['parsers', 'rust'], teams: ['acme'] }, 'demo');
  const proj = app.projects.create(u('alice'), { name: 'tiny-parser', description: 'A small, well-tested expression parser.', visibility: 'public', tags: ['parsers'] }, 'demo');
  app.projects.setTaskTracking(u('alice'), proj, true, 'demo');
  app.projects.setCollaborator(u('alice'), proj, { agent: 'bix' }, 'demo');
  app.tasks.create({ kind: 'user', user: u('alice') }, proj, { title: 'Document operator precedence', tags: [] });
  const ta = app.auth.createSession(u('alice'), { kind: 'console', name: 'console: demo', ip: '127.0.0.1' }).token;
  const tb = app.auth.createSession(u('bob'), { kind: 'console', name: 'console: demo', ip: '127.0.0.1' }).token;
  const repo = path.join(tmp, 'tiny-parser');
  fs.mkdirSync(repo);
  await run(['init', '-q', '-b', 'main'], repo);
  const commitAs = async (file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); await run(['add', file], repo); await run(['-c', 'user.name=Demo', '-c', 'user.email=demo@example.org', 'commit', '-q', '-m', msg], repo); };
  await commitAs('parse.js', 'export function parse(s) { /* ... */ }\n', 'feat: parse +, -, * and /\n\nAda (for Alice, claude-opus-5-5)');
  await commitAs('parse.test.js', 'test("1+2*3", () => {});\n', 'test: precedence cases\n\nAda (for Alice, claude-opus-5-5)');
  await run(['push', '-q', `http://ada:${ta}@127.0.0.1:${PORT}/git/alice/tiny-parser.git`, 'main'], repo);
  await commitAs('parse.js', 'export function parse(s) { /* handles empty input */ }\n', 'fix: empty input and unary minus\n\nBix (for Bob, claude-sonnet-5-5)');
  await run(['push', '-q', `http://bix:${tb}@127.0.0.1:${PORT}/git/alice/tiny-parser.git`, 'main'], repo);
  const sr = Object.values(app.tasks.data).find((t) => t.kind === 'second_reader');
  app.tasks.claim({ kind: 'user', user: u('carol') }, sr.id, { agent: 'cora' });
  app.tasks.submitReview({ kind: 'user', user: u('carol') }, sr.id, {
    verdict: 'request_changes', summary: 'Read all three commits and ran the tests. Precedence is right; unary minus after an operator still fails, and one test name is misleading.',
    findings: [{ title: 'Unary minus after an operator is parsed as subtraction', severity: 'high', path: 'parse.js', detail: '"2*-3" returns 2-3.' }, { title: 'Test name says precedence but checks associativity', severity: 'low', path: 'parse.test.js' }],
  });
  app.tasks.decideFinding(u('alice'), sr.id, 'f1', true);

  const pa = { kind: 'user', user: u('alice') }, pb = { kind: 'user', user: u('bob') }, pc = { kind: 'user', user: u('carol') };
  const p1 = app.social.create(pa, { title: 'How we test parsers with two agents and a second reader', body: 'Ada wrote the parser, Bix found the edge cases, and **Cora** read both. Notes in #parsers; the review is on the project page.', tags: ['parsers', 'agents'] });
  app.social.create(pb, { parent: p1.id, body: 'Bix is very proud of the unary minus fix.' });
  app.social.create(pc, { parent: p1.id, body: 'Cora found one more; it is in the review. #second-reader' });
  for (const p of [pb, pc]) app.social.vote(p, p1.id, 1);
  app.social.create(pb, { title: 'Bix here: looking for repos with gnarly edge cases', body: 'Add me as a collaborator and I will push tests that break things politely.', tags: ['agents', 'testing'], asAgent: 'bix' });
  app.social.create(pc, { title: 'What makes a good finding?', body: 'A path, a reproduction, and a severity you can defend. Accepted findings earn budget for the agent and its owner.', tags: ['second-reader'] });
  app.ops.file(u('alice'), { scope: 'user', kind: 'question', title: 'Can a team pay with PayPal?', body: 'We would like to move our team to the Team plan.' });
  app.store.tx((d) => { d.ring.peers = {
    'https://forge.example.org': { name: 'Example Forge', description: 'A Gitcha for a makerspace.', paid: ['Pro plan (5 per month)'], ok: true },
    'https://code.example.net': { name: 'code.example.net', description: 'A one-person instance.', paid: [], ok: true },
  }; });

  await page.goto(`${URL_}/crawl`);
  await shot('18-crawl', { fullPage: true });
  await page.goto(`${URL_}/p/${p1.id}`);
  await shot('19-thread', { fullPage: true });
  await page.goto(`${URL_}/projects/alice/tiny-parser`);
  await shot('20-project', { fullPage: true });
  await page.goto(`${URL_}/tasks/${sr.id}`);
  await shot('21-second-reader', { fullPage: true });
  await page.goto(`${URL_}/a/cora`);
  await shot('22-agent', { fullPage: true });
  await page.goto(`${URL_}/agents`);
  await shot('23-agents', { fullPage: true });
  await page.goto(`${URL_}/keys`);
  await shot('24-keys', { fullPage: true });
  await page.goto(`${URL_}/billing`);
  await shot('25-billing', { fullPage: true });
  await page.goto(`${URL_}/ring`);
  await shot('26-ring', { fullPage: true });
  await page.goto(`${URL_}/support`);
  await shot('27-support', { fullPage: true });
}

// ---- Claude extension: real MCP tool calls --------------------------------------------
const mcp = spawn(process.execPath, [MCP], { env: { ...cliEnv, FORCE_COLOR: '' }, cwd: project });
let buf = '';
const waiters = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiters.get(msg.id)?.(msg);
  }
});
let rid = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++rid; waiters.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'screenshot', version: '1' } });
const transcript = [];
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  transcript.push({ type: 'tool', name, args, text: r.result.content[0].text, isError: Boolean(r.result.isError) });
};
const say = (who, text) => transcript.push({ type: who, text });

say('user', 'Find me a logging library on our Gitcha registry.');
await call('gitcha_search', { query: 'log' });
say('assistant', 'tiny-logger 2.1.0 looks like a fit: zero dependencies, GPL-3.0-or-later. Installing it into this project.');
// Pretend the device's last 2FA was 13 hours ago so the periodic check fires.
const cliToken = JSON.parse(fs.readFileSync(path.join(cliEnv.GITCHA_CONFIG_DIR, 'credentials.json'), 'utf8')).servers[URL_].token;
app.store.tx((d) => { d.sessions[sha256(cliToken)].mfaAt = Date.now() - 13 * 3600_000; });
await call('gitcha_install', { name: 'tiny-logger', directory: project });
say('assistant', 'Gitcha is asking for its periodic two-factor check. What is the current 6-digit code in your authenticator app?');
const mcpCode = await freshCode(secret);
say('user', mcpCode);
await call('gitcha_verify_2fa', { code: mcpCode });
await call('gitcha_install', { name: 'tiny-logger', directory: project });
say('assistant', 'Done: tiny-logger@2.1.0 is in gitcha_modules/ and pinned in gitcha-lock.json.');
mcp.kill();

// ---- render terminal + transcript images -------------------------------------------
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function ansiToHtml(s) {
  const COLORS = { 1: 'b', 2: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 35: 'magenta', 36: 'cyan' };
  let html = '', open = 0;
  for (const part of esc(s).split(/(\x1b\[\d+m)/)) {
    const m = /\x1b\[(\d+)m/.exec(part);
    if (!m) { html += part; continue; }
    if (m[1] === '0') { html += '</span>'.repeat(open); open = 0; } else { html += `<span class="${COLORS[m[1]] ?? ''}">`; open++; }
  }
  return html + '</span>'.repeat(open);
}

const TERM_CSS = `body{margin:0;padding:28px;background:#e9ebf3;font-family:system-ui}
.win{width:860px;border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(20,26,45,.28);background:#141827}
.bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#1f2438;color:#9aa1bd;font-size:13px}
.dot{width:12px;height:12px;border-radius:50%}.title{margin-left:10px}
pre{margin:0;padding:18px 20px;color:#dfe3f2;font:13.5px/1.6 "JetBrains Mono","DejaVu Sans Mono",ui-monospace,monospace;white-space:pre-wrap}
.p{color:#18c5a8}.b{font-weight:700}.dim{color:#7d849f}.red{color:#ff6b88}.green{color:#5fe0a2}.yellow{color:#f5c95b}.magenta{color:#b79bff}.cyan{color:#6fd3ff}`;

async function renderTerminal(name, title, runs) {
  const body = runs.map((r) => `<span class="p">~/my-app $</span> <span class="b">${esc(r.cmd)}</span>\n${ansiToHtml(r.text.replace(/\n+$/, ''))}`).join('\n\n');
  const htmlDoc = `<!doctype html><meta charset="utf-8"><style>${TERM_CSS}</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${esc(title)}</span></div><pre>${body}</pre></div>`;
  const p = await ctx.newPage();
  await p.setContent(htmlDoc);
  await (await p.$('.win')).screenshot({ path: path.join(OUT, `${name}.png`) });
  await p.close();
  console.log(`  ✓ ${name}.png`);
}

await renderTerminal('11-cli-login', 'Terminal: first run', [loginRun, statusRun]);
await renderTerminal('12-cli-publish-install', 'Terminal: publish & install', [...publishRuns.slice(0, 2), searchRun, installRun]);
await renderTerminal('13-cli-security', 'Terminal: 2FA check settings', [securityRun]);
await renderTerminal('17-cli-teams', 'Terminal: teams', teamRuns);

const TX_CSS = `body{margin:0;padding:28px;background:#e9ebf3;font-family:Inter,system-ui,sans-serif;color:#151a2d}
.panel{width:860px;background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(20,26,45,.18);overflow:hidden}
.head{padding:14px 20px;border-bottom:1px solid #e3e6f0;font-weight:700;display:flex;gap:10px;align-items:center}
.head small{font-weight:500;color:#646b85}.list{padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:78%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5}
.user{align-self:flex-end;background:#6a4cf5;color:#fff}.assistant{align-self:flex-start;background:#f0f2f8}
.tool{border:1px solid #e3e6f0;border-radius:10px;overflow:hidden;font-size:13px}
.tool .name{padding:7px 12px;background:#f6f7fb;font-family:ui-monospace,monospace;color:#3b4bc8;border-bottom:1px solid #e3e6f0}
.tool.err .name{color:#b4233f;background:#fdecef}.tool pre{margin:0;padding:10px 12px;white-space:pre-wrap;font:12.5px/1.5 ui-monospace,"DejaVu Sans Mono",monospace;color:#2a3050}`;

{
  const items = transcript.map((t) => t.type === 'tool'
    ? `<div class="tool ${t.isError ? 'err' : ''}"><div class="name">⚙ ${esc(t.name)}(${esc(JSON.stringify(t.args).replace(project, '~/my-app'))})${t.isError ? ' → needs user action' : ''}</div><pre>${esc(t.text.replaceAll(project, '~/my-app').replaceAll(CLI, '…/gitcha.js'))}</pre></div>`
    : `<div class="msg ${t.type}">${esc(t.text)}</div>`).join('');
  const p = await ctx.newPage();
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${TX_CSS}</style><div class="panel"><div class="head"><img src="data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'server/public/logo.svg')).toString('base64')}" width="22"> Gitcha Claude extension <small>· real MCP tool calls and responses; chat messages are illustrative</small></div><div class="list">${items}</div></div>`);
  await (await p.$('.panel')).screenshot({ path: path.join(OUT, '14-claude-extension.png') });
  await p.close();
  console.log('  ✓ 14-claude-extension.png');
}

// Icon for the Claude Desktop extension bundle.
{
  const p = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${fs.readFileSync(path.join(root, 'server/public/logo.svg'), 'utf8').replace('<svg ', '<svg width="512" height="512" ')}`);
  await p.screenshot({ path: path.join(root, 'extension', 'icon.png'), omitBackground: true });
  await p.close();
}

await browser.close();
await new Promise((r) => app.server.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('done');
