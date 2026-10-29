// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Git over HTTPS (the "smart" protocol) through `git http-backend`, plus the
// loopback-only endpoints the SSH helpers call. Clone URL:
//   https://HOST/git/OWNER/NAME.git      (OWNER is a username or @team)
// Credentials: a device token, console key or agent key as the password. The
// username is ignored, unless it names one of the token owner's agents: then
// the agent acts (agents push for free this way, as themselves). Pushing needs the usual 2FA freshness for people; a git client
// cannot answer a challenge, so a due check is reported with what to run.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HttpError } from '../errors.js';
import { json, readJson, send } from '../http.js';
import { principalKey } from '../social/principal.js';
import { parseOwnerLabel, GIT_ENV } from './projects.js';

// A push waits at most this long for its record before the client is told it is done (the checking carries on).
const RECORD_WAIT_MS = 5000;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
// A POST body is a git pack request and nothing else; http-backend refuses any other type without reading the body.
const REQUEST_TYPES = { 'git-upload-pack': 'application/x-git-upload-pack-request', 'git-receive-pack': 'application/x-git-receive-pack-request' };

function basicCreds(req) {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ')) return { user: null, token: h.slice(7).trim() };
  if (!h.startsWith('Basic ')) return { user: null, token: null };
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return { user: decoded.slice(0, i), token: decoded.slice(i + 1) || null };
}

/**
 * The HTTP username picks who is acting: one of the token owner's agents
 * (agents push for free this way, as themselves), otherwise the person.
 */
function principalFrom(principals, creds, ip) {
  const p = principals.fromToken(creds.token, ip);
  if (!p || p.kind !== 'user' || !creds.user) return p;
  const agent = principals.agents.data[String(creds.user).toLowerCase()];
  if (agent && agent.owner === p.user.id) return { kind: 'agent', agent, owner: p.user, via: 'owner_token', auth: p.auth };
  return p;
}

function challenge(res, message) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Gitcha", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

/** Make sure a person's session has passed its periodic 2FA check. */
function mfaOk(auth, principal) {
  // An agent acting through its owner's token is held to the owner's 2FA checks.
  if (!principal.auth) return { ok: true };
  return auth.mfaState(principal.auth);
}

/**
 * SSH carries no session, so the periodic check is read from the person's devices: the newest code entered on any of
 * them must be inside the step-up interval (when the person's own settings keep that check on). Agents act as
 * themselves, as with an agent key over HTTPS.
 */
function sshMfaOk(auth, principal) {
  if (principal.kind !== 'user') return { ok: true };
  if (!auth.checkSettings(principal.user).interval) return { ok: true };
  const newest = Math.max(0, ...auth.store.sessionsForUser(principal.user.id).filter((s) => s.kind !== 'enroll').map((s) => s.mfaAt ?? 0));
  return auth.clock() - newest > auth.config.policy.stepUpInterval ? { ok: false, reason: 'interval' } : { ok: true };
}

