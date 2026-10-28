// Browser-facing pages: registration, 2FA enrollment, sign-in, step-up,
// package browsing and the account security page.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { html, redirect, readForm, cookie } from './http.js';
import { HttpError } from './errors.js';
import { safeEqual } from './crypto.js';
import * as V from './views.js';

const SID = 'gitcha_sid';
const ENROLL = 'gitcha_enroll';
const TICKET = 'gitcha_ticket';
const CSRF = 'gitcha_csrf';

const NOTICES = {
  activated: 'Your account is active. Sign in with your password and authenticator code.',
  signed_out: 'You have been signed out.',
  checks_saved: 'Two-factor check settings saved.',
  revoked: 'Device signed out.',
};
const REASONS = {
  interval: 'It has been a while since you last confirmed it was you.',
  new_network: 'You are connecting from a new network.',
  sensitive_action: 'This is a sensitive action and needs a fresh code.',
};

/** Only allow same-site relative redirects. */
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/packages');

export function registerWeb(router, { auth, packages, config }) {
  const secure = config.secureCookies;

  const csrfToken = (ctx) => {
    let t = ctx.cookies[CSRF];
    if (!t || t.length < 20) {
      t = crypto.randomBytes(24).toString('base64url');
      ctx.setCookie(cookie(CSRF, t, { secure, maxAge: 86400_000 }));
      ctx.cookies[CSRF] = t;
    }
    return t;
  };

  const form = async (ctx) => {
    const f = await readForm(ctx.req);
    if (!ctx.cookies[CSRF] || !safeEqual(f._csrf ?? '', ctx.cookies[CSRF])) {
      throw new HttpError(403, 'csrf', 'Your form expired. Go back, reload the page and try again.');
    }
    return f;
  };

  const current = (ctx) => auth.authenticate(ctx.cookies[SID], ctx.ip);

  const page = (ctx, title, body, { status = 200, user, wide } = {}) =>
    html(ctx.res, status, V.layout({ title, body, user: user ?? current(ctx)?.user, csrf: csrfToken(ctx), wide }));

  /** Logged in with 2FA satisfied, else redirect to sign-in / step-up. */
  const requireWeb = (ctx, opts) => {
    const a = current(ctx);
    if (!a) { redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`); return null; }
    const state = auth.mfaState(a, opts);
    if (!state.ok) { redirect(ctx.res, `/verify?reason=${state.reason}&next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`); return null; }
    return a;
  };

  /** For POSTs needing a fresh code: send through /verify, then back to `back`. */
  const requireFresh = (ctx, a, back, force = false) => {
    const age = auth.clock() - (a.session.mfaAt ?? 0);
    const needs = force || auth.checkSettings(a.user).sensitive;
    if (needs && age > config.policy.sensitiveWindow) {
      redirect(ctx.res, `/verify?reason=sensitive_action&next=${encodeURIComponent(back)}`);
      return false;
    }
    return true;
  };

  router.get('/', (ctx) => (current(ctx) ? redirect(ctx.res, '/packages') : page(ctx, 'Free software registry', V.landing(), { wide: true })));

  // ---- registration + mandatory 2FA enrollment -----------------------------
  router.get('/register', (ctx) => page(ctx, 'Create account', V.registerPage({ csrf: csrfToken(ctx) })));

  router.post('/register', async (ctx) => {
    const f = await form(ctx);
    try {
      if (f.password !== f.confirm) throw new HttpError(400, 'mismatch', 'The passwords do not match.');
      const { enrollToken } = auth.register({ username: f.username, password: f.password, ip: ctx.ip });
      redirect(ctx.res, '/setup-2fa', { 'Set-Cookie': [...ctx.outCookies, cookie(ENROLL, enrollToken, { secure, maxAge: 30 * 60_000 })] });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      page(ctx, 'Create account', V.registerPage({ csrf: csrfToken(ctx), error: err.message, username: f.username }), { status: err.status });
    }
  });

  const enrollView = async (ctx, error, status = 200) => {
    const e = auth.enrollmentFor(ctx.cookies[ENROLL]);
    if (!e) return redirect(ctx.res, '/register');
    const qrSvg = await QRCode.toString(e.otpauth, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } });
    page(ctx, 'Set up two-factor', V.setup2faPage({ csrf: csrfToken(ctx), error, qrSvg, secret: e.secret, username: e.user.username, issuer: config.issuer }), { status });
  };

  router.get('/setup-2fa', (ctx) => enrollView(ctx));

  router.post('/setup-2fa', async (ctx) => {
    const f = await form(ctx);
    try {
      const { recoveryCodes } = auth.confirmEnrollment({ enrollToken: ctx.cookies[ENROLL], code: String(f.code ?? '').replace(/\s/g, ''), ip: ctx.ip });
      ctx.setCookie(cookie(ENROLL, '', { secure, maxAge: 0 }));
      page(ctx, 'Recovery codes', V.recoveryCodesPage({ codes: recoveryCodes }));
    } catch (err) {
      if (!(err instanceof HttpError) || err.code === 'enrollment_expired') throw err;
      await enrollView(ctx, err.message, err.status);
    }
  });

  // ---- sign in: password, then authenticator code ---------------------------
  router.get('/login', (ctx) => {
    if (current(ctx)) return redirect(ctx.res, safeNext(ctx.url.searchParams.get('next')));
    page(ctx, 'Sign in', V.loginPage({ csrf: csrfToken(ctx), notice: NOTICES[ctx.url.searchParams.get('msg')], next: ctx.url.searchParams.get('next') ?? '' }));
  });

  router.post('/login', async (ctx) => {
    const f = await form(ctx);
    try {
      const { ticket } = auth.beginLogin({ username: f.username, password: f.password, ip: ctx.ip });
      redirect(ctx.res, `/login/2fa?next=${encodeURIComponent(safeNext(f.next))}`, {
        'Set-Cookie': [...ctx.outCookies, cookie(TICKET, ticket, { secure, maxAge: config.policy.mfaTicketTtl })],
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      page(ctx, 'Sign in', V.loginPage({ csrf: csrfToken(ctx), error: err.message, username: f.username, next: f.next }), { status: err.status });
    }
  });

  const loginCodeView = (ctx, { error, next, status = 200 }) => page(ctx, 'Two-factor', V.codePage({
    csrf: csrfToken(ctx), error, next, action: '/login/2fa', title: 'Two-factor authentication',
    message: 'Open your authenticator app and enter the 6-digit code for Gitcha.',
  }), { status });

  router.get('/login/2fa', (ctx) => {
    if (!ctx.cookies[TICKET]) return redirect(ctx.res, '/login');
    loginCodeView(ctx, { next: ctx.url.searchParams.get('next') ?? '' });
  });

  router.post('/login/2fa', async (ctx) => {
    const f = await form(ctx);
    try {
      const { token } = auth.completeLogin({
        ticket: ctx.cookies[TICKET], code: f.code, kind: 'web', name: browserName(ctx.req.headers['user-agent']),
        ip: ctx.ip, userAgent: ctx.req.headers['user-agent'],
      });
      redirect(ctx.res, safeNext(f.next), {
        'Set-Cookie': [...ctx.outCookies, cookie(TICKET, '', { secure, maxAge: 0 }), cookie(SID, token, { secure, maxAge: config.policy.sessionMaxAge })],
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.code === 'ticket_expired') return page(ctx, 'Sign in', V.loginPage({ csrf: csrfToken(ctx), error: err.message }), { status: 401 });
      loginCodeView(ctx, { error: err.message, next: f.next, status: err.status });
    }
  });

  // ---- intermittent step-up -------------------------------------------------
  const verifyView = (ctx, { error, next, reason, status = 200 }) => page(ctx, 'Confirm it is you', V.codePage({
    csrf: csrfToken(ctx), error, next, reason: REASONS[reason], action: '/verify', title: 'Confirm it’s you',
    message: 'Enter the current code from your authenticator app to continue.',
  }), { status });

  router.get('/verify', (ctx) => {
    if (!current(ctx)) return redirect(ctx.res, '/login');
    verifyView(ctx, { next: ctx.url.searchParams.get('next') ?? '', reason: ctx.url.searchParams.get('reason') });
  });

  router.post('/verify', async (ctx) => {
    const f = await form(ctx);
    const a = current(ctx);
    if (!a) return redirect(ctx.res, '/login');
    try {
      auth.stepUp(a, f.code, ctx.ip);
      // A POST target can't be replayed by redirect, so land on its page instead.
      redirect(ctx.res, safeNext(f.next).replace(/\/(checks|recovery-codes|sessions\/[^/]+\/revoke)$/, ''));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      verifyView(ctx, { error: err.message, next: f.next, status: err.status });
    }
  });

  router.post('/logout', async (ctx) => {
    await form(ctx);
    const a = current(ctx);
    if (a) auth.revoke(a.hash, a.user.username, ctx.ip);
    redirect(ctx.res, '/login?msg=signed_out', { 'Set-Cookie': [...ctx.outCookies, cookie(SID, '', { secure, maxAge: 0 })] });
  });

  // ---- packages -----------------------------------------------------------
  router.get('/packages', (ctx) => {
    const a = config.publicRead ? current(ctx) : requireWeb(ctx);
    if (!a && !config.publicRead) return;
    const q = ctx.url.searchParams.get('q') ?? '';
    page(ctx, 'Packages', V.packagesPage({ q, results: packages.search(q) }), { user: a?.user, wide: true });
  });

  router.get('/packages/:name', (ctx) => {
    const a = config.publicRead ? current(ctx) : requireWeb(ctx);
    if (!a && !config.publicRead) return;
    const pkg = packages.info(ctx.params.name);
    page(ctx, pkg.name, V.packagePage({ pkg, serverUrl: config.publicUrl }), { user: a?.user, wide: true });
  });

  // ---- account security -----------------------------------------------------
  const accountView = (ctx, a, { notice, error, status = 200 } = {}) => {
    const sessions = auth.store.sessionsForUser(a.user.id).filter((s) => s.kind !== 'enroll').sort((x, y) => y.lastSeen - x.lastSeen);
    const state = auth.mfaState(a);
    page(ctx, 'Account', V.accountPage({
      csrf: csrfToken(ctx), user: a.user, checks: auth.checkSettings(a.user), sessions, currentHash: a.hash,
      audit: auth.store.auditFor(a.user.id, 15), notice, error, recoveryLeft: a.user.recoveryCodes.length,
      mfaState: { verifiedAt: a.session.mfaAt, nextCheckAt: state.nextCheckAt },
    }), { user: a.user, status, wide: true });
  };

  router.get('/account', (ctx) => {
    const a = requireWeb(ctx);
    if (a) accountView(ctx, a, { notice: NOTICES[ctx.url.searchParams.get('msg')] });
  });

  router.post('/account/checks', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/account/checks', true)) return;
    try {
      auth.updateCheckSettings(a.user, { interval: f.interval === 'on', new_network: f.new_network === 'on', sensitive: f.sensitive === 'on' }, ctx.ip);
      redirect(ctx.res, '/account?msg=checks_saved');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      accountView(ctx, a, { error: err.message, status: err.status });
    }
  });

  router.post('/account/recovery-codes', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/account/recovery-codes', true)) return;
    page(ctx, 'Recovery codes', V.recoveryCodesPage({ codes: auth.regenerateRecoveryCodes(a.user, ctx.ip), fresh: false }), { user: a.user });
  });

  router.post('/account/sessions/:id/revoke', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, `/account/sessions/${ctx.params.id}/revoke`)) return;
    const target = auth.store.sessionsForUser(a.user.id).find((s) => s.hash.startsWith(ctx.params.id) && ctx.params.id.length === 16);
    if (target) auth.revoke(target.hash, a.user.username, ctx.ip);
    redirect(ctx.res, '/account?msg=revoked');
  });
}

function browserName(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

