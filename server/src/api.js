// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The JSON API under /api/v1/ used by the gitcha command-line tool and the Claude extension. It covers
// login, the 2FA check settings, packages and teams. Each route checks who is calling (see makeGuards),
// reads the JSON body, calls a service (auth.js, packages.js, teams.js) and sends back JSON.
import { json, send, readJson } from './http.js';
import { HttpError } from './errors.js';

export const API_VERSION = '1'; // reported by /api/v1/health

/** The token from an "Authorization: Bearer <token>" header, or null. */
function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** What whoami reports: the user, this device, and the state of its 2FA checks. */
function sessionView(auth, state) {
  return {
    user: { username: auth.user.username, role: auth.user.role },
    device: { name: auth.session.name, kind: auth.session.kind, created_at: auth.session.createdAt },
    mfa: {
      verified_at: auth.session.mfaAt,
      ok: state.ok,
      reason: state.ok ? null : state.reason,
      next_check_at: state.nextCheckAt ?? null,
    },
  };
}

/**
 * Request guards shared by every API module. Each one throws an error if the caller may not go on.
 * authed: has a valid token. verified: also passed the 2FA checks. reader: like verified, but anyone
 * may read without a token when the server allows public reading (GITCHA_PUBLIC_READ).
 */
export function makeGuards(authSvc, config) {
  const authed = (ctx) => {
    const a = authSvc.authenticate(bearer(ctx.req), ctx.ip);
    if (!a) throw new HttpError(401, 'unauthenticated', 'Not logged in. Run `gitcha login` first.');
    return a;
  };
  /** Logged in, and the intermittent 2FA check passed (plus a recent code for sensitive actions). */
  const verified = (ctx, { sensitive = false } = {}) => {
    const a = authed(ctx);
    authSvc.requireMfa(a, sensitive ? { fresh: config.policy.sensitiveWindow } : {});
    return a;
  };
  const reader = (ctx) => (config.publicRead && !bearer(ctx.req) ? null : verified(ctx));
  return { authed, verified, reader, bearer };
}

