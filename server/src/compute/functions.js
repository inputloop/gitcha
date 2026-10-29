// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Lambda functions. A function is a small program owned by a user or team.
// It is deployed from a tarball (a packed archive) that holds gitcha.fn.json
// and its code. It runs on a runner, never on the Gitcha server. It runs when
// a hosted site routes a request to it, or when someone invokes it through the
// API. A "chain" function (drawn in TopoForge) calls other functions of the
// same owner, in order.
// Store: data.functions, keyed "owner/name". Each record keeps up to 20
// versions; the code of each version is a blob named by its sha256 hash.
import { HttpError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { unpackFiles, packFiles } from '../../../extension/lib/tar.js';
import { normalizeFunction } from './formats.js';
import { ownerKey } from './jobs.js';

// A request sent to a function through a site may be at most 1 MB.
const MAX_BODY = 1024 * 1024;
// Hop-by-hop headers: they describe one connection, not the request itself,
// so they are never passed through in either direction.
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'host', 'content-length']);
// A chain runs at most this many functions.
const MAX_CHAIN = 10;

// Turn "name" or "@team" into { type, name }. Team names are lowercased.
export function parseOwner(s) {
  s = String(s ?? '');
  return s.startsWith('@') ? { type: 'team', name: s.slice(1).toLowerCase() } : { type: 'user', name: s };
}
// The reverse of parseOwner.
export const ownerLabel = (o) => (o.type === 'team' ? `@${o.name}` : o.name);

/**
 * Deploys, lists, removes and runs functions. Running one means queueing a
 * job of kind "fn" and waiting for a runner to answer.
 */
export class FunctionService {
  constructor({ store, config, teams, jobs, billing, clock = Date.now }) {
    Object.assign(this, { store, config, teams, jobs, billing, clock });
    store.data.functions ??= {};
  }

  // The store key for a function.
  key(owner, name) { return `${ownerKey(owner)}/${name}`; }

  // May deploy or delete: the owning user, or a maintainer of the owning team.
  canManage(user, owner) {
    if (!user) return false;
    if (owner.type === 'user') return owner.name === user.username;
    const t = this.store.team(owner.name);
    return Boolean(t && this.teams.has(t, user, 'maintainer'));
  }

  // May see: the owner, team members, and admins.
  canSee(user, owner) {
    if (!user) return false;
    if (owner.type === 'user') return owner.name === user.username || user.role === 'admin';
    const t = this.store.team(owner.name);
    return user.role === 'admin' || Boolean(t && this.teams.has(t, user, 'member'));
  }

  // Look up a function with no access check.
  find(owner, name) {
    return this.store.data.functions[this.key(owner, name)] ?? null;
  }

  // Look up a function the user may see (or manage). Anything else is 404, so
  // nobody learns that a private function exists.
  get(user, owner, name, { manage = false } = {}) {
    const fn = this.find(owner, name);
    const ok = fn && (manage ? this.canManage(user, owner) : this.canSee(user, owner));
    if (!ok) throw new HttpError(404, 'fn_not_found', `No function ${ownerLabel(owner)}/${name}.`);
    return fn;
  }

  // The API shape of a function: the active version's settings and the version
  // list (newest first), without the source hashes.
  view(fn) {
    const v = fn.versions.find((x) => x.version === fn.active);
    return {
      name: fn.name, owner: ownerLabel(fn.owner), active: fn.active, runtime: v?.runtime, entry: v?.entry, chain: v?.chain ?? null,
      public: v?.public ?? false, timeoutMs: v?.timeoutMs, memoryMb: v?.memoryMb, description: v?.description ?? '',
      versions: fn.versions.map(({ sourceSha, ...rest }) => rest).reverse(), invocations: fn.invocations ?? 0,
    };
  }

  // Every function the user may see, optionally for one owner.
  list(user, owner) {
    return Object.values(this.store.data.functions)
      .filter((f) => this.canSee(user, f.owner) && (!owner || ownerKey(f.owner) === ownerKey(owner)))
      .map((f) => this.view(f));
  }

