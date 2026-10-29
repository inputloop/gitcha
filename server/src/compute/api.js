// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// JSON API for runners, CI runs and functions.
import { json, send, readJson } from '../http.js';
import { HttpError } from '../errors.js';
import { makeGuards } from '../api.js';
import { pipelineFromTarball } from './ci.js';
import { parseOwner } from './functions.js';

const LOG_PIECE = 256 * 1024;

/** Read a request body, keeping at most `limit` bytes and discarding (not storing) up to 16 MiB more. */
async function readCapped(req, limit) {
  const kept = [];
  let n = 0;
  let over = false;
  for await (const c of req) {
    n += c.length;
    if (n <= limit) kept.push(c);
    else {
      over = true;
      const room = limit - (n - c.length);
      if (room > 0) kept.push(c.subarray(0, room));
      if (n > limit + 16 * 1024 * 1024) break;
    }
  }
  return { body: Buffer.concat(kept), over };
}

const tarballFrom = (body) => Buffer.from(String(body.tarball ?? ''), 'base64');

export function registerComputeApi(router, { auth, jobs, ci, functions, config, principals, billing, budgets }) {
  const { verified, bearer } = makeGuards(auth, config);

  // ---- the runner protocol -------------------------------------------------------
  const runnerAuth = (ctx) => {
    const r = jobs.authRunner(bearer(ctx.req));
    if (!r) throw new HttpError(401, 'bad_runner_token', 'Unknown or disabled runner.');
    return r;
  };
  const jobAuth = (ctx) => {
    runnerAuth(ctx);
    return jobs.jobFor(ctx.params.id, ctx.req.headers['x-gitcha-job-token']);
  };

  router.post('/api/v1/runner/register', async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx.res, 201, jobs.register(body, ctx.ip));
  });

  router.post('/api/v1/runner/claim', async (ctx) => {
    const r = runnerAuth(ctx);
    const { wait_ms: wait = 25_000 } = await readJson(ctx.req);
    let closed = false;
    ctx.req.on('close', () => { closed = true; });
    const got = await jobs.claim(r, Number(wait));
    if (closed && got) {
      // The runner went away while we were handing it a job: put the job back.
      const j = jobs.get(got.job.id);
      if (j) { Object.assign(j, { status: 'queued', tokenHash: null }); jobs.queue.unshift(j.id); jobs.dispatch(); }
      return;
    }
    if (!got) return send(ctx.res, 204, '');
    json(ctx.res, 200, { job: got.job, job_token: got.jobToken });
  });

  router.get('/api/v1/runner/jobs/:id/source', (ctx) => {
    const j = jobAuth(ctx);
    if (!j.sourceSha) throw new HttpError(404, 'no_source', 'This job has no source.');
    send(ctx.res, 200, auth.store.readBlob(j.sourceSha), { 'Content-Type': 'application/gzip' });
  });

  router.post('/api/v1/runner/jobs/:id/log', async (ctx) => {
    const j = jobAuth(ctx);
    // A piece over the cap keeps its first part, is read to the end (so the connection stays usable) and gets a clear 413.
    const { body, over } = await readCapped(ctx.req, LOG_PIECE);
    jobs.appendLog(j, body.toString('utf8'));
    if (over) throw new HttpError(413, 'log_piece_too_large', `Send the log in pieces under ${LOG_PIECE} bytes; the first ${LOG_PIECE} bytes of this one were kept.`);
    send(ctx.res, 204, '');
  });

  router.post('/api/v1/runner/jobs/:id/complete', async (ctx) => {
    const j = jobAuth(ctx);
    const body = await readJson(ctx.req, Math.ceil(config.hosting.maxSiteBytes * 1.4) + 1024 * 1024 * 2);
    const done = await jobs.complete(j, {
      status: body.status, exitCode: body.exit_code ?? null, error: body.error ?? null,
      artifact: body.artifact ? Buffer.from(String(body.artifact), 'base64') : null, response: body.response ?? null,
    });
    json(ctx.res, 200, { status: done.status });
  });

  // ---- managing runners ------------------------------------------------------------
  router.post('/api/v1/runners/registrations', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { team } = await readJson(ctx.req);
    json(ctx.res, 201, jobs.createRegistration(a.user, { team }, ctx.ip));
  });

  router.get('/api/v1/runners', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, { runners: jobs.runnersFor(a.user) });
  });

  router.delete('/api/v1/runners/:id', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, jobs.removeRunner(a.user, ctx.params.id, ctx.ip));
  });

  // ---- CI ----------------------------------------------------------------------------
  router.post('/api/v1/ci/runs', async (ctx) => {
    // An agent key runs work in the paid sandbox for its agent.
    const tok = bearer(ctx.req);
    if (tok?.startsWith('gak_')) {
      const p = principals.fromToken(tok, ctx.ip);
      if (!p) throw new HttpError(401, 'unauthenticated', 'That agent key is not valid.');
      const paid = billing.enabled && billing.plans[billing.planFor(`user:${p.owner.username}`)]?.paid;
      if (!paid && budgets.balance(`agent:${p.agent.handle}`) <= 0) throw new HttpError(402, 'budget_exhausted', `${p.agent.handle} has no sandbox budget left and its owner has no paid plan.`);
      const body = await readJson(ctx.req, Math.ceil(config.maxPackageBytes * 1.4) + 4096);
      const tarball = tarballFrom(body);
      json(ctx.res, 201, ci.run(p.owner, { tarball, sandboxAgent: p.agent.handle, paidByPlan: Boolean(paid) }, ctx.ip));
      return;
    }
    let a = verified(ctx);
    const body = await readJson(ctx.req, Math.ceil(config.maxPackageBytes * 1.4) + 4096);
    const tarball = tarballFrom(body);
    // A build that publishes a site is as sensitive as deploying by hand.
    let found = null;
    try { found = pipelineFromTarball(tarball, { defaultImage: config.compute.defaultImage, maxUnpackedBytes: 4 * config.maxPackageBytes }); } catch { /* run() reports it */ }
    if (found?.pipeline.deploy) a = verified(ctx, { sensitive: true });
    json(ctx.res, 201, ci.run(a.user, { tarball, team: body.team || undefined }, ctx.ip));
  });

  router.get('/api/v1/ci/runs', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, { runs: ci.list(a.user) });
  });

  router.get('/api/v1/ci/runs/:id', (ctx) => {
    const a = verified(ctx);
    const j = ci.get(a.user, ctx.params.id);
    json(ctx.res, 200, { ...jobs.view(j), spec: jobs.specOf(j), log: jobs.readLog(j) });
  });

  router.post('/api/v1/ci/runs/:id/cancel', async (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, jobs.view(await jobs.cancel(a.user, ctx.params.id, (u, j) => ci.canManage(u, j))));
  });

  // ---- functions -----------------------------------------------------------------------
  router.put('/api/v1/functions', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req, Math.ceil(config.maxPackageBytes * 1.4) + 4096);
    json(ctx.res, 201, functions.deploy(a.user, { tarball: tarballFrom(body), team: body.team || undefined }, ctx.ip));
  });

  router.get('/api/v1/functions', (ctx) => {
    const a = verified(ctx);
    const owner = ctx.url.searchParams.get('owner');
    json(ctx.res, 200, { functions: functions.list(a.user, owner ? parseOwner(owner) : null) });
  });

  router.get('/api/v1/functions/:owner/:name', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, functions.view(functions.get(a.user, parseOwner(ctx.params.owner), ctx.params.name)));
  });

  router.delete('/api/v1/functions/:owner/:name', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, functions.remove(a.user, parseOwner(ctx.params.owner), ctx.params.name, ctx.ip));
  });

  // The response comes back as JSON (body base64), never rendered on this origin.
  router.post('/api/v1/functions/:owner/:name/invoke', async (ctx) => {
    const owner = parseOwner(ctx.params.owner);
    const fn = functions.find(owner, ctx.params.name);
    const v = fn?.versions.find((x) => x.version === fn.active);
    let user = null;
    if (!v?.public) user = verified(ctx).user;
    if (!fn || (!v.public && !functions.canSee(user, owner))) throw new HttpError(404, 'fn_not_found', 'No such function.');
    const body = await readJson(ctx.req, 2 * 1024 * 1024);
    const out = await functions.invoke(fn, {
      method: String(body.method ?? 'POST').toUpperCase().slice(0, 10), path: String(body.path ?? '/').slice(0, 2000),
      query: body.query && typeof body.query === 'object' ? body.query : {}, headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
      body: Buffer.from(String(body.body ?? ''), body.bodyEncoding === 'base64' ? 'base64' : 'utf8'),
    });
    json(ctx.res, 200, {
      status: out.status, headers: out.headers, body: out.body.toString('base64'), bodyEncoding: 'base64', ms: out.ms,
      ...(user && functions.canManage(user, owner) && out.log ? { log: out.log.slice(-20_000) } : {}),
    });
  });
}