/** Add the core API routes to the router. `hooks.onPublish` lets CI start a build when a package is published. */
export function registerApi(router, { auth: authSvc, packages, teams, config, version, hooks = {} }) {
  const { authed, verified, reader } = makeGuards(authSvc, config);

  // Public status: the version, whether sign-up is open, and the 2FA policy. Needs no login.
  router.get('/api/v1/health', (ctx) => json(ctx.res, 200, {
    ok: true, service: 'gitcha', version, api: API_VERSION,
    registration: config.openRegistration ? 'open' : 'closed',
    public_read: config.publicRead,
    policy: {
      step_up_interval_ms: config.policy.stepUpInterval,
      sensitive_window_ms: config.policy.sensitiveWindow,
      locked_checks: config.policy.lockedChecks,
    },
  }));

  // ---- authentication ------------------------------------------------------
  // Login is two steps: the password gives a ticket, then the ticket and a 2FA code give a device token.
  router.post('/api/v1/auth/login', async (ctx) => {
    const { username, password } = await readJson(ctx.req);
    const { ticket } = await authSvc.beginLogin({ username, password, ip: ctx.ip });
    json(ctx.res, 200, { mfa_ticket: ticket, expires_in_ms: config.policy.mfaTicketTtl, next: 'POST /api/v1/auth/login/mfa' });
  });

  router.post('/api/v1/auth/login/mfa', async (ctx) => {
    const { ticket, code, device_name } = await readJson(ctx.req);
    const { token, session, user } = authSvc.completeLogin({
      ticket, code, kind: 'device', name: device_name, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'],
    });
    json(ctx.res, 200, {
      token, username: user.username, device: session.name,
      next_check_at: authSvc.checkSettings(user).interval ? session.mfaAt + config.policy.stepUpInterval : null,
    });
  });

  // Send a fresh 2FA code for this device when the server asks for one.
  router.post('/api/v1/auth/step-up', async (ctx) => {
    const a = authed(ctx);
    const { code } = await readJson(ctx.req);
    const r = authSvc.stepUp(a, code, ctx.ip);
    json(ctx.res, 200, { ok: true, method: r.method, next_check_at: authSvc.mfaState(a).nextCheckAt ?? null });
  });

  router.get('/api/v1/auth/whoami', (ctx) => {
    const a = authed(ctx);
    json(ctx.res, 200, sessionView(a, authSvc.mfaState(a)));
  });

  router.post('/api/v1/auth/logout', (ctx) => {
    const a = authed(ctx);
    authSvc.revoke(a.hash, a.user.username, ctx.ip);
    json(ctx.res, 200, { ok: true });
  });

  // ---- 2FA check toggles -----------------------------------------------------
  router.get('/api/v1/security', (ctx) => {
    const a = authed(ctx);
    json(ctx.res, 200, { checks: authSvc.checkSettings(a.user) });
  });

  // Changing the checks needs a code sent in this request (single use), on top of the interval and new-network checks.
  router.put('/api/v1/security', async (ctx) => {
    const a = verified(ctx);
    const { checks, code } = await readJson(ctx.req);
    json(ctx.res, 200, { checks: authSvc.changeChecks(a, { changes: checks, code }, ctx.ip) });
  });

  // ---- packages -------------------------------------------------------------
  // Reading uses `reader`. Publishing, yanking, transferring and changing visibility are sensitive, so they
  // need a recent 2FA code.
  router.get('/api/v1/packages', (ctx) => {
    const a = reader(ctx);
    const q = ctx.url.searchParams;
    json(ctx.res, 200, { packages: packages.search(q.get('q') ?? '', a?.user, { team: q.get('team') || undefined }) });
  });

  router.get('/api/v1/packages/:name', (ctx) => {
    const a = reader(ctx);
    json(ctx.res, 200, packages.info(ctx.params.name, a?.user));
  });

  router.get('/api/v1/packages/:name/:version/tarball', (ctx) => {
    const a = reader(ctx);
    const { rec, data } = packages.download(ctx.params.name, ctx.params.version, a?.user, ctx.ip);
    send(ctx.res, 200, data, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${ctx.params.name}-${rec.version}.tgz"`,
      'X-Gitcha-Integrity': rec.integrity,
      'X-Gitcha-Version': rec.version,
    });
  });

  router.put('/api/v1/packages', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    // The tarball arrives as base64, which is about 4/3 the size of the bytes, so the body limit is 1.4 times
    // the package limit plus room for the other fields.
    const body = await readJson(ctx.req, Math.ceil(config.maxPackageBytes * 1.4) + 4096);
    const tarball = Buffer.from(String(body.tarball ?? ''), 'base64');
    const priv = typeof body.private === 'boolean' ? body.private : undefined;
    const published = packages.publish(a.user, { tarball, integrity: body.integrity, team: body.team || undefined, private: priv }, ctx.ip);
    // A pipeline marked "on": ["publish"] builds the new version on a runner.
    const build = hooks.onPublish?.(a.user, published, tarball, ctx.ip) ?? null;
    json(ctx.res, 201, build ? { ...published, build: { id: build.id, status: build.status } } : published);
  });

  router.post('/api/v1/packages/:name/:version/yank', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { yanked = true } = await readJson(ctx.req);
    json(ctx.res, 200, packages.yank(a.user, ctx.params.name, ctx.params.version, Boolean(yanked), ctx.ip));
  });

  router.post('/api/v1/packages/:name/transfer', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { team } = await readJson(ctx.req);
    json(ctx.res, 200, packages.transfer(a.user, ctx.params.name, team, ctx.ip));
  });

  router.post('/api/v1/packages/:name/visibility', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req);
    json(ctx.res, 200, packages.setVisibility(a.user, ctx.params.name, Boolean(body.private), ctx.ip));
  });

  // ---- teams --------------------------------------------------------------------
  // Changing members or deleting a team is sensitive and needs a recent 2FA code.
  router.get('/api/v1/teams', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, { teams: teams.forUser(a.user) });
  });

  router.post('/api/v1/teams', async (ctx) => {
    const a = verified(ctx);
    const { name, description } = await readJson(ctx.req);
    const team = teams.create(a.user, { name, description }, ctx.ip);
    json(ctx.res, 201, teams.view(team, a.user));
  });

  router.get('/api/v1/teams/:team', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, teams.view(teams.get(ctx.params.team), a.user));
  });

  router.put('/api/v1/teams/:team/members/:username', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { role = 'member', code } = await readJson(ctx.req);
    // Naming an owner hands over the whole team: it takes a code of its own, not just the open window.
    if (role === 'owner') authSvc.confirmAction(a, code, ctx.ip, 'Making someone an owner');
    json(ctx.res, 200, teams.setMember(a.user, ctx.params.team, ctx.params.username, role, ctx.ip));
  });

  router.delete('/api/v1/teams/:team/members/:username', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, teams.removeMember(a.user, ctx.params.team, ctx.params.username, ctx.ip));
  });

  router.delete('/api/v1/teams/:team', (ctx) => {
    const a = verified(ctx, { sensitive: true });
    json(ctx.res, 200, teams.delete(a.user, ctx.params.team, ctx.ip));
  });
}