  // Deploy a new version. Steps: unpack the tarball, read and check
  // gitcha.fn.json, choose the owner, store the code as a blob, then add the
  // version and make it active. A chain may not call itself.
  deploy(user, { tarball, team }, ip) {
    if (!Buffer.isBuffer(tarball) || !tarball.length) throw new HttpError(400, 'no_tarball', 'No function tarball was sent.');
    if (tarball.length > this.config.maxPackageBytes) throw new HttpError(413, 'too_large', 'Function is too large.');
    let files;
    try { files = new Map(unpackFiles(tarball, { maxBytes: 4 * this.config.maxPackageBytes }).map((f) => [f.path, f.data])); } catch (err) {
      throw new HttpError(400, 'bad_tarball', `Invalid function tarball: ${err.message}`);
    }
    const cfg = files.get('gitcha.fn.json');
    if (!cfg) throw new HttpError(400, 'no_fn_config', 'The upload has no gitcha.fn.json.');
    let raw;
    try { raw = JSON.parse(cfg.toString('utf8')); } catch { throw new HttpError(400, 'bad_spec', 'gitcha.fn.json is not valid JSON.'); }
    const spec = normalizeFunction(raw, files);
    if (spec.runtime === 'orgvm' && !this.config.compute.orgvm) {
      throw new HttpError(400, 'orgvm_unavailable', 'This instance has no orgvm runners yet (GITCHA_ORGVM=yes once one is set up).');
    }
    const owner = team ? (() => { const t = this.teams.get(team); this.teams.require(t, user, 'maintainer'); return { type: 'team', name: t.name }; })()
      : { type: 'user', name: user.username };
    if (spec.chain) {
      for (const n of spec.chain) if (n === spec.name) throw new HttpError(400, 'bad_spec', 'A chain cannot call itself.');
    }
    // Re-pack the files, so that org blocks pulled out into their own files
    // become part of what the runner gets.
    const packed = packFiles([...files].map(([path, data]) => ({ path, data })));
    const sourceSha = sha256(packed);
    this.store.writeBlob(sourceSha, packed);
    const k = this.key(owner, spec.name);
    const existing = this.store.data.functions[k];
    const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const record = { version, ...spec, sourceSha, deployedAt: this.clock(), deployedBy: user.username };
    this.store.tx((d) => {
      const fn = d.functions[k] ?? { name: spec.name, owner, createdAt: this.clock(), versions: [], invocations: 0 };
      fn.versions.push(record);
      if (fn.versions.length > 20) fn.versions.splice(0, fn.versions.length - 20);
      fn.active = version;
      d.functions[k] = fn;
      this.store.audit({ userId: user.id, event: 'function.deployed', ip, function: `${ownerLabel(owner)}/${spec.name}`, version });
    });
    return this.view(this.store.data.functions[k]);
  }

  // Delete a function and all its versions. Only someone who may manage it may do this.
  remove(user, owner, name, ip) {
    const fn = this.get(user, owner, name, { manage: true });
    this.store.tx((d) => {
      delete d.functions[this.key(owner, fn.name)];
      this.store.audit({ userId: user.id, event: 'function.deleted', ip, function: `${ownerLabel(owner)}/${fn.name}` });
    });
    return { deleted: `${ownerLabel(owner)}/${fn.name}` };
  }

