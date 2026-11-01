// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Browsing and downloading a project's files: the Files page, one file at a time (shown, raw, or downloaded),
// and the whole project as a .zip or .tar.gz at any branch, tag or commit.
//
// Two doors, one set of rules:
//   - the web pages, under /projects/OWNER/NAME/..., for someone signed in with the browser (or no one);
//   - the API, under /api/v1/projects/OWNER/NAME/..., for the CLI, scripts and Claude, with a device token or
//     console key (Bearer, or Basic with the key as the password, as git uses).
// Who may read is the same as for `git clone`: anyone for a public project; for a private one, someone who
// may read it and has passed their periodic two-factor check. An administrator reading a private project is
// told to its owners, as on the project page.
//
// Everything is read with git itself from the bare repository, and every name that comes from the address
// (a branch or a path) is checked first, so it can only ever name something inside that one repository.
// A file is never sent as HTML: text goes out as text/plain, anything else as a download, and both with a
// sandboxing CSP, so a file in a repository cannot run script on Gitcha's own pages.
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { HttpError } from '../errors.js';
import { json, send, redirect } from '../http.js';
import { RateLimiter } from '../auth.js';
import { h, markdown, alert } from '../views.js';
import { GIT_ENV, ownerLabel } from './projects.js';

// A branch, tag or commit as written in an address: letters, digits and . _ / - + @, not starting with "-"
// (git would read that as an option), with no ".." or "@{" (git's own range and reflog syntax).
const REF_RE = /^(?![-/])(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/@+-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
// The biggest file the Files page shows inline. Bigger ones are offered as a download.
export const SHOW_MAX = 512 * 1024;
// A whole-project download may run this long before it is stopped.
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/** Run git in the background and collect what it prints (as a Buffer). Rejects if it cannot start or prints too much. */
function gitOut(args, { max = 16 * 1024 * 1024, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('git ran too long')); }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', (c) => { size += c.length; if (size > max) { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('git printed too much')); } else out.push(c); });
    child.stderr.resume();
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out) }); });
  });
}

/**
 * A path inside the repository, made safe: "/" separated, with empty, "." and ".." parts refused rather than
 * resolved (so "a/../b" is an error, not "b"). Returns "" for the top of the repository.
 */
export function cleanPath(s) {
  const str = String(s ?? '');
  if (str.includes('\0') || str.length > 4096) throw new HttpError(400, 'bad_path', 'That is not a valid path.');
  const parts = str.split('/').filter((x) => x !== '');
  if (parts.some((x) => x === '.' || x === '..')) throw new HttpError(400, 'bad_path', 'A path may not contain "." or ".." parts.');
  return parts.join('/');
}

/** A short, safe piece of a file name for a ref: "feature/login" -> "feature-login", a commit -> its first 7 characters. */
const refLabel = (ref, sha) => (ref && !SHA_RE.test(ref) ? ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || sha.slice(0, 7) : sha.slice(0, 7));

/** Reads a project's repository: its branches and tags, folders, files, and whole-tree archives. */
export class RepoBrowser {
  constructor({ projects }) { this.projects = projects; }

  dir(p) { return this.projects.repoDir(p); }

