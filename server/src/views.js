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
// The same links show twice: in a row on wide screens, and in a "Menu" that opens on small screens.
// The CSS shows only one of the two at a time, so a screen reader hears them once.
export function layout({ title, user, csrf, body, wide = false }) {
  const links = user ? `<a href="/crawl">Crawl</a><a href="/projects">Projects</a><a href="/packages">Packages</a><a href="/agents">Agents</a><a href="/teams">Teams</a><a href="/messages">Messages</a><a href="/account">Account</a>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Sign out (${esc(user.username)})</button></form>`
    : `<a href="/login">Sign in</a><a class="btn small" href="/register">Create account</a>`;
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
  <nav class="nav-wide" aria-label="Main">${links}</nav>
  <details class="nav-menu">
    <summary><span class="burger" aria-hidden="true"></span>Menu</summary>
    <nav aria-label="Main menu">${links}</nav>
  </details>
</header>
<main class="${wide ? 'wide' : ''}">${out(body)}</main>
<footer><a href="/ring/prev" rel="prev">&#9664; prev</a> · <a href="/ring">Gitcha ring</a> · <a href="/ring/next" rel="next">next &#9654;</a> · <a href="/ring/random">random</a><br>Gitcha · free software forge and registry · <a href="/claude">Connect Claude</a> · <a href="/support">Support</a> · <a href="/api/v1/health">API status</a></footer>
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
 * A path a README links to, relative to the folder `dir` the README is in ("" for the top), as a clean
 * path inside the package or repository: "./docs/a.md" from "" is "docs/a.md", "../x" from "docs" is "x".
 * Returns null for anything that is not a plain relative path: a scheme (https:, javascript:, data:...),
 * "//host", an absolute "/path", or a path that climbs above the top.
 */
export function relativeTarget(dir, target) {
  let t = String(target ?? '').split('#')[0].split('?')[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('\\')) return null;
  try { t = decodeURIComponent(t); } catch { return null; }
  const parts = dir ? String(dir).split('/') : [];
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    if (seg.includes('\0')) return null;
    parts.push(seg);
  }
  return parts.join('/');
}

// A heading's id, as GitHub makes them: lower case, punctuation dropped, spaces to "-". Ours start with
// "md-", so a README's headings can never take the id of something on Gitcha's own page.
const slug = (s) => `md-${String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')}`;

/**
 * A safe part of Markdown (a simple text format) for READMEs: headings, lists (- and 1.), quotes (>),
 * tables (| a | b | with a |---| line), code blocks, `code`, **bold**, *italics* and [links](...).
 * It escapes the text first and then adds the few tags, so README text can never add its own HTML.
 *
 * Links: http:// and https:// go where they say; "#heading" goes to that heading on the page; and a
 * relative link (docs/guide.md, ./data.zip) goes wherever `opts.link(path)` says, for the file of that
 * name next to the README: a package's or a project's file view. Without `opts.link`, or for any other
 * kind of address (javascript:, data:, //host, /path), the words are shown without a link.
 * `opts.dir` is the README's own folder, for relative links ("" for the top).
 */
