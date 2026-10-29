// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Builds the whole server: it creates every service (accounts, packages, teams, hosting, CI,
// billing, social, git and more), connects them, registers their web routes, and returns an
// HTTP server that is ready to listen. index.js calls createApp; tests call it too.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, json, html, send, parseCookies, clientIp, requestUrl } from './http.js';
import { HttpError } from './errors.js';
import { Store } from './store.js';
import { AuthService } from './auth.js';
import { PackageService } from './packages.js';
import { TeamService } from './teams.js';
import { SiteService } from './hosting/sites.js';
import { DomainService } from './hosting/domains.js';
import { RingService } from './hosting/ring.js';
import { registerHostingApi, serveHosted } from './hosting/api.js';
import { JobService } from './compute/jobs.js';
import { CiService } from './compute/ci.js';
import { FunctionService } from './compute/functions.js';
import { registerComputeApi } from './compute/api.js';
import { BillingService } from './billing/billing.js';
import { registerBillingApi } from './billing/api.js';
import { KeyService } from './social/keys.js';
import { AgentService } from './social/agents.js';
import { BudgetService } from './social/budgets.js';
import { SocialService } from './social/social.js';
import { TaskService } from './social/tasks.js';
import { NextTimeClient } from './social/nexttime.js';
import { makePrincipals } from './social/principal.js';
import { makeGraphql } from './social/graphql.js';
import { registerSocialApi } from './social/api.js';
import { registerSocialWeb } from './social/web.js';
import { ProjectService } from './git/projects.js';
import { registerGit } from './git/http.js';
import { OpsService } from './ops/ops.js';
import { registerApi } from './api.js';
import { registerWeb } from './web.js';
import { layout, errorPage } from './views.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
// The only file types served from the public/ folder, and the Content-Type sent for each.
const MIME = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Create the app from a loaded config (see config.js). Tests may pass a fake `clock`, a fake DNS
 * `resolver` and a fake `fetchImpl` so no real time, DNS or network is used.
 * Returns the HTTP server, every service, the router and the version.
 */