  /** Branch and tag names (at most 200 of each), and the default branch (what HEAD names, if it exists). */
  async refs(p) {
    const r = await gitOut(['-C', this.dir(p), 'for-each-ref', '--count=400', '--format=%(refname)', 'refs/heads', 'refs/tags']);
    const names = r.status === 0 ? r.stdout.toString('utf8').split('\n').filter(Boolean) : [];
    const branches = names.filter((n) => n.startsWith('refs/heads/')).map((n) => n.slice(11)).slice(0, 200);
    const tags = names.filter((n) => n.startsWith('refs/tags/')).map((n) => n.slice(10)).slice(0, 200);
    const head = await gitOut(['-C', this.dir(p), 'symbolic-ref', '--quiet', 'HEAD']);
    const named = head.status === 0 ? head.stdout.toString('utf8').trim().replace(/^refs\/heads\//, '') : null;
    // A first push of "master" to a repository whose HEAD says "main" still has a default: the first branch.
    const fallback = ['main', 'master'].find((b) => branches.includes(b)) ?? branches[0] ?? null;
    return { branches, tags, defaultBranch: named && branches.includes(named) ? named : fallback };
  }

  /** The commit a ref names, as { ref, sha }. No ref means the default branch. 404 for an empty repository or an unknown ref. */
  async resolve(p, ref) {
    let name = ref ? String(ref) : null;
    if (!name) {
      name = (await this.refs(p)).defaultBranch;
      if (!name) throw new HttpError(404, 'empty', 'Nothing has been pushed to this project yet.');
    }
    if (!REF_RE.test(name)) throw new HttpError(400, 'bad_ref', 'That is not a valid branch, tag or commit.');
    const r = await gitOut(['-C', this.dir(p), 'rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
    const sha = r.stdout.toString('utf8').trim();
    if (r.status !== 0 || !SHA_RE.test(sha)) throw new HttpError(404, 'no_ref', `There is no branch, tag or commit "${name}" in this project.`);
    return { ref: name, sha };
  }

  /** What is at `path` in commit `sha`: { type: 'tree' | 'blob', size } (size for a file), or a 404. */
  async statOne(p, sha, path) {
    const out = await new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', this.dir(p), 'cat-file', '--batch-check=%(objecttype) %(objectsize)'], { env: GIT_ENV, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      child.on('error', reject);
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      // One object name per line: a path with a newline in it cannot be asked about this way, so it is not found.
      child.stdin.end(path.includes('\n') ? '\n' : `${sha}:${path}\n`);
    });
    const [type, size] = out.split(' ');
    if (type === 'tree') return { type: 'tree' };
    if (type === 'blob') return { type: 'blob', size: Number(size) };
    throw new HttpError(404, 'no_path', `There is no "${path}" in this version of the project.`);
  }

  /** The entries of the folder at `path`: [{ name, path, type: 'tree' | 'blob' | 'commit', size, mode }], folders first. */
  async list(p, sha, path) {
    const r = await gitOut(['-C', this.dir(p), 'ls-tree', '-z', '-l', path ? `${sha}:${path}` : sha]);
    if (r.status !== 0) throw new HttpError(404, 'no_path', `There is no folder "${path}" in this version of the project.`);
    const entries = r.stdout.toString('utf8').split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, , size] = line.slice(0, tab).split(/ +/);
      const name = line.slice(tab + 1);
      return { name, path: path ? `${path}/${name}` : name, type, mode, size: type === 'blob' ? Number(size) : null };
    });
    const rank = { tree: 0, commit: 1, blob: 2 };
    return entries.sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name));
  }

  /** A file's bytes, read whole (only for files up to `max` bytes). */
  async read(p, sha, path, max = SHOW_MAX) {
    const r = await gitOut(['-C', this.dir(p), 'cat-file', 'blob', `${sha}:${path}`], { max });
    if (r.status !== 0) throw new HttpError(404, 'no_path', `There is no file "${path}" in this version of the project.`);
    return r.stdout;
  }

  /** Stream a file to the reply. The caller has checked that it is a file and has set the headers. */
  pipeFile(p, sha, path, res) {
    const child = spawn('git', ['-C', this.dir(p), 'cat-file', 'blob', `${sha}:${path}`], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    res.on('close', () => child.kill('SIGKILL'));
    child.on('error', () => res.destroy());
    child.on('close', (status) => { if (status !== 0) res.destroy(); });
    child.stdout.pipe(res);
  }

  /**
   * Stream the whole tree of commit `sha` to the reply as a zip or a gzipped tar, every file inside one folder
   * named `prefix`. git writes the zip itself; the tar is gzipped here (so no gzip program is needed).
   * Files marked export-ignore in .gitattributes are left out, as git archive always does.
   */
  pipeArchive(p, sha, format, prefix, res) {
    const child = spawn('git', ['-C', this.dir(p), 'archive', `--format=${format === 'zip' ? 'zip' : 'tar'}`, `--prefix=${prefix}/`, sha], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); res.destroy(); }, ARCHIVE_TIMEOUT_MS);
    const stop = () => { clearTimeout(timer); child.kill('SIGKILL'); };
    res.on('close', stop);
    child.on('error', () => { stop(); res.destroy(); });
    // A git that fails partway leaves a broken file: cut the connection, so the browser says it failed.
    child.on('close', (status) => { clearTimeout(timer); if (status !== 0) res.destroy(); });
    if (format === 'zip') child.stdout.pipe(res);
    else child.stdout.pipe(createGzip()).pipe(res);
  }
}