export function markdown(src, opts = {}) {
  // HTML comments (such as a README's licence header) are notes for the file's readers, not for the page:
  // they are left out, except inside a ``` code block, where they are part of the example and stay as text.
  let code = false;
  const cleaned = String(src).replace(/\r/g, '').split(/^(```.*)$/m)
    .map((part, i) => { if (i % 2) { code = !code; return part; } return code ? part : part.replace(/<!--[\s\S]*?-->\n?/g, ''); })
    .join('');
  const lines = cleaned.split('\n');
  const ids = opts.ids ?? new Map(); // heading ids used so far: a second "Usage" becomes md-usage-1
  // Bold and italics, on text already escaped.
  const emph = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])\*([^*\s][^*]*?)\*(?=[\s).,;:!?<]|$)/g, '$1<em>$2</em>');
  // Where a relative address in the README points: a link maker's URL, or null (then no link is made).
  const relUrl = (target, make) => {
    if (!make) return null;
    const rel = relativeTarget(opts.dir ?? '', target);
    return rel === null || rel === undefined ? null : make(rel);
  };
  const href = (target) => {
    if (/^https?:\/\/[^\s"<>]+$/i.test(target)) return { url: target, external: true };
    if (target.startsWith('#')) return { url: `#${slug(target.slice(1)).replace(/^md-md-/, 'md-')}` };
    const url = relUrl(target, opts.link);
    return url ? { url } : null;
  };
  // An image: a file of this package or project is shown (opts.image says where it is served); an image
  // on another site is not fetched (no outside requests from Gitcha's pages, so no one learns who reads
  // the README): its alt text stands in for it.
  const image = (alt, src, size = '') => {
    const url = relUrl(src, opts.image);
    if (url) return `<img src="${esc(url)}" alt="${esc(alt)}"${size} loading="lazy">`;
    return alt ? `<span class="md-img-alt" title="An image from another site, not loaded here">${esc(alt)}</span>` : '';
  };

  // ---- the small set of HTML a README may use ------------------------------------------------------------
  // READMEs written for GitHub center a logo with <p align="center">, put images side by side in <table>,
  // fold sections with <details>. Those tags are kept, with only the attributes listed here and checked
  // addresses; every other tag is dropped (its text stays, escaped). Tags are kept balanced, so a README
  // cannot close a part of the page around it.
  const ALIGN = /^(left|center|right)$/i;
  const SIZE = /^\d{1,4}%?$/;
  const BLOCK_ATTRS = { align: ALIGN };
  const CELL_ATTRS = { align: ALIGN, width: SIZE, colspan: /^\d{1,2}$/, rowspan: /^\d{1,2}$/, valign: /^(top|middle|bottom)$/i };
  const TAGS = {
    p: BLOCK_ATTRS, div: BLOCK_ATTRS, h1: BLOCK_ATTRS, h2: BLOCK_ATTRS, h3: BLOCK_ATTRS, h4: BLOCK_ATTRS, h5: BLOCK_ATTRS, h6: BLOCK_ATTRS,
    span: {}, strong: {}, b: {}, em: {}, i: {}, code: {}, kbd: {}, sub: {}, sup: {}, small: {}, s: {}, del: {}, ins: {}, mark: {},
    br: {}, hr: {}, blockquote: {}, pre: {}, ul: {}, ol: {}, li: {}, details: { open: /^$|^open$/i }, summary: {},
    table: { align: ALIGN }, thead: {}, tbody: {}, tr: { align: ALIGN }, th: CELL_ATTRS, td: CELL_ATTRS,
    a: {}, img: {},
  };
  const VOID = new Set(['br', 'hr', 'img']);
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const unent = (v) => v.replace(/&(amp|quot|lt|gt|#39|apos);/g, (m, e) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'", apos: "'" }[e]));
  const tag = (m, st) => {
    const [, close, rawName, rawAttrs] = m;
    const name = rawName.toLowerCase();
    if (!Object.hasOwn(TAGS, name)) return '';
    if (close) {
      const at = st.lastIndexOf(name);
      return at < 0 || VOID.has(name) ? '' : st.splice(at).reverse().map((n) => `</${n}>`).join('');
    }
    const attrs = {};
    for (const a of (rawAttrs ?? '').matchAll(ATTR)) attrs[a[1].toLowerCase()] = unent(a[2] ?? a[3] ?? a[4] ?? '');
    if (name === 'img') {
      const size = ['width', 'height'].filter((k) => SIZE.test(attrs[k] ?? '')).map((k) => ` ${k}="${attrs[k]}"`).join('');
      return image(attrs.alt ?? '', attrs.src ?? '', size);
    }
    let out = '';
    if (name === 'a') {
      const to = attrs.href ? href(attrs.href) : null;
      out = to ? ` href="${esc(to.url)}"${to.external ? ' rel="nofollow noopener"' : ''}` : '';
    } else {
      for (const [k, re] of Object.entries(TAGS[name])) if (Object.hasOwn(attrs, k) && re.test(attrs[k])) out += attrs[k] === '' ? ` ${k}` : ` ${k}="${esc(attrs[k].toLowerCase())}"`;
    }
    if (!VOID.has(name)) st.push(name);
    return `<${name}${out}>`;
  };
  // Text that may hold allowed tags: the tags rebuilt, the text between them escaped.
  const html = (s, st) => {
    if (!opts.html) return emph(esc(s)); // posts and comments: no HTML at all
    let out = '', last = 0;
    for (const m of s.matchAll(TAG)) { out += emph(esc(s.slice(last, m.index))) + tag(m, st); last = m.index + m[0].length; }
    return out + emph(esc(s.slice(last)));
  };

  // [![alt](image)](target), ![alt](image) and [words](target).
  const LINKISH = /\[!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(!?)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const rich = (s, st) => {
    let out = '', last = 0;
    for (const m of s.matchAll(LINKISH)) {
      out += html(s.slice(last, m.index), st);
      last = m.index + m[0].length;
      const [, imgAlt, imgSrc, imgTo, bang, words, target] = m;
      if (imgSrc) { const to = href(imgTo); const pic = image(imgAlt, imgSrc); out += to ? `<a href="${esc(to.url)}"${to.external ? ' rel="nofollow noopener"' : ''}>${pic}</a>` : pic; continue; }
      if (bang) { out += image(words, target); continue; }
      const to = href(target);
      const inner = [];
      const text = html(words, inner) + inner.reverse().map((n) => `</${n}>`).join('');
      out += to ? `<a href="${esc(to.url)}"${to.external ? ' rel="nofollow noopener"' : ''}>${text}</a>` : text;
    }
    return out + html(s.slice(last), st);
  };
  // One piece of text (a paragraph, heading, list item or cell): `code` first (never touched), then
  // links and images, then tags. Whatever the text left open is closed at its end.
  // An HTML block may leave <details>, <div> or <blockquote> open for the paragraphs that follow (a
  // <details> with blank lines inside it); `doc` holds those until their closing tag or the README's end.
  const CARRY = new Set(['details', 'div', 'blockquote']);
  const doc = [];
  const inline = (s, st = [], carry = false) => {
    const out = String(s).split(/(`[^`\n]+`)/).map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : rich(part, st))).join('');
    let close = '';
    while (st.length && !(carry && CARRY.has(st[st.length - 1]))) close += `</${st.pop()}>`;
    return out + close;
  };
  // A table row's cells: the outer pipes dropped, split on the others (a "\|" is a pipe inside a cell).
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const isRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line ?? '');

  let out = '', inCode = false, list = null, para = [];
  // A paragraph that starts with a block tag (<p align="center">, <table>, <details>...) is HTML already.
  const flush = () => {
    if (!para.length) return;
    const text = para.join('\n');
    out += /^\s*<\/?(p|div|h[1-6]|table|details|summary|blockquote|ul|ol|pre|hr)\b/i.test(text) ? inline(text, doc, true) : `<p>${inline(text)}</p>`;
    para = [];
  };
  const endList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) { flush(); endList(); out += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { out += esc(line) + '\n'; continue; }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) {
      flush(); endList();
      const n = Math.min(hm[1].length + 1, 6);
      let id = slug(hm[2]);
      const seen = ids.get(id) ?? 0;
      ids.set(id, seen + 1);
      if (seen) id = `${id}-${seen}`;
      out += `<h${n} id="${esc(id)}">${inline(hm[2])}</h${n}>`;
      continue;
    }
    // A table: a row of cells, then a |---|---| line, then rows until a line without a pipe.
    if (line.includes('|') && isRule(lines[i + 1])) {
      flush(); endList();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` class="${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out += `<div class="table-wrap"><table class="table compact md-table"><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`;
      i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        const row = cells(lines[i]);
        out += `<tr>${head.map((_, k) => td('td', row[k] ?? '', k)).join('')}</tr>`;
      }
      i--;
      out += '</tbody></table></div>';
      continue;
    }
    // A quote: every following line that starts with ">", shown as Markdown of its own.
    if (/^\s*>/.test(line)) {
      flush(); endList();
      const inner = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) inner.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out += `<blockquote>${markdown(inner.join('\n'), { ...opts, ids }).__html}</blockquote>`;
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)/.exec(line);
    const ol = li ? null : /^\s*\d{1,9}[.)]\s+(.*)/.exec(line);
    if (li || ol) {
      flush();
      const kind = li ? 'ul' : 'ol';
      if (list !== kind) { endList(); out += `<${kind}>`; list = kind; }
      out += `<li>${inline((li ?? ol)[1])}</li>`;
      continue;
    }
    if (!line.trim()) { flush(); endList(); continue; }
    // A line that continues a list item (indented) joins it rather than ending the list.
    if (list && /^\s{2,}\S/.test(line)) { out = out.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); continue; }
    endList();
    para.push(line);
  }
  flush(); endList();
  if (inCode) out += '</code></pre>';
  out += doc.reverse().map((n) => `</${n}>`).join('');
  return raw(out);
}