export function createApp(config, { clock = Date.now, resolver, fetchImpl } = {}) {
  const store = new Store(config.dataDir);
  const auth = new AuthService({ store, config, clock });
  const teams = new TeamService({ store, clock });
  const packages = new PackageService({ store, config, teams, clock });
  const router = new Router();
  const sites = new SiteService({ store, config, teams, clock });
  const domains = new DomainService({ store, config, sites, clock, ...(resolver ? { resolver } : {}) });
  const services = { store, auth, packages, teams, sites, domains, config };
  services.billing = new BillingService({ store, config, teams, clock, ...(fetchImpl ? { fetchImpl } : {}) });
  sites.billing = services.billing;
  services.agents = new AgentService({ store, clock });
  services.budgets = new BudgetService({ store, config, clock });
  services.keys = new KeyService({ store, auth, billing: services.billing, budgets: services.budgets, clock });
  services.principals = makePrincipals(services);
  services.projects = new ProjectService({ ...services, clock });
  services.nexttime = new NextTimeClient({ ...config.nexttime, ...(fetchImpl ? { fetchImpl } : {}) });
  services.tasks = new TaskService({ ...services, clock });
  services.social = new SocialService({ ...services, clock });
  // Services are created in order, because later ones use earlier ones (for example, packages need teams).
  // Agents' work shows up in their feeds, so people can watch them.
  services.projects.onPushed = (p, push) => {
    if (p.visibility !== 'public') return; // private work never reaches a public feed
    for (const h of push.agents) {
      const n = push.commits.filter((c) => c.agent === h).length;
      services.social.activity(h, { title: `Pushed ${n} commit${n === 1 ? '' : 's'} to ${services.projects.key(p.owner, p.name)}`, body: push.commits.filter((c) => c.agent === h).slice(0, 10).map((c) => `- \`${c.sha.slice(0, 10)}\` ${c.subject}${c.verified ? ' (signed)' : ''}`).join('\n'), tags: ['activity', ...p.tags], refs: { project: services.projects.key(p.owner, p.name) } });
    }
  };
  // A finished Second Reader review of a public project is posted to the reviewer's feed.
  services.tasks.onReviewed = (t) => {
    if (services.tasks.project(t)?.visibility !== 'public') return;
    services.social.activity(t.claimant.handle, { title: `Second Reader review of ${t.project}: ${t.review.verdict.replace('_', ' ')}`, body: `${t.review.summary}\n\n${t.review.findings.length} finding(s). Task: ${services.tasks.url(t)}`, tags: ['second-reader', 'review'], refs: { task: t.id, project: t.project } });
  };
  services.jobs = new JobService({ store, config, teams, clock });
  services.ci = new CiService({ ...services, clock });
  services.functions = new FunctionService({ ...services, clock });
  const ring = new RingService({
    store, config, version: VERSION, clock, ...(fetchImpl ? { fetchImpl } : {}),
    features: () => ({ packages: true, teams: true, hosting: config.hosting.domains.length > 0, ci: Boolean(services.jobs), functions: Boolean(services.functions), paid: services.billing?.paidFeatures() ?? [] }),
  });
  services.ring = ring;
  // Each module adds its own routes to the shared router.
  registerApi(router, { auth, packages, teams, config, version: VERSION, hooks: { onPublish: (...a) => services.ci.onPublish(...a) } });
  registerHostingApi(router, services);
  registerComputeApi(router, services);
  registerBillingApi(router, services);
  registerGit(router, services);
  services.ops = new OpsService({ ...services, clock });
  services.graphql = makeGraphql(services);
  registerSocialApi(router, services);
  services.web = registerWeb(router, { auth, packages, teams, config, billing: services.billing });
  registerSocialWeb(router, services);

  // Static files (CSS, images). path.basename strips any folder part, so a request cannot reach
  // files outside public/, and only the types listed in MIME are served.
  router.get('/static/:file', (ctx) => {
    const file = path.basename(ctx.params.file);
    const full = path.join(PUBLIC, file);
    if (!MIME[path.extname(file)] || !fs.existsSync(full)) throw new HttpError(404, 'not_found', 'Not found.');
    send(ctx.res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'public, max-age=3600' });
  });

  // Handle one request: build the request context, try hosted sites first, then find the
  // matching route and run it. Any error becomes a JSON reply (for /api/) or an HTML error page.
  async function handle(req, res) {
    let isApi = String(req.url ?? '').startsWith('/api/');
    try {
      // Everything a stranger controls is read inside the try. So a bad request gets a 400 reply and never crashes the process.
      const url = requestUrl(req);
      isApi = url.pathname.startsWith('/api/');
      const ctx = {
        req, res, url, ip: clientIp(req, config.trustProxy, config.trustedProxies), cookies: parseCookies(req.headers.cookie), params: {}, outCookies: [],
      };
      // Handlers queue cookies with setCookie. The wrapped writeHead adds them to the reply headers.
      ctx.setCookie = (c) => ctx.outCookies.push(c);
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (status, headers = {}) => {
        if (ctx.outCookies.length && !headers['Set-Cookie']) headers = { ...headers, 'Set-Cookie': ctx.outCookies };
        return writeHead(status, headers);
      };
      // Hosted sites are served on their own hostnames and never reach the UI or API.
      if (await serveHosted(ctx, services)) return;
      // Cross-site browser requests to the JSON API are refused outright. The browser sets the
      // Sec-Fetch-Site header; this blocks CSRF (a trick where another site makes your browser send a request).
      if (isApi && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not_found', 'Not found.');
      ctx.params = m.params;
      await m.handler(ctx);
    } catch (err) {
      // If part of the reply was already sent, we cannot send an error page, so cut the connection.
      if (res.headersSent) return res.destroy();
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Something went wrong.');
      // Unexpected errors are logged, and the visitor sees only a plain 500 with no internal details.
      if (!(err instanceof HttpError)) console.error(err);
      if (isApi) json(res, e.status, { error: e.code, message: e.message, ...e.extra });
      else html(res, e.status, layout({ title: String(e.status), body: errorPage({ status: e.status, message: e.message }) }));
    }
  }

  // A second safety net: even if the catch above fails, the request ends and the process stays up.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => { console.error(err); res.destroy(); });
  });
  // Every 30 seconds, mark running jobs past their deadline as timed out, and remove expired sign-ups
  // and sessions. unref() means this
  // timer alone does not keep the process running.
  const sweeper = setInterval(() => { services.jobs.sweep(); auth.sweep(); }, 30_000);
  sweeper.unref();
  // When the server closes, stop the timer, answer any waiting runner requests with nothing, and
  // release the data folder lock.
  server.on('close', () => { clearInterval(sweeper); services.jobs.cancelWaiters(); store.close(); });
  return { server, ...services, router, version: VERSION };
}