  /**
   * Run one invocation. request = { method, path, query, headers, body (Buffer) }.
   * It queues a job and waits up to the function's time limit plus the queue
   * wait. It returns { status, headers, body, ms, log }. 503 means no runner
   * picked it up, 504 means it timed out, 502 means it failed.
   */
  async invoke(fn, request, { depth = 0 } = {}) {
    const v = fn.versions.find((x) => x.version === fn.active);
    if (v.runtime === 'chain') return this.invokeChain(fn, v, request, depth);
    this.billing?.check(ownerKey(fn.owner), 'fn_invocations');
    const started = this.clock();
    const job = this.jobs.enqueue({
      kind: 'fn', owner: fn.owner, labels: v.runtime === 'orgvm' ? ['orgvm'] : [], sourceSha: v.sourceSha, timeoutMs: v.timeoutMs,
      spec: {
        fn: { name: fn.name, runtime: v.runtime, entry: v.entry, image: v.image, memoryMb: v.memoryMb, timeoutMs: v.timeoutMs },
        request: { ...request, body: request.body?.length ? request.body.toString('base64') : '' },
      },
    });
    const done = await this.jobs.awaitResult(job, v.timeoutMs + this.config.compute.queueWaitMs);
    // Only a call that a runner picked up is counted. A call nobody served costs
    // the owner nothing (FN-1b).
    if (done.startedAt) {
      this.billing?.record(ownerKey(fn.owner), 'fn_invocations', 1);
      const k = this.key(fn.owner, fn.name);
      // Count on the stored record, not the copy this call started with: other calls may have counted since.
      this.store.tx((d) => { if (d.functions[k]) d.functions[k].invocations = (d.functions[k].invocations ?? 0) + 1; });
    }
    if (done.status === 'succeeded' && done.response) return { ...normalizeResponse(done.response), ms: this.clock() - started, log: done.log ?? '' };
    if (done.status === 'timed_out' && !done.startedAt) {
      return { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('No runner is available to run this function right now.\n'), ms: this.clock() - started };
    }
    if (done.status === 'timed_out') return { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('The function timed out.\n'), ms: this.clock() - started };
    return { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`The function failed${done.error ? `: ${done.error}` : '.'}\n`), ms: this.clock() - started, log: done.log ?? '' };
  }

  // Run a chain: call each named function in turn, feeding each one the last
  // one's response as a POST body. It stops at the first error (status 400 or
  // more). A chain may not call another chain (508).
  async invokeChain(fn, v, request, depth) {
    if (depth >= 1) return { status: 508, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Chains cannot call chains.\n') };
    let req = request;
    let res = null;
    for (const name of v.chain.slice(0, MAX_CHAIN)) {
      const next = this.find(fn.owner, name);
      if (!next) return { status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`Chain step "${name}" does not exist.\n`) };
      res = await this.invoke(next, req, { depth: depth + 1 });
      if (res.status >= 400) return res;
      req = { ...request, method: 'POST', headers: { 'content-type': res.headers['content-type'] ?? 'application/octet-stream' }, body: res.body };
    }
    return res;
  }

  /**
   * A hosted site routed this request to one of its owner's functions. Pass the
   * request on (without hop-by-hop headers), then send back the function's
   * answer. Response header names are checked and line breaks are removed from
   * values, so a function cannot break the HTTP reply.
   */
  async invokeHttp(ctx, { site, name }) {
    const { req, res, url } = ctx;
    const fn = this.find(site.owner, name);
    if (!fn) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`This site routes to a function "${name}" that does not exist.\n`);
    }
    const body = await readCapped(req, MAX_BODY);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Request body too large.\n');
    }
    const headers = {};
    for (const [k, val] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = Array.isArray(val) ? val.join(', ') : val;
    let out;
    try {
      out = await this.invoke(fn, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      out = { status: err.status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`${err.message}\n`) };
    }
    const h = {};
    for (const [k, val] of Object.entries(out.headers ?? {})) if (!HOP.has(k.toLowerCase()) && /^[A-Za-z0-9-]{1,64}$/.test(k)) h[k] = String(val).replace(/[\r\n]/g, '');
    res.writeHead(out.status, { 'X-Content-Type-Options': 'nosniff', ...h, 'X-Gitcha-Function': `${ownerLabel(fn.owner)}/${fn.name}` });
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }
}

// Clean up a runner's answer: a valid status (else 200), lowercase header names, and a Buffer body.
function normalizeResponse(r) {
  const status = Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : 200;
  const headers = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[String(k).toLowerCase()] = String(v);
  return { status, headers, body: Buffer.from(String(r.body ?? ''), r.bodyEncoding === 'base64' ? 'base64' : 'utf8') };
}

// Read a whole request body, or return null as soon as it passes `limit` bytes.
async function readCapped(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