// One package: README, install command, owner, versions and their hashes, and the share card.
// The homepage is a link only when it is a plain http or https address (isWebLink). New packages cannot
// publish any other kind, and one stored before that rule shows as plain text.
// `at` is set when an older (or a named) version is shown: { version, readme, yanked }. The README's
// relative links open files of the version shown, in the package's file view.
export const packagePage = ({ pkg, serverUrl, share, at = null }) => {
  const shown = at?.version ?? pkg.latest;
  const base = shown ? `/packages/${pkg.name}/v/${shown}` : null;
  const readme = at ? at.readme : pkg.readme;
  const link = base ? (p) => `${base}/files?path=${encodeURIComponent(p)}` : undefined;
  const image = base ? (p) => `${base}/raw?path=${encodeURIComponent(p)}` : undefined;
  return h`
<div class="pkg-header">
  <div><h1>${pkg.name} <span class="badge big">${shown ? `v${shown}` : 'no release'}</span>${pkg.visibility === 'team' ? h`<span class="badge big lock">🔒 team only</span>` : ''}</h1><p class="lead">${pkg.description}</p></div>
</div>
${at && at.version !== pkg.latest ? alert(h`You are looking at version ${at.version}${at.yanked ? ' (yanked)' : ''}. The newest is <a href="/packages/${pkg.name}">${pkg.latest}</a>.`, 'info') : ''}
<div class="pkg-grid">
  <article class="card readme">${readme ? markdown(readme, { link, image, html: true }) : h`<p class="muted">This package has no README.</p>`}</article>
  <aside>
    <div class="card">
      <h3>Install</h3>
      <pre class="install"><code>gitcha install ${pkg.name}${at && at.version !== pkg.latest ? `@${at.version}` : ''}</code></pre>
      <p class="muted small">Or ask Claude: “install ${pkg.name} from Gitcha” (<a href="/claude">connect Claude</a>).</p>
    </div>
    ${base ? h`<div class="card">
      <h3>Files</h3>
      <div class="row gap files-downloads"><a class="btn small" href="${base}/files">Browse files</a><a class="btn ghost small" href="${base}/download" download>Download .tgz</a></div>
      <p class="small muted">Version ${shown}, as it was published.</p>
    </div>` : ''}
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
      ${pkg.versions.map((v) => h`<tr class="${v.yanked ? 'yanked' : ''}${v.version === shown ? ' current' : ''}"><td><a href="${v.version === pkg.latest ? `/packages/${pkg.name}` : `/packages/${pkg.name}/v/${v.version}`}"><strong>${v.version}</strong></a>${v.yanked ? ' (yanked)' : ''}</td><td>${bytes(v.size)}</td><td>${ago(v.publishedAt)}</td>
        <td class="right"><a class="small" href="/packages/${pkg.name}/v/${v.version}/download" download aria-label="Download ${pkg.name} ${v.version}">.tgz</a></td></tr>
      <tr class="sha ${v.yanked ? 'yanked' : ''}"><td colspan="4"><code title="${v.integrity}">${v.integrity.slice(0, 23)}…</code></td></tr>`)}
      </tbody></table>
    </div>
    ${share ?? ''}
  </aside>
</div>`;
};

