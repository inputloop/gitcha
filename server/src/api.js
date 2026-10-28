// JSON API used by the gitcha CLI and the Claude extension (/api/v1/*).
import { json, send, readJson } from './http.js';
import { HttpError } from './errors.js';

export const API_VERSION = '1';

function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

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

export function registerApi(router, { auth: authSvc, packages, config, version }) {
  const authed = (ctx) => {
    const a = authSvc.authenticate(bearer(ctx.req), ctx.ip);
    if (!a) throw new HttpError(401, 'unauthenticated', 'Not logged in. Run `gitcha login` first.');
    return a;
  };
  /** Logged in + intermittent 2FA satisfied (+ fresh code for sensitive actions). */
  const verified = (ctx, { sensitive = false } = {}) => {
    const a = authed(ctx);
    authSvc.requireMfa(a, sensitive ? { fresh: config.policy.sensitiveWindow } : {});
    return a;
  };
  const reader = (ctx) => (config.publicRead && !bearer(ctx.req) ? null : verified(ctx));

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
  router.post('/api/v1/auth/login', async (ctx) => {
    const { username, password } = await readJson(ctx.req);
    const { ticket } = authSvc.beginLogin({ username, password, ip: ctx.ip });
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

  router.put('/api/v1/security', async (ctx) => {
    const a = authed(ctx);
    authSvc.requireFreshMfa(a); // toggling checks always needs a fresh code
    const { checks } = await readJson(ctx.req);
    json(ctx.res, 200, { checks: authSvc.updateCheckSettings(a.user, checks, ctx.ip) });
  });

  // ---- packages -------------------------------------------------------------
  router.get('/api/v1/packages', (ctx) => {
    reader(ctx);
    json(ctx.res, 200, { packages: packages.search(ctx.url.searchParams.get('q') ?? '') });
  });

  router.get('/api/v1/packages/:name', (ctx) => {
    reader(ctx);
    json(ctx.res, 200, packages.info(ctx.params.name));
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
    const body = await readJson(ctx.req, Math.ceil(config.maxPackageBytes * 1.4) + 4096);
    const tarball = Buffer.from(String(body.tarball ?? ''), 'base64');
    json(ctx.res, 201, packages.publish(a.user, { tarball, integrity: body.integrity }, ctx.ip));
  });

  router.post('/api/v1/packages/:name/:version/yank', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const { yanked = true } = await readJson(ctx.req);
    json(ctx.res, 200, packages.yank(a.user, ctx.params.name, ctx.params.version, Boolean(yanked), ctx.ip));
  });
}