// A file's bytes look like text when they have no NUL byte and are valid UTF-8.
export function isText(buf) {
  if (buf.subarray(0, 8000).includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// A safe file name for Content-Disposition: the plain ASCII name, and the real one in RFC 5987 form.
export const disposition = (kind, name) => `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
// What every file reply carries: no sniffing, no script, no framing, not stored by shared caches.
// Pictures a README may show: served as themselves (an SVG under the sandboxing CSP, so it cannot run script).
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon' };
export const imageType = (name) => IMAGE_TYPES[String(name).split('.').pop().toLowerCase()] ?? null;
export const FILE_HEADERS = { 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'private, no-store' };

/** Adds the Files pages and the download routes (web and API). */
export function registerBrowse(router, { browse, projects, tasks, principals, auth, web }) {
  // Whole-project downloads are the heavy thing here: each person or address may start 30 in 10 minutes, and
  // the server runs at most 8 at once.
  const archiveLimiter = new RateLimiter({ max: 30, windowMs: 10 * 60_000, clock: auth.clock });
  let archivesRunning = 0;
  const MAX_ARCHIVES = 8;

  // The person or agent behind an API request: a Bearer token, or Basic with the token as the password (the
  // way git and curl -u send it). An agent key opens only the paid sandboxes, so it is refused here.
  const apiPrincipal = (ctx) => {
    const hdr = ctx.req.headers.authorization ?? '';
    let token = null;
    if (hdr.startsWith('Bearer ')) token = hdr.slice(7).trim();
    else if (hdr.startsWith('Basic ')) { const d = Buffer.from(hdr.slice(6), 'base64').toString('utf8'); token = d.slice(d.indexOf(':') + 1) || null; }
    if (!token) return null;
    if (token.startsWith('gak_')) throw new HttpError(401, 'unauthenticated', 'Agent keys work only for the paid sandboxes.');
    const p = principals.fromToken(token, ctx.ip);
    if (!p) throw new HttpError(401, 'unauthenticated', 'That token or key is not valid (or has expired).');
    return p;
  };

  /**
   * The project in the address, if this principal may read its files; otherwise a 404 (private projects stay
   * hidden). A private project also needs a passed 2FA check: `onMfa` decides what happens when it is due.
   */
  const readable = (ctx, principal, onMfa) => {
    const p = projects.find(ctx.params.owner, ctx.params.name);
    const how = p ? tasks.access.how(principal, p) : null;
    if (!how) throw new HttpError(404, 'not_found', 'No such project.');
    if (how !== 'public' && principal?.auth) {
      const state = auth.mfaState(principal.auth);
      if (!state.ok) return onMfa(state);
    }
    tasks.access.read(principal, p);
    return p;
  };

  const webPrincipal = (ctx) => { const a = web.current(ctx); return a ? { kind: 'user', user: a.user, auth: a } : null; };
  const webReadable = (ctx) => readable(ctx, webPrincipal(ctx), (state) => {
    redirect(ctx.res, `/verify?reason=${state.reason}&next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    return null;
  });
  const apiReadable = (ctx) => readable(ctx, apiPrincipal(ctx), (state) => {
    throw new HttpError(403, 'mfa_required', 'Your periodic two-factor check is due. Run `gitcha verify`, then try again.', { reason: state.reason });
  });

  // ---- shared: send one file, send the whole project ------------------------------------------------------
  async function sendFile(ctx, p, download) {
    const { ref, sha } = await browse.resolve(p, ctx.url.searchParams.get('ref'));
    const path = cleanPath(ctx.url.searchParams.get('path'));
    const st = await browse.statOne(p, sha, path);
    if (st.type !== 'blob') throw new HttpError(400, 'not_a_file', `"${path || '/'}" is a folder. Download the project as a zip instead.`);
    const name = path.split('/').pop();
    // Text is shown as plain text; anything else (and anything asked for as a download) is saved as a file.
    const head = st.size <= SHOW_MAX ? await browse.read(p, sha, path) : null;
    const text = head ? isText(head) : false;
    const pic = imageType(name);
    const headers = {
      ...FILE_HEADERS, 'Content-Length': String(st.size), 'X-Gitcha-Commit': sha, 'X-Gitcha-Ref': ref,
      'Content-Type': pic ?? (text ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      'Content-Disposition': disposition(download || !(text || pic) ? 'attachment' : 'inline', name),
    };
    if (head) return send(ctx.res, 200, head, headers);
    ctx.res.writeHead(200, { ...headers });
    browse.pipeFile(p, sha, path, ctx.res);
  }

  async function sendArchive(ctx, p, format, who) {
    if (!archiveLimiter.hit(`archive:${who}`)) throw new HttpError(429, 'rate_limited', 'Too many downloads in a short time. Wait a few minutes and try again.');
    if (archivesRunning >= MAX_ARCHIVES) throw new HttpError(503, 'busy', 'The server is making several downloads already. Try again in a minute.');
    const { ref, sha } = await browse.resolve(p, ctx.url.searchParams.get('ref'));
    const folder = `${p.name}-${refLabel(ctx.url.searchParams.get('ref') || ref, sha)}`;
    const file = `${folder}.${format === 'zip' ? 'zip' : 'tar.gz'}`;
    archivesRunning++;
    ctx.res.on('close', () => { archivesRunning--; });
    // Big repositories stream out as git makes them, so there is no Content-Length.
    ctx.res.writeHead(200, {
      ...FILE_HEADERS, 'Content-Type': format === 'zip' ? 'application/zip' : 'application/gzip',
      'Content-Disposition': disposition('attachment', file), 'X-Gitcha-Commit': sha, 'X-Gitcha-Ref': ref,
    });
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    browse.pipeArchive(p, sha, format, folder, ctx.res);
  }
  const whoKey = (ctx, principal) => (principal?.user ? `u:${principal.user.id}` : principal?.agent ? `a:${principal.agent.handle}` : `ip:${ctx.ip}`);

  // ---- the web pages ----------------------------------------------------------------------------------------
  // The Files page: a folder's list, or one file shown, at a branch, tag or commit (?ref=), at a path (?path=).
  router.get('/projects/:owner/:name/files', async (ctx) => {
    const p = webReadable(ctx);
    if (!p) return;
    const a = web.current(ctx);
    const base = `/projects/${ownerLabel(p.owner)}/${p.name}`;
    const refs = await browse.refs(p);
    if (!refs.defaultBranch && !ctx.url.searchParams.get('ref')) {
      return web.page(ctx, `${projects.key(p.owner, p.name)}: files`, filesPage({ p, base, refs, empty: true, clone: projects.view(p).cloneHttp }), { user: a?.user, wide: true });
    }
    const { ref, sha } = await browse.resolve(p, ctx.url.searchParams.get('ref'));
    const path = cleanPath(ctx.url.searchParams.get('path'));
    const st = await browse.statOne(p, sha, path);
    let entries = null, file = null, readme = null;
    if (st.type === 'tree') {
      entries = await browse.list(p, sha, path);
      const rd = entries.find((e) => e.type === 'blob' && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name) && e.size <= SHOW_MAX);
      if (rd) { const buf = await browse.read(p, sha, rd.path); if (isText(buf)) readme = { name: rd.name, md: /\.(md|markdown)$/i.test(rd.name), text: buf.toString('utf8') }; }
    } else {
      file = { size: st.size, text: null };
      if (st.size <= SHOW_MAX) { const buf = await browse.read(p, sha, path); if (isText(buf)) file.text = buf.toString('utf8'); }
    }
    web.page(ctx, `${projects.key(p.owner, p.name)}: ${path || 'files'}`, filesPage({ p, base, refs, ref, sha, path, entries, file, readme, explicitRef: Boolean(ctx.url.searchParams.get('ref')) }), { user: a?.user, wide: true });
  });
  // One file: shown as text when it is text (?download=1 always saves it).
  router.get('/projects/:owner/:name/raw', async (ctx) => {
    const p = webReadable(ctx);
    if (p) await sendFile(ctx, p, ctx.url.searchParams.get('download') === '1');
  });
  // The whole project: .zip or .tar.gz.
  router.get('/projects/:owner/:name/archive.zip', async (ctx) => { const p = webReadable(ctx); if (p) await sendArchive(ctx, p, 'zip', whoKey(ctx, webPrincipal(ctx))); });
  router.get('/projects/:owner/:name/archive.tar.gz', async (ctx) => { const p = webReadable(ctx); if (p) await sendArchive(ctx, p, 'tar.gz', whoKey(ctx, webPrincipal(ctx))); });

  // ---- the API (CLI, scripts, Claude) ---------------------------------------------------------------------
  // The branches and tags, and a folder's entries (or a file's size) at ?ref= and ?path=.
  router.get('/api/v1/projects/:owner/:name/tree', async (ctx) => {
    const p = apiReadable(ctx);
    const refs = await browse.refs(p);
    if (!refs.defaultBranch && !ctx.url.searchParams.get('ref')) return json(ctx.res, 200, { project: projects.key(p.owner, p.name), empty: true, ...refs, entries: [] });
    const { ref, sha } = await browse.resolve(p, ctx.url.searchParams.get('ref'));
    const path = cleanPath(ctx.url.searchParams.get('path'));
    const st = await browse.statOne(p, sha, path);
    json(ctx.res, 200, {
      project: projects.key(p.owner, p.name), ref, commit: sha, path, type: st.type, ...refs,
      ...(st.type === 'tree' ? { entries: (await browse.list(p, sha, path)).map(({ name, path: ep, type, size }) => ({ name, path: ep, type, size })) } : { size: st.size }),
    });
  });
  router.get('/api/v1/projects/:owner/:name/raw', async (ctx) => { const p = apiReadable(ctx); await sendFile(ctx, p, true); });
  router.get('/api/v1/projects/:owner/:name/archive', async (ctx) => {
    const format = ctx.url.searchParams.get('format') ?? 'zip';
    if (!['zip', 'tar.gz'].includes(format)) throw new HttpError(400, 'bad_format', 'format must be zip or tar.gz.');
    const principal = apiPrincipal(ctx);
    const p = apiReadable(ctx);
    await sendArchive(ctx, p, format, whoKey(ctx, principal));
  });
}

