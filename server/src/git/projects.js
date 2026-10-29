// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Projects: git repositories hosted by Gitcha, owned by a user or a team.
// Agents and people are added as collaborators by the project's maintainers.
// Every push is read for who did the work (a pushing agent's key, or the
// house byline on the last line of a commit message) and whether commits
// carry a good signature from a registered GPG key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { HttpError } from '../errors.js';
import { parseByline } from '../social/agents.js';

export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const ownerLabel = (o) => (o.type === 'team' ? `@${o.name}` : o.name);
export function parseOwnerLabel(s) {
  s = decodeURIComponent(String(s ?? ''));
  return s.startsWith('@') ? { type: 'team', name: s.slice(1).toLowerCase() } : { type: 'user', name: s.toLowerCase() };
}

// Git on the server ignores the host's global and system config, so nothing on
// the machine (signing format, hooks paths, aliases) changes how repos are read.
export const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV, ...opts });

/**
 * Run a program without stopping the event loop (a push must not freeze sites, runners and the API while git and gpg
 * work). Resolves { status, stdout (Buffer), stderr } whatever the exit status; rejects if it cannot start, runs past
 * `timeout`, or prints more than `max` bytes.
 */
function run(cmd, args, { input, env = GIT_ENV, timeout = 30_000, max = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} ran too long`)); }, timeout);
    const fail = (e) => { clearTimeout(timer); child.kill('SIGKILL'); reject(e); };
    child.on('error', fail);
    child.stdin.on('error', () => { /* it may exit before reading everything */ });
    child.stdout.on('data', (c) => { size += c.length; if (size > max) fail(new Error(`${cmd} printed too much`)); else out.push(c); });
    child.stderr.on('data', (c) => { if (err.length < 64) err.push(c); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }); });
    child.stdin.end(input);
  });
}

/** What a commit object says, read by its structure, never by delimiters that its message could contain. */
function parseCommit(sha, body) {
  const text = body.toString('utf8');
  const gap = text.indexOf('\n\n');
  const head = gap === -1 ? text : text.slice(0, gap);
  const author = /^author (.*) <([^>]*)> \d+ [+-]\d{4}$/m.exec(head);
  return { sha, authorName: author?.[1] ?? '', authorEmail: author?.[2] ?? '', signed: /^gpgsig /m.test(head), message: gap === -1 ? '' : text.slice(gap + 2) };
}

/** `git cat-file --batch` output: "<sha> <type> <size>\n<size bytes>\n" for each object asked for. */
function parseBatch(buf) {
  const commits = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) break;
    const [sha, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    const n = Number(size);
    if (type !== 'commit' || !Number.isInteger(n)) { at = nl + 1; continue; } // "<sha> missing"
    commits.push(parseCommit(sha, buf.subarray(nl + 1, nl + 1 + n)));
    at = nl + 1 + n + 1;
  }
  return commits;
}

// Anything that is not printable goes from a name or subject before it is stored and shown.
const printable = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n);

export class ProjectService {
  constructor({ store, config, teams, agents, keys, clock = Date.now }) {
    Object.assign(this, { store, config, teams, agents, keys, clock });
    store.data.projects ??= {};
    this.root = path.join(config.dataDir, 'git');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.onWorkedTogether = null; // set by the task service
    this.pushQueue = Promise.resolve(); // reading pushes one at a time keeps git and gpg from piling up
  }

  key(owner, name) { return `${ownerLabel(owner)}/${name}`; }

  repoDir(p) { return path.join(this.root, p.owner.type, p.owner.name, `${p.name}.git`); }

  find(ownerStr, name) {
    const owner = typeof ownerStr === 'string' ? parseOwnerLabel(ownerStr) : ownerStr;
    return this.store.data.projects[this.key(owner, String(name).toLowerCase().replace(/\.git$/, ''))] ?? null;
  }

  // ---- permissions -----------------------------------------------------------------
  /** principal: { kind: 'user', user } | { kind: 'agent', agent, owner } | null */
  isMaintainer(user, p) {
    if (!user) return false;
    if (p.owner.type === 'user') return p.owner.name === user.username;
    const t = this.store.team(p.owner.name);
    return Boolean(t && this.teams.has(t, user, 'maintainer'));
  }

  isMember(user, p) {
    if (!user) return false;
    if (p.owner.type === 'user') return p.owner.name === user.username;
    const t = this.store.team(p.owner.name);
    return Boolean(t && this.teams.has(t, user, 'member'));
  }

  canRead(principal, p) {
    if (p.visibility === 'public') return Boolean(principal) || this.config.publicRead;
    if (!principal) return false;
    if (principal.kind === 'agent') return p.collaborators.agents.includes(principal.agent.handle) || this.isMember(principal.owner, p);
    return this.isMember(principal.user, p) || p.collaborators.users.includes(principal.user.username) || principal.user.role === 'admin';
  }

  canWrite(principal, p) {
    if (!principal) return false;
    if (principal.kind === 'agent') return p.collaborators.agents.includes(principal.agent.handle) || this.isMaintainer(principal.owner, p);
    return this.isMaintainer(principal.user, p) || p.collaborators.users.includes(principal.user.username);
  }

  // ---- lifecycle -----------------------------------------------------------------------
  create(user, { name, team, description = '', visibility = 'public', tags = [] }, ip) {
    name = String(name ?? '').toLowerCase();
    if (!PROJECT_RE.test(name) || name.endsWith('.git')) throw new HttpError(400, 'bad_project_name', 'Project names are lowercase letters, digits, ".", "_" or "-" (max 64).');
    if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'bad_visibility', 'Visibility is public or private.');
    let owner = { type: 'user', name: user.username };
    if (team) {
      const t = this.teams.get(team);
      this.teams.require(t, user, 'maintainer');
      owner = { type: 'team', name: t.name };
    }
    const k = this.key(owner, name);
    if (this.store.data.projects[k]) throw new HttpError(409, 'project_exists', `${k} already exists.`);
    const p = {
      owner, name, description: String(description).slice(0, 500), visibility, createdAt: this.clock(), createdBy: user.username,
      tags: [...new Set((tags ?? []).map((t) => String(t).toLowerCase()).filter((t) => TAG_RE.test(t)))].slice(0, 10),
      collaborators: { users: [], agents: [] }, taskTracking: { enabled: false }, pushes: [],
    };
    fs.mkdirSync(path.dirname(this.repoDir(p)), { recursive: true });
    git(['init', '--bare', '--quiet', '--initial-branch=main', this.repoDir(p)]);
    git(['-C', this.repoDir(p), 'config', 'http.receivepack', 'true']);
    this.store.tx((d) => {
      d.projects[k] = p;
      this.store.audit({ userId: user.id, event: 'project.created', ip, project: k, visibility });
    });
    return p;
  }

  setCollaborator(user, p, { agent, username, remove = false }, ip) {
    if (!this.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers manage collaborators.');
    const list = agent ? 'agents' : 'users';
    const id = String(agent ?? username ?? '').toLowerCase();
    if (agent) this.agents.get(id);
    else if (!this.store.userByName(id)) throw new HttpError(404, 'user_not_found', `No user "${id}".`);
    this.store.tx((d) => {
      const c = d.projects[this.key(p.owner, p.name)].collaborators[list];
      const i = c.indexOf(id);
      if (remove && i !== -1) c.splice(i, 1);
      if (!remove && i === -1) c.push(id);
      this.store.audit({ userId: user.id, event: remove ? 'project.collaborator_removed' : 'project.collaborator_added', ip, project: this.key(p.owner, p.name), [list.slice(0, -1)]: id });
    });
    return p;
  }

  setTaskTracking(user, p, enabled, ip) {
    if (!this.isMaintainer(user, p)) throw new HttpError(403, 'project_forbidden', 'Only the project\'s maintainers can change task tracking.');
    this.store.tx((d) => {
      d.projects[this.key(p.owner, p.name)].taskTracking.enabled = Boolean(enabled);
      this.store.audit({ userId: user.id, event: 'project.task_tracking', ip, project: this.key(p.owner, p.name), enabled: Boolean(enabled) });
    });
    return p;
  }

  view(p, principal) {
    const base = this.config.publicUrl;
    const sshHost = this.config.git?.sshHost;
    return {
      key: this.key(p.owner, p.name), owner: ownerLabel(p.owner), name: p.name, description: p.description, visibility: p.visibility,
      tags: p.tags, createdAt: p.createdAt, collaborators: p.collaborators, taskTracking: p.taskTracking.enabled,
      cloneHttp: `${base}/git/${ownerLabel(p.owner)}/${p.name}.git`,
      cloneSsh: sshHost ? `${this.config.git.sshUser}@${sshHost}:${ownerLabel(p.owner)}/${p.name}.git` : null,
      canWrite: this.canWrite(principal, p), pushes: p.pushes.slice(-10).reverse(),
    };
  }

  list(principal) {
    return Object.values(this.store.data.projects).filter((p) => this.canRead(principal, p));
  }

  // ---- reading pushes ----------------------------------------------------------------------
  refs(p) {
    try {
      return Object.fromEntries(git(['-C', this.repoDir(p), 'for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([r, o]) => [r, o]));
    } catch { return {}; }
  }

  /**
   * Commits new in `after` that were not reachable from `before`, at most 500. The list of ids comes from rev-list and
   * each commit is read from its own object, so what the pusher put in a message can neither add records nor change
   * the count.
   */
  async newCommits(p, before, after) {
    const tips = [...new Set(Object.values(after))].filter((o) => !Object.values(before).includes(o));
    if (!tips.length) return [];
    const not = [...new Set(Object.values(before))];
    const dir = this.repoDir(p);
    const listed = await run('git', ['-C', dir, 'rev-list', '-n', '500', ...tips, ...(not.length ? ['--not', ...not] : [])]);
    if (listed.status !== 0) throw new Error('rev-list failed');
    const shas = listed.stdout.toString('utf8').split('\n').filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    if (!shas.length) return [];
    const read = await run('git', ['-C', dir, 'cat-file', '--batch'], { input: `${shas.join('\n')}\n` });
    if (read.status !== 0) throw new Error('cat-file failed');
    return parseBatch(read.stdout);
  }

  /**
   * Check signatures against the keys registered on Gitcha (not the server's own keyring). Registering a key proves
   * nothing about holding it, so only keys registered by the person who pushed are loaded and trusted here.
   */
  async verifySignatures(p, commits, pusherId) {
    const unsigned = (c) => ({ ...c, verified: false, signer: null });
    const mine = pusherId ? Object.values(this.keys.data.gpg).filter((k) => k.owner === pusherId) : [];
    if (!mine.length || !commits.some((c) => c.signed)) return commits.map(unsigned);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-verify-'));
    try {
      const imported = await run('gpg', ['--homedir', home, '--batch', '--import'], { input: mine.map((k) => k.armored).join('\n'), timeout: 20_000 });
      if (imported.status !== 0) throw new Error('gpg could not load the keys');
      const out = [];
      for (const c of commits) {
        if (!c.signed) { out.push(unsigned(c)); continue; }
        // --raw prints gpg's [GNUPG:] status lines on stderr, whether or not the check passes.
        const r = await run('git', ['-C', this.repoDir(p), 'verify-commit', '--raw', c.sha], { env: { ...GIT_ENV, GNUPGHOME: home }, timeout: 10_000 });
        const v = this.signer(`${r.stdout.toString('utf8')}\n${r.stderr}`, pusherId);
        out.push({ ...c, ...v, verified: r.status === 0 && v.verified });
      }
      return out;
    } catch {
      return commits.map((c) => ({ ...c, verified: false, signer: null, sigNote: 'gpg unavailable' }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  signer(raw, pusherId) {
    const m = /\[GNUPG:\] VALIDSIG ([0-9A-F]{16,40})/.exec(raw);
    const good = /\[GNUPG:\] GOODSIG/.test(raw);
    if (!m) return { verified: false, signer: null };
    const k = this.keys.gpgByFingerprint(m[1]);
    // A key someone else registered says nothing about this push: the registrant never showed they hold it (GIT-3).
    if (!k || !pusherId || k.owner !== pusherId) return { verified: false, signer: null };
    return { verified: good, signer: `${k.holder.kind}:${k.holder.name}` };
  }

  /**
   * Called after a successful receive-pack. Resolves to the push record once git and gpg are done; the refs are read
   * now, the rest waits its turn and never blocks the event loop.
   */
  afterPush(p, principal, before) {
    const after = this.refs(p);
    const job = this.pushQueue.then(() => this.recordPush(p, principal, before, after));
    this.pushQueue = job.catch(() => {});
    return job;
  }

  async recordPush(p, principal, before, after) {
    const pushedBy = principal?.kind === 'agent' ? principal.agent : null;
    // A byline only counts for an agent of the person pushing, so nobody can
    // credit (or pair for a Second Reader) someone else's agent.
    const pusherId = principal?.kind === 'agent' ? principal.owner?.id : principal?.user?.id;
    let commits = [];
    try { commits = await this.verifySignatures(p, await this.newCommits(p, before, after), pusherId); } catch { commits = []; }
    const agents = new Map();
    for (const c of commits) {
      const named = this.agents.fromByline(parseByline(c.message));
      const byAgent = named && pusherId && named.owner === pusherId ? named : null;
      const a = byAgent ?? pushedBy;
      c.agent = a?.handle ?? null;
      if (a) agents.set(a.handle, a);
    }
    for (const a of agents.values()) this.store.data.agents[a.handle].stats.commits += commits.filter((c) => c.agent === a.handle).length;
    const branches = Object.keys(after).filter((r) => after[r] !== before[r]);
    // git's HTTP client can make a receive-pack request that changes nothing: nothing to record.
    if (!branches.length) return { at: this.clock(), by: null, branches: [], commits: [], agents: [] };
    const push = {
      at: this.clock(), by: principal ? (principal.kind === 'agent' ? `agent:${principal.agent.handle}` : `user:${principal.user.username}`) : 'unknown',
      branches, commits: commits.slice(0, 50).map(({ sha, agent, verified, signer, authorName, message }) => ({ sha, agent, verified, signer, authorName: printable(authorName, 120), subject: printable(message.split('\n')[0], 120) })),
      agents: [...agents.keys()],
    };
    // Who else worked on these branches lately? Two different agents' work meeting is "working together".
    const recent = p.pushes.filter((x) => this.clock() - x.at < 7 * 86_400_000 && x.branches.some((b) => branches.includes(b))).flatMap((x) => x.agents);
    const together = [...new Set([...push.agents, ...recent])];
    this.store.tx((d) => {
      const rec = d.projects[this.key(p.owner, p.name)];
      rec.pushes.push(push);
      if (rec.pushes.length > 200) rec.pushes.splice(0, rec.pushes.length - 200);
    });
    try { this.onPushed?.(p, push); } catch { /* activity posts never fail a push */ }
    if (together.length >= 2 && push.agents.length && this.onWorkedTogether) {
      this.onWorkedTogether(p, { agents: together.slice(0, 2).map((h) => this.agents.get(h)), push });
    }
    return push;
  }
}
