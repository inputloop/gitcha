// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// JSON API for sites, custom domains and the ring.
import crypto from 'node:crypto';
import { json, send, readJson, redirect } from '../http.js';
import { HttpError } from '../errors.js';
import { makeGuards } from '../api.js';
import { RateLimiter } from '../auth.js';
import { RING_PATH } from './ring.js';

export function registerHostingApi(router, { auth, sites, domains, ring, config }) {
  const { verified } = makeGuards(auth, config);
  const announceLimiter = new RateLimiter({ max: 5, windowMs: 3600_000, clock: auth.clock });
  domains.startRecheck(); // verified domains are looked at again on a schedule (DOM-2)
  const siteView = (s, user) => ({ ...sites.view(s, user), domains: domains.forSite(s) });

  router.get('/api/v1/sites', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, { sites: sites.listFor(a.user), hosting_domains: config.hosting.domains });
  });

  router.post('/api/v1/sites', async (ctx) => {
    const a = verified(ctx);
    const { name, team, description } = await readJson(ctx.req);
    json(ctx.res, 201, siteView(sites.create(a.user, { name, team, description }, ctx.ip), a.user));
  });

  router.get('/api/v1/sites/:site', (ctx) => {
    const a = verified(ctx);
    const s = sites.get(ctx.params.site);
    if (!sites.canSee(a.user, s)) throw new HttpError(404, 'site_not_found', `No site named "${ctx.params.site}".`);
    json(ctx.res, 200, siteView(s, a.user));
  });

  // Deploying changes what the world sees: same fresh-code rule as publishing.
  router.put('/api/v1/sites/:site/deploys', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req, Math.ceil(config.hosting.maxSiteBytes * 1.4) + 4096);
    const tarball = Buffer.from(String(body.tarball ?? ''), 'base64');
    if (body.integrity && body.integrity !== `sha256-${crypto.createHash('sha256').update(tarball).digest('hex')}`) {
      throw new HttpError(400, 'integrity_mismatch', 'Tarball checksum does not match: upload corrupted?');
    }
    json(ctx.res, 201, sites.deploy(a.user, ctx.params.site, { tarball, activate: body.activate !== false }, ctx.ip));
  });

  router.post('/api/v1/sites/:site/deploys/:id/activate', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, sites.activate(a.user, ctx.params.site, ctx.params.id, ctx.ip));
  });

  router.delete('/api/v1/sites/:site', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, sites.remove(a.user, ctx.params.site, ctx.ip));
  });

  router.post('/api/v1/sites/:site/domains', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { hostname } = await readJson(ctx.req);
    json(ctx.res, 201, domains.add(a.user, ctx.params.site, hostname, ctx.ip));
  });

  router.post('/api/v1/sites/:site/domains/:host/verify', async (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, await domains.verify(a.user, ctx.params.site, ctx.params.host, ctx.ip));
  });

  router.delete('/api/v1/sites/:site/domains/:host', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, domains.remove(a.user, ctx.params.site, ctx.params.host, ctx.ip));
  });

  // For a TLS proxy with on-demand certificates (Caddy "ask"): 200 = allowed.
  router.get('/api/v1/hosting/tls-allowed', (ctx) => {
    const ok = domains.tlsAllowed(ctx.url.searchParams.get('domain'));
    json(ctx.res, ok ? 200 : 404, { allowed: ok });
  });

  // ---- the ring -----------------------------------------------------------------
  router.get(RING_PATH, (ctx) => send(ctx.res, 200, JSON.stringify(ring.manifest(), null, 2), {
    'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600',
  }));
  router.get('/ring/next', (ctx) => redirect(ctx.res, ring.neighbour(1)));
  router.get('/ring/prev', (ctx) => redirect(ctx.res, ring.neighbour(-1)));
  router.get('/ring/random', (ctx) => redirect(ctx.res, ring.random()));
  router.get('/api/v1/ring', (ctx) => json(ctx.res, 200, { self: ring.manifest(), members: ring.members() }));

  router.post('/api/v1/ring/announce', async (ctx) => {
    if (!announceLimiter.hit(`ring:${ctx.ip}`)) throw new HttpError(429, 'rate_limited', 'Too many ring requests from this address.');
    const { url } = await readJson(ctx.req);
    json(ctx.res, 202, await ring.announce(url, ctx.ip));
  });

  router.get('/api/v1/ring/pending', (ctx) => {
    const a = verified(ctx);
    if (a.user.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only an administrator can manage the ring.');
    json(ctx.res, 200, { pending: ring.pending() });
  });

  router.post('/api/v1/ring/decide', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { url, approve } = await readJson(ctx.req);
    json(ctx.res, 200, ring.decide(a.user, url, Boolean(approve), ctx.ip));
  });
}

/**
 * Serve a hosted site. Returns true when the Host belongs to hosting, so the
 * request never falls through to the Gitcha UI or API.
 */
export async function serveHosted(ctx, { sites, functions }) {
  const host = ctx.req.headers.host;
  if (!sites.isHostingHost(host)) return false;
  const { req, res, url } = ctx;
  const site = sites.siteForHost(host);
  const plain = (status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  if (!site) return plain(404, 'No site is published at this address.\n'), true;
  const fn = sites.routeFor(site, url.pathname);
  if (fn) {
    if (!functions) return plain(503, 'Functions are not enabled on this instance.\n'), true;
    await functions.invokeHttp(ctx, { site, name: fn });
    return true;
  }
  if (!['GET', 'HEAD'].includes(req.method)) return plain(405, 'Method not allowed.\n'), true;
  const file = sites.resolveFile(site, url.pathname);
  if (file) return sites.sendFile(res, site, file, 200, req.method), true;
  const nf = sites.notFoundFile(site);
  if (nf) return sites.sendFile(res, site, nf, 404, req.method), true;
  return plain(404, site.activeDeploy ? 'Not found.\n' : 'This site has no deploy yet.\n'), true;
}
