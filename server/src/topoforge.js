// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// TopoForge, both ways, over the JSON API. TopoForge is the browser drawing tool from inputloop (public copy: inputloop/topology, topoforge/);
// its files are JSON documents ("format": "topoforge"). Gitcha already reads drawings as CI pipelines
// (gitcha-ci.topoforge.json) and as chains of functions. These routes add the rest:
//
//   GET  /api/v1/ci/runs/:id/topoforge             a build's pipeline as a drawing, each step coloured by its result
//   GET  /api/v1/functions/:owner/:name/topoforge  a function (a chain is drawn as its steps)
//   GET  /api/v1/topoforge/system                  a map of this instance (administrators and staff only)
//   POST /api/v1/topoforge/import                  { drawing, as: "pipeline" | "chain" }: read a drawing and
//                                                  say what Gitcha would run, without running anything
//
// Each answers a TopoForge document to save and open in TopoForge (File > Open), sent as a download
// ("Content-Disposition: attachment"), never as a page on this origin. Each route uses the same guard and
// the same "who may see this" rule as the thing it draws.
import { HttpError } from './errors.js';
import { json, readJson, send } from './http.js';
import { makeGuards } from './api.js';
import { parseOwner } from './compute/functions.js';
import { normalizePipeline, pipelineFromTopoForge, chainFromTopoForge } from './compute/formats.js';
import { pipelineToDrawing, chainToDrawing, systemToDrawing, stepResults } from '../../extension/lib/topoforge.js';
import { FormatError } from '../../extension/lib/formats.js';

const isStaff = (user) => user?.role === 'admin' || user?.role === 'staff';

/** Send a drawing as a file download named `<name>.topoforge.json`. */
function sendDrawing(res, name, doc) {
  const file = `${String(name).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'drawing'}.topoforge.json`;
  send(res, 200, JSON.stringify(doc, null, 1), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` });
}

/** A FormatError from the shared writer is the caller's mistake: a 400, like the readers' own. */
function drawn(fn) {
  try { return fn(); } catch (err) { if (err instanceof FormatError) throw new HttpError(400, 'bad_spec', err.message); throw err; }
}

/** What the instance map shows. Everything here is what an administrator can already see elsewhere. */
export function systemSnapshot({ store, config, jobs, sites, ring, version, clock = Date.now }, user) {
  const d = store.data;
  return {
    name: config.ring?.name || new URL(config.publicUrl).host, url: config.publicUrl, version, host: new URL(config.publicUrl).host,
    at: new Date(clock()).toISOString(), store: config.store?.kind ?? 'file',
    counts: { users: Object.keys(d.users ?? {}).length, projects: Object.keys(d.projects ?? {}).length, packages: Object.keys(d.packages ?? {}).length },
    runners: jobs.runnersFor(user).map((r) => ({ name: r.name, online: r.online, backend: r.backend, labels: r.labels, capabilities: r.capabilities, scope: r.scope?.type === 'team' ? `team:${r.scope.name}` : 'instance' })),
    sites: Object.values(d.sites ?? {}).sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, owner: s.owner?.type === 'team' ? `team:${s.owner.name}` : `user:${s.owner?.name ?? ''}`, hostnames: sites.hostnames(s), deploys: (s.deploys ?? []).length })),
    ring: ring.memberUrls(),
  };
}

export function registerTopoForgeApi(router, services) {
  const { auth, config, ci, jobs, functions } = services;
  const { verified } = makeGuards(auth, config);

  // A build's pipeline, with each step's result read from its log. Whoever may see the build may draw it.
  router.get('/api/v1/ci/runs/:id/topoforge', (ctx) => {
    const a = verified(ctx);
    const j = ci.get(a.user, ctx.params.id);
    const pipeline = jobs.specOf(j)?.pipeline;
    if (!pipeline) throw new HttpError(404, 'no_pipeline', 'This build has no pipeline to draw.');
    const view = jobs.view(j);
    const results = view.status === 'queued' ? null : stepResults(pipeline.steps, jobs.readLog(j), view.status);
    sendDrawing(ctx.res, `build-${j.id}`, drawn(() => pipelineToDrawing(pipeline, { name: `Build ${j.id}`, results, job: { id: j.id, status: view.status } })));
  });

  // A function. A chain is drawn as the functions it calls; any other function as a single box.
  router.get('/api/v1/functions/:owner/:name/topoforge', (ctx) => {
    const a = verified(ctx);
    const fn = functions.view(functions.get(a.user, parseOwner(ctx.params.owner), ctx.params.name));
    const chain = fn.chain?.length ? fn.chain : [fn.name];
    sendDrawing(ctx.res, `function-${fn.name}`, drawn(() => chainToDrawing(fn.name, chain, { owner: fn.owner })));
  });

  // The whole instance. It lists every site and runner, so it is for administrators and staff only.
  router.get('/api/v1/topoforge/system', (ctx) => {
    const a = verified(ctx);
    if (!isStaff(a.user)) throw new HttpError(403, 'staff_only', 'Only administrators and staff can draw the whole instance.');
    sendDrawing(ctx.res, 'gitcha-instance', systemToDrawing(systemSnapshot({ ...services, version: services.version }, a.user)));
  });

  // Read a drawing the way a build or a chain function would, and answer what Gitcha would run.
  // Nothing is stored and nothing runs: it is a check, before a drawing is pushed or uploaded.
  router.post('/api/v1/topoforge/import', async (ctx) => {
    verified(ctx);
    const body = await readJson(ctx.req, 2 * 1024 * 1024);
    const as = body.as ?? 'pipeline';
    if (as === 'pipeline') {
      json(ctx.res, 200, { pipeline: normalizePipeline(pipelineFromTopoForge(body.drawing), { maxTimeoutMs: config.compute.maxJobMs, defaultImage: config.compute.defaultImage }) });
    } else if (as === 'chain') {
      json(ctx.res, 200, { chain: chainFromTopoForge(body.drawing) });
    } else {
      throw new HttpError(400, 'bad_request', '"as" is "pipeline" or "chain".');
    }
  });
}
