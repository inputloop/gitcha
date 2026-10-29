// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The HTML for the browser pages in web.js, built on the server as text.
// Everything put into a page goes through esc(), which turns characters like < and " into safe codes.
// That stops XSS (a trick where someone's text is run as code in another person's browser).
import { isWebLink } from '../../extension/lib/manifest.js';

// esc: escape one value for use in HTML text or in a quoted attribute.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// raw marks text as already-safe HTML, so it is not escaped again. Use it only for HTML we built ourselves.
// out turns one value into HTML: raw values as they are, arrays joined, everything else escaped.
// h is a template tag: h`<p>${x}</p>` escapes every ${...} value unless it is raw or another h`` result.
const raw = (s) => ({ __html: s });
const out = (v) => (v && v.__html !== undefined ? v.__html : Array.isArray(v) ? v.map(out).join('') : esc(v));
export const h = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? out(vals[i]) : ''), ''));
export { raw };

// A time as plain words, such as "5 minutes ago" or "in 2 hours".
export const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  const f = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
  if (s < 0) { const m = Math.round(-s / 60); return m < 60 ? `in ${f(m, 'minute')}` : `in ${f(Math.round(m / 60), 'hour')}`; }
  if (s < 60) return 'just now';
  if (s < 3600) return `${f(Math.round(s / 60), 'minute')} ago`;
  if (s < 86400) return `${f(Math.round(s / 3600), 'hour')} ago`;
  return `${f(Math.round(s / 86400), 'day')} ago`;
};

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// The page frame around every page: head, top bar (with a sign-out form when signed in), main, footer.
// `body` should come from h``, because out() escapes plain strings.
export function layout({ title, user, csrf, body, wide = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Gitcha</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/static/logo.svg" alt="" width="28" height="28"> Gitcha</a>
  <nav>
    ${user ? `<a href="/crawl">Crawl</a><a href="/projects">Projects</a><a href="/packages">Packages</a><a href="/agents">Agents</a><a href="/teams">Teams</a><a href="/account">Account</a>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Sign out (${esc(user.username)})</button></form>`
    : `<a href="/login">Sign in</a><a class="btn small" href="/register">Create account</a>`}
  </nav>
</header>
<main class="${wide ? 'wide' : ''}">${out(body)}</main>
<footer><a href="/ring/prev" rel="prev">&#9664; prev</a> · <a href="/ring">Gitcha ring</a> · <a href="/ring/next" rel="next">next &#9654;</a> · <a href="/ring/random">random</a><br>Gitcha · free software forge and registry · <a href="/support">Support</a> · <a href="/api/v1/health">API status</a></footer>
</body>
</html>`;
}

// The hidden CSRF token field that every POST form must carry (see web.js).
export const csrfField = (csrf) => h`<input type="hidden" name="_csrf" value="${csrf}">`;
export const alert = (err, kind = 'error') => (err ? h`<div class="alert ${kind}" role="alert">${err}</div>` : '');

// The front page for visitors who are not signed in.
export const landing = () => h`
<section class="hero">
  <h1>Your own package registry,<br><span class="accent">locked down by default.</span></h1>
  <p class="lead">Gitcha is a free, self-hosted software repository. Every account is protected by a password
  <strong>and</strong> an authenticator app, and the registry asks you to re-confirm with a fresh code from time to time.</p>
  <div class="cta"><a class="btn" href="/register">Create an account</a><a class="btn ghost" href="/login">Sign in</a></div>
</section>
<section class="features">
  <div class="card"><h3>🔐 Two-factor everywhere</h3><p>TOTP codes from Google Authenticator, Authy, 1Password or Aegis are required to sign in and to install.</p></div>
  <div class="card"><h3>⏱ Intermittent checks</h3><p>Sessions and devices re-verify periodically, on new networks, and before sensitive actions. You choose which checks stay on.</p></div>
  <div class="card"><h3>🤖 Works with Claude</h3><p>The Gitcha Claude extension lets Claude search, install and publish packages, but never sees your password.</p></div>
  <div class="card"><h3>📦 Integrity-checked</h3><p>Every tarball is pinned by SHA-256, versions are immutable, and installs are verified before extraction.</p></div>
</section>`;

// Step 1 of sign-up: username, password and an optional email.
export const registerPage = ({ csrf, error, username = '', email = '', emailConfirm = '' }) => h`
<div class="auth-card">
  <ol class="steps"><li class="active">Account</li><li>Authenticator</li><li>Recovery codes</li></ol>
  <h1>Create your account</h1>
  ${alert(error)}
  <form method="post" action="/register">
    ${csrfField(csrf)}
    <label>Username <input name="username" value="${username}" autocomplete="username" required minlength="3" maxlength="32"></label>
    <label>Password <input type="password" name="password" autocomplete="new-password" required minlength="10"></label>
    <label>Confirm password <input type="password" name="confirm" autocomplete="new-password" required minlength="10"></label>
    <p class="hint">At least 10 characters. Passwords are hashed with scrypt and then encrypted (AES-256-GCM) before they are stored.</p>
    <label>Email <span class="muted">(optional)</span> <input type="email" name="email" value="${email}" autocomplete="email" maxlength="254"></label>
    <label>Confirm email <input type="email" name="email_confirm" value="${emailConfirm}" autocomplete="email" maxlength="254"></label>
    <p class="hint">Only if you want one on file. It is encrypted before it is stored and never shown to other people.</p>
    <button class="btn block">Continue to two-factor setup →</button>
  </form>
  <p class="muted center">Already have an account? <a href="/login">Sign in</a></p>
</div>`;

// Step 2 of sign-up: the QR code to scan, the secret key in groups of four, and the code box.
// qrSvg is put in as raw HTML; it comes from the QR code library, not from the user.
export const setup2faPage = ({ csrf, error, qrSvg, secret, username, issuer }) => h`
<div class="auth-card wide">
  <ol class="steps"><li class="done">Account</li><li class="active">Authenticator</li><li>Recovery codes</li></ol>
  <h1>Set up two-factor authentication</h1>
  <p>Two-factor authentication is <strong>required</strong>. Scan this code with Google Authenticator (or any TOTP app), then enter the 6-digit code it shows.</p>
  ${alert(error)}
  <div class="enroll">
    <div class="qr">${raw(qrSvg)}</div>
    <div>
      <p class="muted">Can't scan? Add an account manually:</p>
      <dl class="kv">
        <dt>Account</dt><dd>${issuer}:${username}</dd>
        <dt>Key</dt><dd><code class="secret">${secret.match(/.{1,4}/g).join(' ')}</code></dd>
        <dt>Type</dt><dd>Time-based, 6 digits, 30 seconds</dd>
      </dl>
      <form method="post" action="/setup-2fa">
        ${csrfField(csrf)}
        <label>6-digit code <input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></label>
        <button class="btn block">Verify and activate</button>
      </form>
    </div>
  </div>
</div>`;

// Step 3 of sign-up (or after making new codes): show the recovery codes once.
export const recoveryCodesPage = ({ codes, fresh = true }) => h`
<div class="auth-card">
  ${fresh ? h`<ol class="steps"><li class="done">Account</li><li class="done">Authenticator</li><li class="active">Recovery codes</li></ol>` : ''}
  <h1>Save your recovery codes</h1>
  <p>If you lose your phone, each of these codes can be used <strong>once</strong> instead of an authenticator code.
  They will not be shown again.</p>
  <ul class="codes">${codes.map((c) => h`<li><code>${c}</code></li>`)}</ul>
  <a class="btn block" href="${fresh ? '/login?msg=activated' : '/account'}">I've saved them: continue</a>
</div>`;

// The sign-in form. `next` is where to go after sign-in; web.js checks it with safeNext.
export const loginPage = ({ csrf, error, notice, username = '', next = '' }) => h`
<div class="auth-card">
  <h1>Sign in</h1>
  ${alert(notice, 'info')}${alert(error)}
  <form method="post" action="/login">
    ${csrfField(csrf)}<input type="hidden" name="next" value="${next}">
    <label>Username <input name="username" value="${username}" autocomplete="username" required autofocus></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn block">Continue</button>
  </form>
  <p class="muted center">New here? <a href="/register">Create an account</a></p>
</div>`;

// The form that asks for an authenticator code, used for sign-in and for step-up checks.
export const codePage = ({ csrf, error, action, title, message, next = '', reason }) => h`
<div class="auth-card">
  <div class="shield">🛡️</div>
  <h1>${title}</h1>
  ${reason ? h`<div class="alert info">${reason}</div>` : ''}
  <p>${message}</p>
  ${alert(error)}
  <form method="post" action="${action}">
    ${csrfField(csrf)}<input type="hidden" name="next" value="${next}">
    <label>Authenticator code <input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="24" required autofocus placeholder="123 456"></label>
    <button class="btn block">Verify</button>
  </form>
  <p class="muted center">Lost your phone? Enter one of your recovery codes instead.</p>
</div>`;

// The package list and search box.
export const packagesPage = ({ q, results }) => h`
<div class="page-head">
  <h1>Packages</h1>
  <form class="search" method="get" action="/packages"><input name="q" value="${q}" placeholder="Search packages…" aria-label="Search packages"><button class="btn">Search</button></form>
</div>
${results.length === 0 ? h`<div class="empty card"><p>No packages ${q ? h`match <strong>${q}</strong>` : 'yet'}.</p><p class="muted">Publish one with <code>gitcha publish</code> or ask Claude to do it.</p></div>` : ''}
<div class="pkg-list">
${results.map((p) => h`<a class="pkg card" href="/packages/${encodeURIComponent(p.name)}">
  <div class="pkg-top"><strong class="pkg-name">${p.name}</strong><span class="badge">${p.latest ? `v${p.latest}` : 'no release'}</span></div>
  <p>${p.description || 'No description.'}</p>
  <div class="meta"><span>${p.team ? h`👥 ${p.team}` : h`by ${p.owner}`}</span>${p.visibility === 'team' ? h`<span>🔒 team only</span>` : ''}<span>${p.license}</span><span>${p.downloads} install${p.downloads === 1 ? '' : 's'}</span><span>updated ${ago(p.updatedAt)}</span></div>
</a>`)}
</div>`;

/**
 * A tiny, safe part of Markdown (a simple text format) for READMEs: headings, lists, code blocks,
 * `code`, **bold** and [links](https://...). It escapes the text first and then adds the few tags,
 * so README text can never add its own HTML. Links must start with http:// or https://.
 */
export function markdown(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let html = '', inCode = false, inList = false, para = [];
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" rel="nofollow noopener">$1</a>');
  const flush = () => { if (para.length) { html += `<p>${para.map(inline).join(' ')}</p>`; para = []; } };
  const endList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const line of lines) {
    if (line.startsWith('```')) { flush(); endList(); html += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const hm = /^(#{1,4})\s+(.*)/.exec(line);
    if (hm) { flush(); endList(); const n = Math.min(hm[1].length + 1, 5); html += `<h${n}>${inline(hm[2])}</h${n}>`; continue; }
    const li = /^\s*[-*]\s+(.*)/.exec(line);
    if (li) { flush(); if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (!line.trim()) { flush(); endList(); continue; }
    para.push(line);
  }
  flush(); endList();
  if (inCode) html += '</code></pre>';
  return raw(html);
}

// One package: README, install command, owner, versions and their hashes, and the share card.
// The homepage is a link only when it is a plain http or https address (isWebLink). New packages cannot
// publish any other kind, and one stored before that rule shows as plain text.
export const packagePage = ({ pkg, serverUrl, share }) => h`
<div class="pkg-header">
  <div><h1>${pkg.name} <span class="badge big">${pkg.latest ? `v${pkg.latest}` : 'no release'}</span>${pkg.visibility === 'team' ? h`<span class="badge big lock">🔒 team only</span>` : ''}</h1><p class="lead">${pkg.description}</p></div>
</div>
<div class="pkg-grid">
  <article class="card readme">${pkg.readme ? markdown(pkg.readme) : h`<p class="muted">This package has no README.</p>`}</article>
  <aside>
    <div class="card">
      <h3>Install</h3>
      <pre class="install"><code>gitcha install ${pkg.name}</code></pre>
      <p class="muted small">Or ask Claude: “install ${pkg.name} from Gitcha”.</p>
    </div>
    <div class="card">
      <dl class="kv">
        <dt>Owner</dt><dd>${pkg.team ? h`👥 <a href="/teams/${pkg.team}">${pkg.team}</a> (team)` : pkg.owner}</dd>
        <dt>License</dt><dd>${pkg.license}</dd>
        <dt>Installs</dt><dd>${pkg.downloads}</dd>
        <dt>Registry</dt><dd>${serverUrl}</dd>
        ${pkg.homepage ? h`<dt>Homepage</dt><dd>${isWebLink(pkg.homepage) ? h`<a href="${pkg.homepage}" rel="nofollow noopener">${pkg.homepage}</a>` : pkg.homepage}</dd>` : ''}
      </dl>
    </div>
    <div class="card">
      <h3>Versions</h3>
      <table class="versions"><tbody>
      ${pkg.versions.map((v) => h`<tr class="${v.yanked ? 'yanked' : ''}"><td><strong>${v.version}</strong>${v.yanked ? ' (yanked)' : ''}</td><td>${bytes(v.size)}</td><td>${ago(v.publishedAt)}</td></tr>
      <tr class="sha ${v.yanked ? 'yanked' : ''}"><td colspan="3"><code title="${v.integrity}">${v.integrity.slice(0, 23)}…</code></td></tr>`)}
      </tbody></table>
    </div>
    ${share ?? ''}
  </aside>
</div>`;

// Labels and help text for the three follow-up 2FA checks on the Account page.
const CHECK_LABELS = {
  interval: ['Periodic re-verification', 'Ask for a code again on every browser and device at a regular interval.'],
  new_network: ['New network check', 'Ask for a code when a device token is used from a network it has not used before.'],
  sensitive: ['Sensitive action check', 'Ask for a fresh code before publishing, yanking or revoking devices.'],
};

const hours = (ms) => (ms % 3600000 === 0 ? `${ms / 3600000} hours` : `${Math.round(ms / 60000)} minutes`);

// The Account security page: 2FA check switches, email, recovery codes, devices and activity lists.
// A check that an admin locked is shown disabled.
export const accountPage = ({ csrf, user, email, checks, sessions, currentHash, activity, notice, error, recoveryLeft, mfaState }) => h`
<div class="page-head"><h1>Account security</h1><span class="badge ok">2FA enabled</span></div>
${alert(notice, 'info')}${alert(error)}
<div class="account-grid">
  <section class="card">
    <h2>Two-factor checks after sign-in</h2>
    <p class="muted">A code is always required to sign in and to set up a new device. These switches control the <em>follow-up</em> checks.
    Changing them takes a code typed with this form; a code you gave for something else does not count.</p>
    <form method="post" action="/account/checks">
      ${csrfField(csrf)}
      ${Object.entries(CHECK_LABELS).map(([key, [label, help]]) => {
        const locked = checks.locked.includes(key);
        return h`<label class="toggle ${locked ? 'locked' : ''}">
          <input type="checkbox" name="${key}" value="on" ${checks[key] ? raw('checked') : ''} ${locked ? raw('disabled') : ''}>
          <span class="switch" aria-hidden="true"></span>
          <span><strong>${label}</strong>${key === 'interval' ? h` <span class="muted">(every ${hours(checks.intervalMs)})</span>` : ''}${locked ? h` <span class="badge">required by admin</span>` : ''}<br><span class="muted small">${help}</span></span>
        </label>`;
      })}
      <label>Authenticator code <input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="24" required></label>
      <button class="btn">Save check settings</button>
    </form>
    <p class="small muted">This browser last verified ${ago(mfaState.verifiedAt)}${mfaState.nextCheckAt ? h`; next check ${ago(mfaState.nextCheckAt)}` : ''}.</p>
  </section>
  <section class="card">
    <h2>Email</h2>
    <p>${email ? h`On file: <strong>${email}</strong>` : h`<span class="muted">No email on file. It is optional.</span>`}</p>
    <form method="post" action="/account/email">
      ${csrfField(csrf)}
      <label>Email <input type="email" name="email" autocomplete="email" maxlength="254"></label>
      <label>Confirm email <input type="email" name="email_confirm" autocomplete="email" maxlength="254"></label>
      <p class="hint">Leave both empty to remove it. Saving needs a fresh code.</p>
      <button class="btn ghost">Save email</button>
    </form>
  </section>
  <section class="card">
    <h2>Recovery codes</h2>
    <p><strong>${recoveryLeft}</strong> of 10 unused recovery codes remaining.</p>
    <form method="post" action="/account/recovery-codes">${csrfField(csrf)}<button class="btn ghost">Generate new codes</button></form>
  </section>
</div>
<section class="card">
  <h2>Signed-in browsers & devices</h2>
  <table class="table">
    <thead><tr><th>Name</th><th>Type</th><th>Last used</th><th>Last 2FA</th><th></th></tr></thead>
    <tbody>
    ${sessions.map((s) => h`<tr>
      <td><strong>${s.name}</strong>${s.hash === currentHash ? h` <span class="badge">this browser</span>` : ''}<br><span class="muted small">${s.lastIp ?? ''}</span></td>
      <td>${s.kind === 'web' ? 'Browser' : 'CLI / Claude'}</td><td>${ago(s.lastSeen)}</td><td>${ago(s.mfaAt)}</td>
      <td>${s.hash === currentHash ? '' : h`<form method="post" action="/account/sessions/${s.hash.slice(0, 16)}/revoke">${csrfField(csrf)}<button class="btn danger small">Revoke</button></form>`}</td>
    </tr>`)}
    </tbody>
  </table>
</section>
${activitySection('Recent security activity', 'Things done with your account: sign-ins, codes, devices, settings, publishing.', activity.security, 'activity')}
${activity.others.total ? activitySection('Changes other people made to you', 'A team owner adding or re-roling you. Kept apart so it cannot bury your own activity.', activity.others) : ''}
${activity.traffic.total ? activitySection('Recent package downloads', 'Installs made with your account. Kept apart from security activity.', activity.traffic) : ''}`;

const activityRow = (e) => h`<tr><td><code>${e.event}</code></td><td>${[e.package && (e.version ? `${e.package}@${e.version}` : e.package), e.to && `to ${e.to}`, e.team && `team ${e.team}`, e.by && `by ${e.by}`, e.name, e.method].filter(Boolean).join(' · ')}</td><td class="muted">${e.ip ?? ''}</td><td class="muted">${ago(e.at)}</td></tr>`;

/** One audit list with Newer and Older links. `list.param` is the query parameter that holds its page number. */
function activitySection(title, help, list, id) {
  const link = (page, text) => h`<a href="/account?${list.param}=${page}${id ? '#' + id : ''}">${text}</a>`;
  return h`<section class="card"${id ? raw(` id="${id}"`) : ''}>
  <h2>${title}</h2>
  <p class="small muted">${help}</p>
  <table class="table compact"><tbody>
  ${list.rows.map(activityRow)}
  </tbody></table>
  ${list.pages > 1 ? h`<p class="small muted">Page ${list.page} of ${list.pages}: ${list.page > 1 ? link(list.page - 1, '‹ Newer') : ''} ${list.page < list.pages ? link(list.page + 1, 'Older ›') : ''}</p>` : ''}
</section>`;
}

// A simple error page with the status number and message.
export const errorPage = ({ status, message }) => h`<div class="auth-card"><h1>${status}</h1><p>${message}</p><a class="btn" href="/">Home</a></div>`;

// ---- teams -------------------------------------------------------------------
const ROLE_HELP = {
  owner: 'Manage members and roles, delete the team, and everything maintainers can do.',
  maintainer: 'Publish, yank and transfer the team’s packages.',
  member: 'See and install the team’s private packages.',
};

// The list of the user's teams and the form to create one.
export const teamsPage = ({ csrf, teams, error, notice, name = '', description = '' }) => h`
<div class="page-head"><h1>Teams</h1></div>
${alert(notice, 'info')}${alert(error)}
<div class="account-grid">
  <section>
    ${teams.length === 0 ? h`<div class="card empty"><p>You are not in any teams yet.</p><p class="muted">Create one to share packages with other people.</p></div>` : ''}
    <div class="pkg-list single">
    ${teams.map((t) => h`<a class="pkg card" href="/teams/${t.name}">
      <div class="pkg-top"><strong class="pkg-name">👥 ${t.name}</strong><span class="badge">${t.role}</span></div>
      <p>${t.description || 'No description.'}</p>
      <div class="meta"><span>${t.members} member${t.members === 1 ? '' : 's'}</span><span>${t.packages} package${t.packages === 1 ? '' : 's'}</span><span>created ${ago(t.createdAt)}</span></div>
    </a>`)}
    </div>
  </section>
  <section class="card">
    <h2>Create a team</h2>
    <p class="muted small">Teams own packages together. You become the team’s first owner.</p>
    <form method="post" action="/teams">
      ${csrfField(csrf)}
      <label>Team name <input name="name" value="${name}" required minlength="2" maxlength="32" placeholder="acme-tools"></label>
      <label>Description <input name="description" value="${description}" maxlength="300" placeholder="What this team builds"></label>
      <button class="btn block">Create team</button>
    </form>
  </section>
</div>`;

// One team: its packages, the roles, and the members. Only owners see the forms to change members
// or delete the team. Anyone can see a Leave button on their own row.
export const teamPage = ({ csrf, team, me, packages, error, notice }) => {
  const isOwner = team.role === 'owner';
  return h`
<div class="page-head">
  <div><h1>👥 ${team.name}</h1><p class="lead">${team.description || ''}</p></div>
  <span class="badge big">you are ${team.role}</span>
</div>
${alert(notice, 'info')}${alert(error)}
<div class="account-grid">
  <section class="card">
    <h2>Shared packages</h2>
    ${packages.length === 0 ? h`<p class="muted">No packages yet. Publish with <code>gitcha publish --team ${team.name}</code>, or open one of your packages and choose <em>Share with a team</em>.</p>` : ''}
    <table class="table"><tbody>
    ${packages.map((p) => h`<tr><td><a href="/packages/${p.name}"><strong>${p.name}</strong></a> <span class="badge">${p.latest ? `v${p.latest}` : 'no release'}</span>${p.visibility === 'team' ? h` <span class="badge lock">🔒 team only</span>` : ''}<br><span class="muted small">${p.description}</span></td><td class="muted small">${p.downloads} install${p.downloads === 1 ? '' : 's'}</td></tr>`)}
    </tbody></table>
  </section>
  <section class="card">
    <h2>Roles</h2>
    <dl class="kv roles">${Object.entries(ROLE_HELP).reverse().map(([r, t]) => h`<dt><strong>${r}</strong></dt><dd class="small">${t}</dd>`)}</dl>
  </section>
</div>
<section class="card">
  <h2>Members</h2>
  <table class="table">
    <thead><tr><th>User</th><th>Role</th><th>Added</th><th></th></tr></thead>
    <tbody>
    ${team.members.map((m) => h`<tr>
      <td><strong>${m.username}</strong>${m.username === me.username ? h` <span class="badge">you</span>` : ''}</td>
      <td>${isOwner ? h`<form method="post" action="/teams/${team.name}/members" class="row">${csrfField(csrf)}<input type="hidden" name="username" value="${m.username}">
        <select name="role" aria-label="Role for ${m.username}">${['member', 'maintainer', 'owner'].map((r) => h`<option value="${r}" ${r === m.role ? raw('selected') : ''}>${r}</option>`)}</select>
        <input name="code" class="otp" placeholder="code (owner)" inputmode="numeric" autocomplete="one-time-code" maxlength="16" aria-label="Authenticator code, needed to make ${m.username} an owner">
        <button class="btn ghost small">Save</button></form>` : m.role}</td>
      <td class="muted small">${ago(m.addedAt)}${m.addedBy && m.addedBy !== m.username ? ` by ${m.addedBy}` : ''}</td>
      <td>${isOwner || m.username === me.username ? h`<form method="post" action="/teams/${team.name}/members/${m.username}/remove">${csrfField(csrf)}<button class="btn danger small">${m.username === me.username ? 'Leave' : 'Remove'}</button></form>` : ''}</td>
    </tr>`)}
    </tbody>
  </table>
  ${isOwner ? h`<form method="post" action="/teams/${team.name}/members" class="add-member">
    ${csrfField(csrf)}
    <label>Add a member <input name="username" placeholder="username" required></label>
    <label>Role <select name="role"><option value="member">member</option><option value="maintainer">maintainer</option><option value="owner">owner</option></select></label>
    <label>Code <input name="code" class="otp" placeholder="owners only" inputmode="numeric" autocomplete="one-time-code" maxlength="16"></label>
    <button class="btn">Add member</button>
  </form>
  <p class="small muted">Adding, removing or changing members needs a fresh authenticator code. Making someone an owner needs a code typed here, with the change.</p>` : ''}
</section>
${isOwner ? h`<section class="card danger-zone">
  <h2>Delete team</h2>
  <p class="muted">Transfer or remove the team’s packages first.</p>
  <form method="post" action="/teams/${team.name}/delete">${csrfField(csrf)}<button class="btn danger">Delete ${team.name}</button></form>
</section>` : ''}`;
};

// The card on a package page that moves it into a team or switches it between team-only and public.
// web.js shows it only to people who can publish the package.
export const shareCard = ({ csrf, pkg, teams }) => h`
<div class="card">
  <h3>${pkg.team ? 'Team sharing' : 'Share with a team'}</h3>
  ${pkg.team ? h`<p class="small">Owned by team <a href="/teams/${pkg.team}">${pkg.team}</a>. Its maintainers can publish new versions.</p>
    <form method="post" action="/packages/${pkg.name}/visibility">${csrfField(csrf)}
      <input type="hidden" name="private" value="${pkg.visibility === 'team' ? 'off' : 'on'}">
      <button class="btn ghost small">${pkg.visibility === 'team' ? 'Make visible to everyone' : '🔒 Make team-only'}</button>
    </form>` : h`<p class="small muted">Move this package into a team so its maintainers can publish too.</p>`}
  ${teams.length ? h`<form method="post" action="/packages/${pkg.name}/transfer" class="row">${csrfField(csrf)}
    <select name="team" aria-label="Team">${teams.map((t) => h`<option value="${t.name}">${t.name}</option>`)}</select>
    <button class="btn small">${pkg.team ? 'Move' : 'Transfer'}</button>
  </form>` : h`<p class="small"><a href="/teams">Create a team</a> first.</p>`}
</div>`;

// ---- billing ----------------------------------------------------------------------
// A number with commas, or "unlimited" when there is no limit.
const fmt = (n) => (n === null || n === undefined ? 'unlimited' : Number(n).toLocaleString('en-US'));

// The billing page: the plan, this month's use against its limits, and buttons to pay or cancel.
// Payment happens on Stripe's or PayPal's own pages.
export const billingPage = ({ csrf, view, owners, error, notice }) => h`
<div class="page-head">
  <h1>Billing</h1>
  <form method="get" action="/billing" class="row">
    <select name="owner" aria-label="Account">${owners.map((o) => h`<option value="${o}" ${o === view.owner ? raw('selected') : ''}>${o.replace(/^user:/, 'you (').replace(/^team:/, 'team ')}${o.startsWith('user:') ? ')' : ''}</option>`)}</select>
    <button class="btn ghost small">Show</button>
  </form>
</div>
${alert(notice, 'info')}${alert(error)}
${view.enabled ? '' : h`<div class="alert info">Billing is switched off on this instance: there are no limits and nothing to pay.</div>`}
<div class="account-grid">
  <section class="card">
    <h2>${view.planName} plan <span class="badge">${view.subscription ? `${view.subscription.status} via ${view.subscription.provider}` : 'no subscription'}</span></h2>
    <table class="table compact"><thead><tr><th>This month</th><th>Used</th><th>Limit</th></tr></thead><tbody>
    ${Object.entries({ fn_invocations: 'Function invocations', build_minutes: 'Build minutes', sites: 'Sites (total)' }).map(([k, label]) => h`<tr><td>${label}</td><td>${fmt(view.usage[k] ?? 0)}</td><td>${fmt(view.limits?.[k])}</td></tr>`)}
    </tbody></table>
    ${view.subscription && ['active', 'past_due'].includes(view.subscription.status) ? h`<div class="row gap">
      ${view.subscription.provider === 'stripe' ? h`<form method="post" action="/billing/portal">${csrfField(csrf)}<input type="hidden" name="owner" value="${view.owner}"><button class="btn ghost">Update card and invoices</button></form>` : ''}
      <form method="post" action="/billing/cancel">${csrfField(csrf)}<input type="hidden" name="owner" value="${view.owner}"><button class="btn danger">Cancel subscription</button></form>
    </div>` : ''}
  </section>
  <section class="card">
    <h2>Payments</h2>
    <p class="small muted">You pay on Stripe's or PayPal's own pages; card details never reach this server. Starting or cancelling a subscription needs a fresh authenticator code.</p>
  </section>
</div>
<div class="pkg-list">
${view.plans.filter((p) => p.paid).map((p) => h`<div class="card plan">
  <h3>${p.name}</h3><p class="price">${p.price ?? 'priced on request'}</p>
  <ul class="small">${Object.entries(p.limits ?? {}).map(([k, v]) => h`<li>${fmt(v)} ${k.replace(/_/g, ' ')}</li>`)}</ul>
  ${view.enabled && view.plan !== p.id ? view.providers.map((prov) => h`<form method="post" action="/billing/checkout" class="inline">${csrfField(csrf)}
    <input type="hidden" name="owner" value="${view.owner}"><input type="hidden" name="plan" value="${p.id}"><input type="hidden" name="provider" value="${prov}">
    <button class="btn ${prov === 'paypal' ? 'ghost' : ''}">${prov === 'stripe' ? 'Pay with card (Stripe)' : 'Pay with PayPal'}</button></form>`) : view.plan === p.id ? h`<span class="badge ok">current plan</span>` : ''}
</div>`)}
</div>`;