/**
 * A package version's files: a folder's list (with its README), or one file shown. `files` are the paths and
 * sizes in the tarball; folders are made from the paths.
 */
export const packageFilesPage = ({ pkg, version, latest, path = '', entries, file, readme }) => {
  const base = `/packages/${pkg.name}/v/${version}`;
  const filesUrl = (p) => (p ? `${base}/files?path=${encodeURIComponent(p)}` : `${base}/files`);
  const rawOf = (p) => `${base}/raw?path=${encodeURIComponent(p)}`;
  const parts = path ? path.split('/') : [];
  const crumbs = h`<div class="crumbs" role="navigation" aria-label="Path"><a href="${filesUrl('')}">${pkg.name}-${version}</a>${parts.map((x, i) => h` / ${i === parts.length - 1 ? h`<strong>${x}</strong>` : h`<a href="${filesUrl(parts.slice(0, i + 1).join('/'))}">${x}</a>`}`)}</div>`;
  const head = h`<div class="page-head"><div><p class="muted"><a href="/packages/${pkg.name}${version === latest ? '' : `/v/${version}`}">${pkg.name}</a></p><h1>Files <span class="badge big">v${version}</span></h1>
  ${version !== latest ? h`<p class="small muted">An older version. The newest is <a href="/packages/${pkg.name}/v/${latest}/files">${latest}</a>.</p>` : ''}</div>
  <div class="row gap files-downloads"><a class="btn small" href="${base}/download" download>Download .tgz</a></div></div>
<div class="card files-bar">${crumbs}</div>`;
  if (entries) {
    const dir = path;
    return h`${head}
<div class="table-wrap card"><table class="table compact files-list"><tbody>
${path ? h`<tr><td class="files-kind"></td><td><a href="${filesUrl(parts.slice(0, -1).join('/'))}">..</a></td><td></td><td></td></tr>` : ''}
${entries.map((e) => (e.dir
    ? h`<tr><td class="files-kind" aria-label="folder">&#128193;</td><td><a href="${filesUrl(e.path)}">${e.name}/</a></td><td></td><td></td></tr>`
    : h`<tr><td class="files-kind" aria-label="file">&#128196;</td><td><a href="${filesUrl(e.path)}">${e.name}</a></td><td class="muted small nowrap">${bytes(e.size)}</td>
      <td class="right"><a class="small" href="${base}/raw?path=${encodeURIComponent(e.path)}&amp;download=1" download aria-label="Download ${e.name}">Download</a></td></tr>`))}