export function internalSecret(config) {
  const file = path.join(config.dataDir, 'internal.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export function registerGit(router, { auth, projects, principals, config }) {
  router.add('GET', '/git/:owner/:repo/info/refs', (ctx) => serve(ctx, 'info/refs'));
  router.add('POST', '/git/:owner/:repo/git-upload-pack', (ctx) => serve(ctx, 'git-upload-pack'));
  router.add('POST', '/git/:owner/:repo/git-receive-pack', (ctx) => serve(ctx, 'git-receive-pack'));

  async function serve(ctx, tail) {
    const { req, res, url, params } = ctx;
    const repo = params.repo.replace(/\.git$/, '');
    const p = projects.find(params.owner, repo);
    const service = tail === 'info/refs' ? url.searchParams.get('service') : tail;
    if (!SERVICES.has(service)) return send(res, 403, 'Only the smart HTTP protocol is supported.\n', { 'Content-Type': 'text/plain' });
    const write = service === 'git-receive-pack';
    const principal = principalFrom(principals, basicCreds(req), ctx.ip);
    // Unknown and private projects look the same to someone who cannot read them.
    if (!p || !projects.canRead(principal, p)) return principal ? send(res, 404, 'Repository not found.\n', { 'Content-Type': 'text/plain' }) : challenge(res, 'Sign in: use a Gitcha console key or device token as the password.');
    if (write || !(p.visibility === 'public' && !principal)) {
      if (!principal) return challenge(res, 'Sign in: use a Gitcha console key or device token as the password.');
      const m = mfaOk(auth, principal);
      if (!m.ok) return send(res, 403, `Your periodic two-factor check is due (${m.reason}). Run \`gitcha verify\`, then push again.\n`, { 'Content-Type': 'text/plain' });
    }
    if (write && !projects.canWrite(principal, p)) return send(res, 403, `You cannot push to ${projects.key(p.owner, p.name)}.\n`, { 'Content-Type': 'text/plain' });
    if (tail !== 'info/refs' && String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== REQUEST_TYPES[service]) {
      return send(res, 415, `Send this as ${REQUEST_TYPES[service]}.\n`, { 'Content-Type': 'text/plain', Connection: 'close' });
    }
    const before = write ? projects.refs(p) : null;
    const env = {
      PATH: process.env.PATH, GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_PROJECT_ROOT: projects.root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${p.owner.type}/${p.owner.name}/${p.name}.git/${tail}`, REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: ctx.ip,
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      ...(principal ? { REMOTE_USER: principalKey(principal) } : {}),
    };
    await new Promise((resolve) => {
      const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let head = Buffer.alloc(0);
      let headerDone = false;
      // http-backend may exit without reading the whole body (it refuses what it dislikes), and a client may leave
      // mid-upload. Neither may become an uncaught error, which would end the whole server.
      child.stdin.on('error', () => { /* EPIPE: the backend is done with its input */ });
      child.on('error', (err) => { console.error('git http-backend could not run', err.message); });
      res.on('error', () => { /* the client is gone */ });
      req.on('error', () => child.kill());
      req.on('close', () => { if (!req.complete) child.kill(); });
      req.pipe(child.stdin);
      child.stdout.on('data', (chunk) => {
        if (res.destroyed) return undefined;
        if (headerDone) return res.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return undefined;
        headerDone = true;
        const headers = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
          const i = line.indexOf(':');
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === 'status') status = parseInt(v, 10);
          else headers[k] = v;
        }
        res.writeHead(status, { ...headers, 'Cache-Control': 'no-cache' });
        return res.write(head.subarray(end + 4));
      });
      child.stderr.on('data', () => { /* git's progress and errors go to the client inside the protocol */ });
      child.on('close', async (code) => {
        // The client hears that the push is done once it is recorded, but never waits long for the checking.
        if (write && code === 0) {
          const recorded = projects.afterPush(p, principal, before).catch((err) => console.error('afterPush failed', err));
          let timer;
          await Promise.race([recorded, new Promise((r) => { timer = setTimeout(r, RECORD_WAIT_MS); })]);
          clearTimeout(timer);
        }
        if (res.destroyed) { /* nobody is listening */ } else if (!headerDone) send(res, 500, 'git http-backend failed.\n', { 'Content-Type': 'text/plain' });
        else res.end();
        resolve();
      });
    });
  }

  // ---- loopback-only endpoints for the SSH helpers (bin/gitcha-ssh-keys, bin/gitcha-git-shell) ----
  const secret = internalSecret(config);
  const internal = (ctx) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.req.socket.remoteAddress);
    const given = Buffer.from(String(ctx.req.headers['x-gitcha-internal'] ?? ''));
    const want = Buffer.from(secret);
    if (!local || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(404, 'not_found', 'Not found.');
  };
  // The helpers read JSON, so a refusal says why instead of rendering a page they cannot read.
  const helper = (fn) => async (ctx) => {
    try { await fn(ctx); } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      json(ctx.res, err.status, { error: err.code, message: err.message });
    }
  };

  router.get('/internal/ssh/keys', helper((ctx) => {
    internal(ctx);
    const line = principals.keysLine(ctx.url.searchParams.get('fingerprint'));
    send(ctx.res, 200, line, { 'Content-Type': 'text/plain' });
  }));

  router.post('/internal/git/authorize', helper(async (ctx) => {
    internal(ctx);
    const { fingerprint, command } = await readJson(ctx.req);
    const m = /^(git-upload-pack|git-receive-pack) '?\/?([^'/]+)\/([^'/]+?)(?:\.git)?\/?'?$/.exec(String(command ?? ''));
    if (!m) throw new HttpError(403, 'bad_command', 'Only git clone, fetch and push are allowed over SSH.');
    const principal = principals.fromSsh(fingerprint);
    if (!principal) throw new HttpError(403, 'unknown_key', 'That SSH key is not registered on Gitcha.');
    const p = projects.find(parseOwnerLabel(m[2]), m[3]);
    const write = m[1] === 'git-receive-pack';
    if (!p || !projects.canRead(principal, p)) throw new HttpError(404, 'not_found', 'Repository not found.');
    // The same periodic check an HTTPS push meets; a git client cannot answer a challenge, so say what to run.
    const m2 = sshMfaOk(auth, principal);
    if (!m2.ok) throw new HttpError(403, 'stepup_due', `Your periodic two-factor check is due (${m2.reason}). Run \`gitcha verify\`, then try again.`);
    if (write && !projects.canWrite(principal, p)) throw new HttpError(403, 'forbidden', `You cannot push to ${projects.key(p.owner, p.name)}.`);
    json(ctx.res, 200, { service: m[1], repo: projects.repoDir(p), project: projects.key(p.owner, p.name), principal: principalKey(principal), before: write ? projects.refs(p) : null });
  }));

  router.post('/internal/git/pushed', helper(async (ctx) => {
    internal(ctx);
    const { fingerprint, project, before } = await readJson(ctx.req);
    const p = projects.store.data.projects[project];
    const principal = principals.fromSsh(fingerprint);
    if (!p || !principal || !projects.canWrite(principal, p)) throw new HttpError(403, 'forbidden', 'Not allowed.');
    json(ctx.res, 200, await projects.afterPush(p, principal, before ?? {}));
  }));
}
