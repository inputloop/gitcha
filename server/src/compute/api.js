// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The JSON API for runners, CI runs and functions. A runner is a machine
// that does build work: it asks the server for a job, runs it, and sends back
// the log and the result. CI (continuous integration) means building and
// testing code automatically. Functions are small programs that run per
// request. The real work happens in jobs.js, ci.js and functions.js; this
// file checks who is calling and reads the request body.
import { json, send, readJson } from '../http.js';
import { HttpError } from '../errors.js';
import { makeGuards } from '../api.js';
import { pipelineFromTarball } from './ci.js';
import { parseOwner } from './functions.js';

// A runner sends its log in pieces of at most 256 KB each.
const LOG_PIECE = 256 * 1024;

/**
 * Read a request body, keeping at most `limit` bytes. It reads and throws away
 * up to 16 MiB more (it does not store them), then stops reading.
 * `over` is true when the body was too big.
 */
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

// The tarball (a packed archive of files) arrives base64-encoded inside JSON.
const tarballFrom = (body) => Buffer.from(String(body.tarball ?? ''), 'base64');

/** Add the runner, CI and functions routes to the router. */
export function registerComputeApi(router, { auth, jobs, ci, functions, config, principals, billing, budgets }) {
  const { verified, bearer } = makeGuards(auth, config);

  // ---- the runner protocol -------------------------------------------------------
  // A runner signs in with its runner token. For a job's own routes it must
  // also send that job's token (x-gitcha-job-token), and the job must be its own.
  const runnerAuth = (ctx) => {
    const r = jobs.authRunner(bearer(ctx.req));
    if (!r) throw new HttpError(401, 'bad_runner_token', 'Unknown or disabled runner.');
    return r;
  };
  const jobAuth = (ctx) => {
    const r = runnerAuth(ctx);
    return jobs.jobFor(ctx.params.id, ctx.req.headers['x-gitcha-job-token'], r.id);
  };

  // A new runner trades a registration code for its runner token.
  router.post('/api/v1/runner/register', async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx.res, 201, jobs.register(body, ctx.ip));
  });

  // Long polling: the runner asks for a job and the server holds the request
  // open for up to wait_ms (default 25 seconds) until one is ready. 204 means
  // "nothing yet, ask again".
  router.post('/api/v1/runner/claim', async (ctx) => {
    const r = runnerAuth(ctx);
    const { wait_ms: wait = 25_000 } = await readJson(ctx.req);
    let closed = false;
    ctx.req.on('close', () => { closed = true; });
    const got = await jobs.claim(r, Number(wait));
    if (closed && got) {
      // The runner went away while we were handing it a job: put the job back.
      const j = jobs.get(got.job.id);
      if (j) { jobs.requeue(j); jobs.dispatch(); }
      return;
    }
    if (!got) return send(ctx.res, 204, '');
    json(ctx.res, 200, { job: got.job, job_token: got.jobToken });
  });

  // The runner downloads the job's source tarball.
  router.get('/api/v1/runner/jobs/:id/source', (ctx) => {
    const j = jobAuth(ctx);
    if (!j.sourceSha) throw new HttpError(404, 'no_source', 'This job has no source.');
    send(ctx.res, 200, j.ownSource ? jobs.readSource(j) : auth.store.readBlob(j.sourceSha), { 'Content-Type': 'application/gzip' });
  });

  router.post('/api/v1/runner/jobs/:id/log', async (ctx) => {
    const j = jobAuth(ctx);
    // For a piece over the cap, the server keeps the first part and reads the
    // rest to the end (so the connection stays usable). Then it replies with a clear 413.
    const { body, over } = await readCapped(ctx.req, LOG_PIECE);
    jobs.appendLog(j, body.toString('utf8'));
    if (over) throw new HttpError(413, 'log_piece_too_large', `Send the log in pieces under ${LOG_PIECE} bytes; the first ${LOG_PIECE} bytes of this one were kept.`);
    send(ctx.res, 204, '');
  });

  // The runner reports the result: status, exit code, and maybe an artifact
  // (the built files, base64) or a function's response.
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
  // People make registration codes and remove runners here. Changes need a fresh 2FA code ("sensitive").
  router.post('/api/v1/runners/registrations', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { team, uses } = await readJson(ctx.req);
    json(ctx.res, 201, jobs.createRegistration(a.user, { team, uses }, ctx.ip));
  });

  router.get('/api/v1/runners/registrations', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, { registrations: jobs.registrationsFor(a.user) });
  });

  router.delete('/api/v1/runners/registrations/:id', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, jobs.revokeRegistration(a.user, ctx.params.id, ctx.ip));
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
    // An agent key (it starts with "gak_") runs work in the paid sandbox for its
    // agent. The owner needs a paid plan, or the agent needs budget left.
    const tok = bearer(ctx.req);
    if (tok?.startsWith('gak_')) {
      const p = principals.fromToken(tok, ctx.ip, { purpose: 'sandbox' }); // an agent key opens this door only
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
    // A build that publishes a site is as sensitive as deploying by hand, so it
    // needs a fresh 2FA code too. If the pipeline cannot be read here, run() reports the error.
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

  // Only someone who may manage the run may cancel it.
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

  // Call a function through the API. A public function needs no sign-in; a
  // private one is shown only to its owner's side (anyone else gets 404).
  // The response comes back as JSON (body in base64), never rendered on this
  // origin, so a function cannot run scripts on Gitcha's own pages.
  // Only someone who may manage the function sees the last 20,000 characters of its log.
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