</tbody></table></div>
${readme ? h`<div class="card readme"><h3>${readme.name}</h3>${readme.md ? markdown(readme.text, { dir, link: (p) => filesUrl(p), image: rawOf, html: true }) : h`<pre>${readme.text}</pre>`}</div>` : ''}`;
  }
  const name = parts[parts.length - 1];
  const rawUrl = `${base}/raw?path=${encodeURIComponent(path)}`;
  const dir = parts.slice(0, -1).join('/');
  return h`${head}
<div class="card files-file">
  <div class="row gap files-file-head"><strong>${name}</strong><span class="muted small">${bytes(file.size)}</span>
    <span class="grow"></span>${file.text !== null ? h`<a class="btn ghost small" href="${rawUrl}">Raw</a>` : ''}<a class="btn small" href="${rawUrl}&amp;download=1" download>Download</a></div>
  ${file.markdown ? h`<div class="readme">${markdown(file.text, { dir, link: (p) => filesUrl(p), image: rawOf, html: true })}</div>`
    : file.text !== null ? h`<pre class="files-code"><code>${file.text}</code></pre>`
      : alert(file.big ? `This file is ${bytes(file.size)}, too big to show here. Download it instead.` : 'This file is not text, so it is not shown here. Download it instead.', 'info')}
</div>`;
};

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
<p class="card small">Use Gitcha from Claude Desktop or Claude Code: <a href="/claude">Connect Claude</a> writes the settings for you.</p>
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
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Name</th><th>Type</th><th>Last used</th><th>Last 2FA</th><th></th></tr></thead>
    <tbody>
    ${sessions.map((s) => h`<tr>
      <td><strong>${s.name}</strong>${s.hash === currentHash ? h` <span class="badge">this browser</span>` : ''}<br><span class="muted small">${s.lastIp ?? ''}</span></td>
      <td>${s.kind === 'web' ? 'Browser' : 'CLI / Claude'}</td><td>${ago(s.lastSeen)}</td><td>${ago(s.mfaAt)}</td>
      <td>${s.hash === currentHash ? '' : h`<form method="post" action="/account/sessions/${s.hash.slice(0, 16)}/revoke">${csrfField(csrf)}<button class="btn danger small">Revoke</button></form>`}</td>
    </tr>`)}
    </tbody>
  </table></div>
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
  <div class="table-wrap"><table class="table compact"><tbody>
  ${list.rows.map(activityRow)}
  </tbody></table></div>
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
    <div class="table-wrap"><table class="table"><tbody>
    ${packages.map((p) => h`<tr><td><a href="/packages/${p.name}"><strong>${p.name}</strong></a> <span class="badge">${p.latest ? `v${p.latest}` : 'no release'}</span>${p.visibility === 'team' ? h` <span class="badge lock">🔒 team only</span>` : ''}<br><span class="muted small">${p.description}</span></td><td class="muted small">${p.downloads} install${p.downloads === 1 ? '' : 's'}</td></tr>`)}
    </tbody></table></div>
  </section>
  <section class="card">
    <h2>Roles</h2>
    <dl class="kv roles">${Object.entries(ROLE_HELP).reverse().map(([r, t]) => h`<dt><strong>${r}</strong></dt><dd class="small">${t}</dd>`)}</dl>
  </section>
</div>
<section class="card">
  <h2>Members</h2>
  <div class="table-wrap"><table class="table">
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
  </table></div>
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
    <div class="table-wrap"><table class="table compact"><thead><tr><th>This month</th><th>Used</th><th>Limit</th></tr></thead><tbody>
    ${Object.entries({ fn_invocations: 'Function invocations', build_minutes: 'Build minutes', sites: 'Sites (total)' }).map(([k, label]) => h`<tr><td>${label}</td><td>${fmt(view.usage[k] ?? 0)}</td><td>${fmt(view.limits?.[k])}</td></tr>`)}
    </tbody></table></div>
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
