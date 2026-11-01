#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Checks that every web page fits phones, tablets and desktops. It starts a real Gitcha server in a temp
// folder, fills it with the same demo data as screenshots.mjs, signs in with a real 2FA code, and opens
// each page at the widths below with Playwright (a tool that drives a real browser).
//
//   node scripts/responsive-check.mjs      (or: npm run check:responsive)
//
// A page fails when it scrolls sideways (the page is wider than the screen), or, at phone widths, when a
// header link, a tab, a button or a form control is less than 44px tall (too small to tap easily).
// It prints one line per page and exits with 1 if anything failed, naming the page and the width.
// Signing in waits for fresh authenticator codes, so a run takes about one to two minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config.js';
import { createApp } from '../server/src/app.js';
import { totp, timeStep } from '../server/src/totp.js';
import { sha256 } from '../server/src/crypto.js';
import { pack } from '../extension/lib/pack.js';
import { packFiles } from '../extension/lib/tar.js';
import { seedCommunity } from './demo-data.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GITCHA_CHECK_PORT ?? 4874);
const URL_ = `http://localhost:${PORT}`;
const WIDTHS = [360, 390, 768, 1024, 1440, 1920];
const PHONE = new Set([360, 390]);
const MIN_TAP = 44;
const PASSWORD = 'correct horse battery staple';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-responsive-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStep = -1;
/** A code from a time step that has not been used yet (waits until the next step if needed). */
async function freshCode(secret) {
  while (timeStep() <= lastStep) await sleep(500);
  lastStep = timeStep();
  return totp(secret);
}

// ---- server and demo data -----------------------------------------------------------------
// The same settings as screenshots.mjs: billing on with placeholder keys (nothing is ever paid) and a ring.
const config = loadConfig({ GITCHA_PORT: String(PORT), GITCHA_HOSTING_DOMAINS: 'pages.example.net', GITCHA_SSH_HOST: 'gitcha.example.org', GITCHA_SSH_USER: 'gitcha' }, {
  dataDir: path.join(tmp, 'data'), publicUrl: URL_,
  billing: { enabled: true, currency: 'USD', plansFile: null, stripe: { secretKey: 'sk_test_placeholder', webhookSecret: null, api: 'https://stripe.invalid' }, paypal: { clientId: 'placeholder', clientSecret: 'placeholder', webhookId: null, api: 'https://paypal.invalid' }, priceIds: { stripe: { pro: 'price_demo', team: 'price_demo_team' }, paypal: { pro: 'P-DEMO', team: null } } },
  ring: { name: 'inputloop Gitcha', description: 'The inputloop community forge.', operator: 'inputloop', peers: ['https://forge.example.org', 'https://code.example.net'], refresh: 3600_000 },
});
const app = createApp(config);
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));

// Users are made directly through app.auth. Only alice's secret is kept, to sign in with later.
let aliceSecret;
for (const [name, pw] of [['alice', PASSWORD], ['bob', 'blue whale passphrase'], ['carol', 'green field passphrase']]) {
  const r = app.auth.register({ username: name, password: pw, ip: '127.0.0.1' });
  app.auth.confirmEnrollment({ enrollToken: r.enrollToken, code: totp(r.secret), ip: '127.0.0.1' });
  if (name === 'alice') aliceSecret = r.secret;
}
lastStep = timeStep();
const u = (n) => app.store.userByName(n);
app.teams.create(u('alice'), { name: 'acme', description: 'Acme platform team' }, '127.0.0.1');
app.teams.setMember(u('alice'), 'acme', 'bob', 'maintainer', '127.0.0.1');
app.teams.setMember(u('alice'), 'acme', 'carol', 'member', '127.0.0.1');
for (const name of ['hello-world', 'tiny-logger', 'color-utils', 'design-tokens']) {
  const { tarball } = pack(path.join(root, 'examples', name));
  app.packages.publish(u('alice'), { tarball, integrity: `sha256-${sha256(tarball)}` }, '127.0.0.1');
}
app.packages.transfer(u('alice'), 'color-utils', 'acme', '127.0.0.1');
// A README written for GitHub, with HTML in it (centered logo, badges, screenshot tables): Gitcha's own.
{
  const files = [{ path: 'gitcha.json', data: JSON.stringify({ name: 'gitcha-readme', version: '1.0.0', description: "Gitcha's README, as a package", license: 'CC-BY-SA-4.0' }) },
    { path: 'README.md', data: fs.readFileSync(path.join(root, 'README.md')) }, { path: 'server/public/logo.svg', data: fs.readFileSync(path.join(root, 'server/public/logo.svg')) },
    ...['01-landing', '20-project', 'mobile-20-project'].map((n) => ({ path: `docs/screenshots/${n}.png`, data: fs.readFileSync(path.join(root, `docs/screenshots/${n}.png`)) }))];
  const tarball = packFiles(files);
  app.packages.publish(u('alice'), { tarball, integrity: `sha256-${sha256(tarball)}` }, '127.0.0.1');
}
const { p1, sr } = await seedCommunity(app, { port: PORT, tmp });
const ticket = Object.values(app.store.data.ops?.tickets ?? {})[0];

