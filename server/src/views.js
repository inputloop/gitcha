// Server-rendered HTML. Everything interpolated goes through esc().
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const raw = (s) => ({ __html: s });
const out = (v) => (v && v.__html !== undefined ? v.__html : Array.isArray(v) ? v.map(out).join('') : esc(v));
export const h = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? out(vals[i]) : ''), ''));
export { raw };

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
    ${user ? `<a href="/packages">Packages</a><a href="/account">Account</a>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Sign out (${esc(user.username)})</button></form>`
    : `<a href="/login">Sign in</a><a class="btn small" href="/register">Create account</a>`}
  </nav>
</header>
<main class="${wide ? 'wide' : ''}">${out(body)}</main>
<footer>Gitcha · free software package registry · <a href="/api/v1/health">API status</a></footer>
</body>
</html>`;
}

const csrfField = (csrf) => h`<input type="hidden" name="_csrf" value="${csrf}">`;
const alert = (err, kind = 'error') => (err ? h`<div class="alert ${kind}" role="alert">${err}</div>` : '');

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

export const registerPage = ({ csrf, error, username = '' }) => h`
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
    <button class="btn block">Continue to two-factor setup →</button>
  </form>
  <p class="muted center">Already have an account? <a href="/login">Sign in</a></p>
</div>`;

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

export const recoveryCodesPage = ({ codes, fresh = true }) => h`
<div class="auth-card">
  ${fresh ? h`<ol class="steps"><li class="done">Account</li><li class="done">Authenticator</li><li class="active">Recovery codes</li></ol>` : ''}
  <h1>Save your recovery codes</h1>
  <p>If you lose your phone, each of these codes can be used <strong>once</strong> instead of an authenticator code.
  They will not be shown again.</p>
  <ul class="codes">${codes.map((c) => h`<li><code>${c}</code></li>`)}</ul>
  <a class="btn block" href="${fresh ? '/login?msg=activated' : '/account'}">I've saved them — continue</a>
</div>`;

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

export const codePage = ({ csrf, error, action, title, message, next = '', reason }) => h`
<div class="auth-card">
  <div class="shield">🛡️</div>
  <h1>${title}</h1>
  ${reason ? h`<div class="alert info">${reason}</div>` : ''}
  <p>${message}</p>
  ${alert(error)}
  <form method="post" action="${action}">
    ${csrfField(csrf)}<input type="hidden" name="next" value="${next}">
    <label>Authenticator code <input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required autofocus placeholder="123 456"></label>
    <button class="btn block">Verify</button>
  </form>
  <p class="muted center">Lost your phone? Enter one of your recovery codes instead.</p>
</div>`;

export const packagesPage = ({ q, results }) => h`
<div class="page-head">
  <h1>Packages</h1>
  <form class="search" method="get" action="/packages"><input name="q" value="${q}" placeholder="Search packages…" aria-label="Search packages"><button class="btn">Search</button></form>
</div>
${results.length === 0 ? h`<div class="empty card"><p>No packages ${q ? h`match <strong>${q}</strong>` : 'yet'}.</p><p class="muted">Publish one with <code>gitcha publish</code> or ask Claude to do it.</p></div>` : ''}
<div class="pkg-list">
${results.map((p) => h`<a class="pkg card" href="/packages/${encodeURIComponent(p.name)}">
  <div class="pkg-top"><strong class="pkg-name">${p.name}</strong><span class="badge">v${p.latest ?? '—'}</span></div>
  <p>${p.description || 'No description.'}</p>
  <div class="meta"><span>by ${p.owner}</span><span>${p.license}</span><span>${p.downloads} install${p.downloads === 1 ? '' : 's'}</span><span>updated ${ago(p.updatedAt)}</span></div>
</a>`)}
</div>`;

/** Tiny, safe Markdown subset for READMEs (escape first, then format). */
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

export const packagePage = ({ pkg, serverUrl }) => h`
<div class="pkg-header">
  <div><h1>${pkg.name} <span class="badge big">v${pkg.latest ?? '—'}</span></h1><p class="lead">${pkg.description}</p></div>
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
        <dt>Owner</dt><dd>${pkg.owner}</dd>
        <dt>License</dt><dd>${pkg.license}</dd>
        <dt>Installs</dt><dd>${pkg.downloads}</dd>
        <dt>Registry</dt><dd>${serverUrl}</dd>
        ${pkg.homepage ? h`<dt>Homepage</dt><dd><a href="${pkg.homepage}" rel="nofollow noopener">${pkg.homepage}</a></dd>` : ''}
      </dl>
    </div>
    <div class="card">
      <h3>Versions</h3>
      <table class="versions"><tbody>
      ${pkg.versions.map((v) => h`<tr class="${v.yanked ? 'yanked' : ''}"><td><strong>${v.version}</strong>${v.yanked ? ' (yanked)' : ''}</td><td>${bytes(v.size)}</td><td>${ago(v.publishedAt)}</td></tr>
      <tr class="sha ${v.yanked ? 'yanked' : ''}"><td colspan="3"><code title="${v.integrity}">${v.integrity.slice(0, 23)}…</code></td></tr>`)}
      </tbody></table>
    </div>
  </aside>
</div>`;

const CHECK_LABELS = {
  interval: ['Periodic re-verification', 'Ask for a code again on every browser and device at a regular interval.'],
  new_network: ['New network check', 'Ask for a code when a device token is used from a network it has not used before.'],
  sensitive: ['Sensitive action check', 'Ask for a fresh code before publishing, yanking or revoking devices.'],
};

const hours = (ms) => (ms % 3600000 === 0 ? `${ms / 3600000} hours` : `${Math.round(ms / 60000)} minutes`);

export const accountPage = ({ csrf, user, checks, sessions, currentHash, audit, notice, error, recoveryLeft, mfaState }) => h`
<div class="page-head"><h1>Account security</h1><span class="badge ok">2FA enabled</span></div>
${alert(notice, 'info')}${alert(error)}
<div class="account-grid">
  <section class="card">
    <h2>Two-factor checks after sign-in</h2>
    <p class="muted">A code is always required to sign in and to set up a new device. These switches control the <em>follow-up</em> checks.
    Changing them requires a fresh code.</p>
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
      <button class="btn">Save check settings</button>
    </form>
    <p class="small muted">This browser last verified ${ago(mfaState.verifiedAt)}${mfaState.nextCheckAt ? h`; next check ${ago(mfaState.nextCheckAt)}` : ''}.</p>
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
<section class="card">
  <h2>Recent security activity</h2>
  <table class="table compact"><tbody>
  ${audit.map((e) => h`<tr><td><code>${e.event}</code></td><td>${[e.package && `${e.package}@${e.version}`, e.name, e.method].filter(Boolean).join(' · ')}</td><td class="muted">${e.ip ?? ''}</td><td class="muted">${ago(e.at)}</td></tr>`)}
  </tbody></table>
</section>`;

export const errorPage = ({ status, message }) => h`<div class="auth-card"><h1>${status}</h1><p>${message}</p><a class="btn" href="/">Home</a></div>`;