// ---- the page --------------------------------------------------------------------------------------------
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();

/** The Files page: the ref picker and download buttons, the path, then a folder's list (and README) or one file. */
export function filesPage({ p, base, refs, ref, sha, path = '', entries, file, readme, explicitRef, empty, clone }) {
  const key = `${ownerLabel(p.owner)}/${p.name}`;
  if (empty) {
    return h`<div class="page-head"><div><p class="muted"><a href="${base}">${key}</a></p><h1>Files</h1></div></div>
<div class="card"><p>Nothing has been pushed to this project yet. Push to it, and its files appear here:</p><pre class="install"><code>git push ${clone} main</code></pre></div>`;
  }
  // Links keep the ref only when one was chosen, so plain links follow the default branch as it moves.
  const keepRef = explicitRef ? ref : null;
  const filesUrl = (pth) => `${base}/files?${q({ ref: keepRef, path: pth })}`;
  const rawOf = (pth) => `${base}/raw?${q({ ref: keepRef ?? ref, path: pth })}`;
  const parts = path ? path.split('/') : [];
  const crumbs = h`<div class="crumbs" role="navigation" aria-label="Path"><a href="${filesUrl('')}">${p.name}</a>${parts.map((x, i) => h` / ${i === parts.length - 1 ? h`<strong>${x}</strong>` : h`<a href="${filesUrl(parts.slice(0, i + 1).join('/'))}">${x}</a>`}`)}</div>`;
  const isRefName = refs.branches.includes(ref) || refs.tags.includes(ref);
  const picker = h`<form method="get" action="${base}/files" class="row files-ref">
    ${path ? h`<input type="hidden" name="path" value="${path}">` : ''}
    <label class="sr-only" for="files-ref">Branch or tag</label>
    <select id="files-ref" name="ref">
      ${isRefName ? '' : h`<option value="${ref}" selected>${ref.slice(0, 12)}</option>`}
      ${refs.branches.length ? h`<optgroup label="Branches">${refs.branches.map((b) => h`<option value="${b}" ${b === ref ? 'selected' : ''}>${b}</option>`)}</optgroup>` : ''}
      ${refs.tags.length ? h`<optgroup label="Tags">${refs.tags.map((t) => h`<option value="${t}" ${t === ref ? 'selected' : ''}>${t}</option>`)}</optgroup>` : ''}
    </select><button class="btn ghost small">Show</button></form>`;
  const downloads = h`<div class="row gap files-downloads">
    <a class="btn small" href="${base}/archive.zip?${q({ ref: keepRef ?? ref })}" download>Download ZIP</a>
    <a class="btn ghost small" href="${base}/archive.tar.gz?${q({ ref: keepRef ?? ref })}" download>.tar.gz</a></div>`;
  const head = h`<div class="page-head"><div><p class="muted"><a href="${base}">${key}</a></p><h1>Files</h1>
  <p class="small muted">At <code>${ref}</code>, commit <code>${sha.slice(0, 10)}</code></p></div>${downloads}</div>
<div class="card files-bar">${picker}${crumbs}</div>`;

  if (entries) {
    const rows = entries.map((e) => {
      if (e.type === 'tree') return h`<tr><td class="files-kind" aria-label="folder">&#128193;</td><td><a href="${filesUrl(e.path)}">${e.name}/</a></td><td></td><td></td></tr>`;
      if (e.type === 'commit') return h`<tr><td class="files-kind" aria-label="submodule">&#128279;</td><td>${e.name} <span class="badge">submodule</span></td><td></td><td></td></tr>`;
      return h`<tr><td class="files-kind" aria-label="file">&#128196;</td><td><a href="${filesUrl(e.path)}">${e.name}</a></td><td class="muted small nowrap">${bytes(e.size)}</td>
        <td class="right"><a class="small" href="${base}/raw?${q({ ref: keepRef ?? ref, path: e.path, download: '1' })}" download aria-label="Download ${e.name}">Download</a></td></tr>`;
    });
    return h`${head}
<div class="table-wrap card"><table class="table compact files-list"><tbody>
${path ? h`<tr><td class="files-kind"></td><td><a href="${filesUrl(parts.slice(0, -1).join('/'))}">..</a></td><td></td><td></td></tr>` : ''}
${rows}</tbody></table>${entries.length ? '' : h`<p class="muted">This folder is empty.</p>`}</div>
${readme ? h`<div class="card readme"><h3>${readme.name}</h3>${readme.md ? markdown(readme.text, { dir: path, link: filesUrl, image: rawOf, html: true }) : h`<pre>${readme.text}</pre>`}</div>` : ''}`;
  }

  const name = parts[parts.length - 1];
  const rawUrl = `${base}/raw?${q({ ref: keepRef ?? ref, path })}`;
  return h`${head}
<div class="card files-file">
  <div class="row gap files-file-head"><strong>${name}</strong><span class="muted small">${bytes(file.size)}</span>
    <span class="grow"></span>${file.text !== null ? h`<a class="btn ghost small" href="${rawUrl}">Raw</a>` : ''}<a class="btn small" href="${rawUrl}&amp;download=1" download>Download</a></div>
  ${file.text !== null && /\.(md|markdown)$/i.test(name)
    ? h`<div class="readme">${markdown(file.text, { dir: parts.slice(0, -1).join('/'), link: filesUrl, image: rawOf, html: true })}</div>`
    : file.text !== null
    ? h`<pre class="files-code"><code>${file.text}</code></pre>`
    : alert(file.size > SHOW_MAX ? `This file is ${bytes(file.size)}, too big to show here. Download it instead.` : 'This file is not text, so it is not shown here. Download it instead.', 'info')}
</div>`;
}