// ---- measuring one page ------------------------------------------------------------------------
// Runs inside the browser. Returns the page width and every small tap target that can be seen.
function measure(minTap) {
  const doc = document.documentElement;
  const small = [];
  const targets = document.querySelectorAll('.topbar nav a, .topbar summary, nav.tabs a, button, .btn, select, textarea, summary, '
    + 'input:not([type=hidden]):not([type=checkbox]):not([type=radio])');
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!r.width || !r.height || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    // Things inside a closed <details> (such as the phone menu) cannot be tapped until it opens.
    const box = el.closest('details');
    if (box && !box.open && !el.closest('summary')) continue;
    if (r.height < minTap - 0.5) {
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      small.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''} "${name}" ${Math.round(r.height)}px`);
    }
  }
  return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, small };
}

const failures = [];
const results = [];
/** Checks the page that is open now at every width, by resizing the window. */
async function checkOpenPage(page, label) {
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const m = await page.evaluate(measure, MIN_TAP);
    const problems = [];
    if (m.scrollWidth > m.innerWidth) problems.push(`scrolls sideways (${m.scrollWidth}px wide on a ${m.innerWidth}px screen)`);
    if (PHONE.has(width) && m.small.length) problems.push(`tap targets under ${MIN_TAP}px: ${m.small.slice(0, 6).join(', ')}${m.small.length > 6 ? ` and ${m.small.length - 6} more` : ''}`);
    if (problems.length) { bad.push(width); failures.push(`${label} at ${width}px: ${problems.join('; ')}`); }
  }
  results.push({ label, bad });
  console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${label}${bad.length ? `  (at ${bad.join(', ')}px)` : ''}`);
}
/** Opens a page and checks it at every width. */
async function check(page, pathname, label = pathname) {
  await page.setViewportSize({ width: WIDTHS.at(-1), height: 900 });
  await page.goto(`${URL_}${pathname}`);
  await checkOpenPage(page, label);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 900 }, colorScheme: 'light' });
const page = await ctx.newPage();
console.log(`Checking pages at ${WIDTHS.join(', ')}px wide`);

// ---- signed out ------------------------------------------------------------------------------------
await check(page, '/');
await check(page, '/login');
await check(page, '/ring');
await check(page, '/packages');
// A new account in the browser: the sign-up form, the authenticator setup and the recovery codes.
await check(page, '/register');
await page.fill('input[name=username]', 'dave');
await page.fill('input[name=password]', 'purple monkey dishwasher');
await page.fill('input[name=confirm]', 'purple monkey dishwasher');
await page.click('main button.btn');
await page.waitForURL('**/setup-2fa');
await checkOpenPage(page, '/setup-2fa');
const daveSecret = (await page.textContent('.secret')).replace(/\s/g, '');
await page.fill('input[name=code]', await freshCode(daveSecret));
await page.click('main form button.btn');
await page.waitForSelector('.codes');
await checkOpenPage(page, '/setup-2fa (recovery codes)');

// ---- sign in as alice -----------------------------------------------------------------------------
await page.goto(`${URL_}/login`);
await page.fill('input[name=username]', 'alice');
await page.fill('input[name=password]', PASSWORD);
await page.click('main form button.btn');
await page.waitForURL('**/login/2fa**');
await checkOpenPage(page, '/login/2fa');
await page.fill('input[name=code]', await freshCode(aliceSecret));
await page.click('main form button.btn');
await page.waitForURL((url) => !url.pathname.startsWith('/login'));

// The phone menu: it must open with the keyboard and show every header link.
await page.setViewportSize({ width: 360, height: 900 });
await page.goto(`${URL_}/crawl`);
await page.focus('.nav-menu summary');
await page.keyboard.press('Enter');
const menuLinks = await page.$$eval('.nav-menu nav a', (as) => as.filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.getAttribute('href')));
if (!menuLinks.includes('/messages') || !menuLinks.includes('/account')) failures.push(`phone menu at 360px: did not open with the keyboard (links seen: ${menuLinks.join(' ') || 'none'})`);
await checkOpenPage(page, '/crawl (phone menu open)');

// ---- signed in: every page the screenshots show, and every header link -------------------------
const header = await page.$$eval('.nav-menu nav a', (as) => as.map((a) => a.getAttribute('href')));
const pages = [
  '/crawl', '/t/parsers', `/p/${p1.id}`, '/projects', '/projects/alice/tiny-parser', '/projects/alice/tiny-parser/files', '/projects/alice/tiny-parser/files?path=parse.js', `/tasks/${sr.id}`,
  '/packages', '/packages/tiny-logger', '/packages/gitcha-readme', '/packages/tiny-logger/v/latest/files', '/packages/tiny-logger/v/latest/files?path=README.md', '/packages/design-tokens', '/agents', '/a/cora', '/u/alice', '/@alice',
  '/teams', '/teams/acme', '/account', '/keys', '/billing', '/ring', '/support', ticket ? `/support/${ticket.id}` : null,
  '/verify?reason=interval&next=/packages', '/claude', ...header,
];
for (const p of [...new Set(pages.filter(Boolean))]) {
  // /messages is new and may not exist yet. Its page (or the "not found" page) is still checked.
  await check(page, p);
}
// The dark theme uses the same layout, but check one busy page in it too.
await page.emulateMedia({ colorScheme: 'dark' });
await check(page, '/projects/alice/tiny-parser', '/projects/alice/tiny-parser (dark)');

await browser.close();
await new Promise((r) => app.server.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

const checks = results.length * WIDTHS.length;
if (failures.length) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'} in ${results.length} pages x ${WIDTHS.length} widths:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} pages pass at ${WIDTHS.length} widths (${checks} checks).`);
process.exit(0);
