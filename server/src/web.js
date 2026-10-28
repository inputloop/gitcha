// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
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
  email_saved: 'Email saved.',
  revoked: 'Device signed out.',
  team_created: 'Team created. Add members below.',
  member_saved: 'Team member saved.',
  member_removed: 'Member removed.',
  left: 'You left the team.',
  team_deleted: 'Team deleted.',
  transferred: 'Package moved to the team.',
  visibility: 'Package visibility updated.',
  confirm_again: 'Verified. Please submit your change again.',
  cancelled: 'Checkout was cancelled; nothing was charged.',
  subscribed: 'Thank you: your subscription is active.',
  sub_cancelled: 'Your subscription has been cancelled.',
};
const REASONS = {
  interval: 'It has been a while since you last confirmed it was you.',
  new_network: 'You are connecting from a new network.',
  sensitive_action: 'This is a sensitive action and needs a fresh code.',
};

/**
 * Only allow same-site relative redirects. The address is resolved the way a browser resolves a Location header,
 * against a fixed origin, and must come back to that origin: the URL standard strips tab and newline before it
 * parses, so a check on the raw text is not enough. Control characters and backslashes are refused up front.
 */
export function safeNext(n) {
  const fallback = '/packages';
  if (typeof n !== 'string' || n.length > 2048 || !n.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(n)) return fallback;
  try {
    const u = new URL(n, 'http://gitcha.invalid');
    return u.origin === 'http://gitcha.invalid' ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
}

export function registerWeb(router, { auth, packages, teams, config, billing }) {
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

  /** For POSTs needing a fresh code: send through /verify, then back to the `back` page. */
  const requireFresh = (ctx, a, back, force = false) => {
    const age = auth.clock() - (a.session.mfaAt ?? 0);
    const needs = force || auth.checkSettings(a.user).sensitive;
    if (needs && age > config.policy.sensitiveWindow) {
      redirect(ctx.res, `/verify?reason=sensitive_action&next=${encodeURIComponent(back)}`);
      return false;
    }
    return true;
  };

  router.get('/', (ctx) => (current(ctx) ? redirect(ctx.res, '/crawl') : page(ctx, 'Free software forge', V.landing(), { wide: true })));

  // ---- registration + mandatory 2FA enrollment -----------------------------
  router.get('/register', (ctx) => page(ctx, 'Create account', V.registerPage({ csrf: csrfToken(ctx) })));

  router.post('/register', async (ctx) => {
    const f = await form(ctx);
    try {
      const { enrollToken } = auth.register({ username: f.username, password: f.password, confirm: f.confirm ?? '', email: f.email, emailConfirm: f.email_confirm, ip: ctx.ip });
      redirect(ctx.res, '/setup-2fa', { 'Set-Cookie': [...ctx.outCookies, cookie(ENROLL, enrollToken, { secure, maxAge: 30 * 60_000 })] });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      page(ctx, 'Create account', V.registerPage({ csrf: csrfToken(ctx), error: err.message, username: f.username, email: f.email, emailConfirm: f.email_confirm }), { status: err.status });
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
      const { ticket } = await auth.beginLogin({ username: f.username, password: f.password, ip: ctx.ip });
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
      redirect(ctx.res, safeNext(f.next));
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
    page(ctx, 'Packages', V.packagesPage({ q, results: packages.search(q, a?.user) }), { user: a?.user, wide: true });
  });

  const packageView = (ctx, a, name, { status = 200 } = {}) => {
    const pkg = packages.info(name, a?.user);
    const myTeams = a ? teams.forUser(a.user).filter((t) => t.role !== 'member' && t.name !== pkg.team) : [];
    const share = a && pkg.canPublish ? V.shareCard({ csrf: csrfToken(ctx), pkg, teams: myTeams }) : '';
    page(ctx, pkg.name, V.packagePage({ pkg, serverUrl: config.publicUrl, share }), { user: a?.user, wide: true, status });
  };

  router.get('/packages/:name', (ctx) => {
    const a = config.publicRead ? current(ctx) : requireWeb(ctx);
    if (!a && !config.publicRead) return;
    packageView(ctx, a, ctx.params.name);
  });

  /** Shared shape for team/package POST forms that need a fresh code. */
  const sensitivePost = (back, fn) => async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, `${back(ctx)}?msg=confirm_again`)) return;
    await fn(ctx, a, f);
  };

  router.post('/packages/:name/transfer', sensitivePost((ctx) => `/packages/${ctx.params.name}`, (ctx, a, f) => {
    packages.transfer(a.user, ctx.params.name, f.team, ctx.ip);
    redirect(ctx.res, `/teams/${encodeURIComponent(f.team)}?msg=transferred`);
  }));

  router.post('/packages/:name/visibility', sensitivePost((ctx) => `/packages/${ctx.params.name}`, (ctx, a, f) => {
    packages.setVisibility(a.user, ctx.params.name, f.private === 'on', ctx.ip);
    redirect(ctx.res, `/packages/${encodeURIComponent(ctx.params.name)}`);
  }));

  // ---- teams --------------------------------------------------------------------
  router.get('/teams', (ctx) => {
    const a = requireWeb(ctx);
    if (a) page(ctx, 'Teams', V.teamsPage({ csrf: csrfToken(ctx), teams: teams.forUser(a.user), notice: NOTICES[ctx.url.searchParams.get('msg')] }), { user: a.user, wide: true });
  });

  router.post('/teams', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    try {
      const t = teams.create(a.user, { name: f.name, description: f.description }, ctx.ip);
      redirect(ctx.res, `/teams/${t.name}?msg=team_created`);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      page(ctx, 'Teams', V.teamsPage({ csrf: csrfToken(ctx), teams: teams.forUser(a.user), error: err.message, name: f.name, description: f.description }),
        { user: a.user, wide: true, status: err.status });
    }
  });

  const teamView = (ctx, a, name, { error, notice, status = 200 } = {}) => {
    const team = teams.view(teams.get(name), a.user);
    page(ctx, team.name, V.teamPage({
      csrf: csrfToken(ctx), team, me: a.user, error, notice, packages: packages.search('', a.user, { team: team.name }),
    }), { user: a.user, wide: true, status });
  };

  router.get('/teams/:team', (ctx) => {
    const a = requireWeb(ctx);
    if (a) teamView(ctx, a, ctx.params.team, { notice: NOTICES[ctx.url.searchParams.get('msg')] });
  });

  /** Team changes: on a rule violation, show the team page with the error. */
  const teamPost = (fn) => sensitivePost((ctx) => `/teams/${ctx.params.team}`, async (ctx, a, f) => {
    try {
      await fn(ctx, a, f);
    } catch (err) {
      if (!(err instanceof HttpError) || err.code === 'team_not_found') throw err;
      teamView(ctx, a, ctx.params.team, { error: err.message, status: err.status });
    }
  });

  router.post('/teams/:team/members', teamPost((ctx, a, f) => {
    // Naming an owner hands over the whole team: it takes a code of its own, not just the open window.
    if (f.role === 'owner') auth.confirmAction(a, f.code, ctx.ip, 'Making someone an owner');
    teams.setMember(a.user, ctx.params.team, f.username, f.role, ctx.ip);
    redirect(ctx.res, `/teams/${ctx.params.team}?msg=member_saved`);
  }));

  router.post('/teams/:team/members/:username/remove', teamPost((ctx, a) => {
    const self = ctx.params.username.toLowerCase() === a.user.username.toLowerCase();
    teams.removeMember(a.user, ctx.params.team, ctx.params.username, ctx.ip);
    redirect(ctx.res, self ? '/teams?msg=left' : `/teams/${ctx.params.team}?msg=member_removed`);
  }));

  router.post('/teams/:team/delete', teamPost((ctx, a) => {
    teams.delete(a.user, ctx.params.team, ctx.ip);
    redirect(ctx.res, '/teams?msg=team_deleted');
  }));

  // ---- billing ----------------------------------------------------------------------
  const billingBack = (owner) => `/billing?owner=${encodeURIComponent(owner ?? '')}`;
  const billingView = (ctx, a, owner, { error, notice, status = 200 } = {}) => {
    const view = billing.view(a.user, owner);
    const owners = [`user:${a.user.username}`, ...teams.forUser(a.user).filter((t) => t.role === 'owner').map((t) => `team:${t.name}`)];
    page(ctx, 'Billing', V.billingPage({ csrf: csrfToken(ctx), view, owners, error, notice }), { user: a.user, wide: true, status });
  };

  router.get('/billing', (ctx) => {
    const a = requireWeb(ctx);
    if (a) billingView(ctx, a, ctx.url.searchParams.get('owner') || undefined, { notice: NOTICES[ctx.url.searchParams.get('msg')] });
  });

  router.post('/billing/checkout', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, `${billingBack(f.owner)}&msg=confirm_again`, true)) return;
    try {
      const { url } = await billing.checkout(a.user, { owner: f.owner, plan: f.plan, provider: f.provider }, ctx.ip);
      // Only ever redirect to the provider URL the provider gave us.
      redirect(ctx.res, url);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      billingView(ctx, a, f.owner, { error: err.message, status: err.status });
    }
  });

  router.get('/billing/return', async (ctx) => {
    const a = requireWeb(ctx);
    if (!a) return;
    const q = ctx.url.searchParams;
    try {
      await billing.confirmReturn(a.user, { owner: q.get('owner'), provider: q.get('provider'), sessionId: q.get('session_id'), subscriptionId: q.get('subscription_id') });
      redirect(ctx.res, `${billingBack(q.get('owner'))}&msg=subscribed`);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      billingView(ctx, a, q.get('owner'), { error: `${err.message} If you completed payment, it will appear once the provider notifies us.`, status: err.status });
    }
  });

  router.post('/billing/cancel', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, `${billingBack(f.owner)}&msg=confirm_again`, true)) return;
    await billing.cancel(a.user, { owner: f.owner }, ctx.ip);
    redirect(ctx.res, `${billingBack(f.owner)}&msg=sub_cancelled`);
  });

  router.post('/billing/portal', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, `${billingBack(f.owner)}&msg=confirm_again`, true)) return;
    redirect(ctx.res, (await billing.portal(a.user, { owner: f.owner })).url);
  });


  // ---- account security -----------------------------------------------------
  /** The three audit lists on the Account page, each 15 rows to a page: ?events=, ?others= and ?downloads= are page numbers. */
  const PER_PAGE = 15;
  const activityLists = (ctx, userId) => {
    const one = (kind, param) => {
      const total = auth.store.auditCount(userId, kind);
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      const page = Math.min(pages, Math.max(1, Math.floor(Number(ctx.url.searchParams.get(param))) || 1));
      return { rows: auth.store.auditFor(userId, PER_PAGE, { kind, skip: (page - 1) * PER_PAGE }), page, pages, param, total };
    };
    return { security: one('security', 'events'), others: one('others', 'others'), traffic: one('traffic', 'downloads') };
  };

  const accountView = (ctx, a, { notice, error, status = 200 } = {}) => {
    const sessions = auth.store.sessionsForUser(a.user.id).filter((s) => s.kind !== 'enroll').sort((x, y) => y.lastSeen - x.lastSeen);
    const state = auth.mfaState(a);
    page(ctx, 'Account', V.accountPage({
      csrf: csrfToken(ctx), user: a.user, email: auth.emailOf(a.user), checks: auth.checkSettings(a.user), sessions, currentHash: a.hash,
      activity: activityLists(ctx, a.user.id), notice, error, recoveryLeft: a.user.recoveryCodes.length,
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
    if (!a) return;
    // The code travels with the form and is used up by it. A locked box is shown disabled, so a browser never
    // sends it: leave locked keys out of the change instead of reading their absence as "off" (AUTH-8).
    const locked = auth.checkSettings(a.user).locked;
    const changes = {};
    for (const key of ['interval', 'new_network', 'sensitive']) if (!locked.includes(key)) changes[key] = f[key] === 'on';
    try {
      auth.changeChecks(a, { changes, code: f.code }, ctx.ip);
      redirect(ctx.res, '/account?msg=checks_saved');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      accountView(ctx, a, { error: err.message, status: err.status });
    }
  });

  router.post('/account/email', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/account?msg=confirm_again', true)) return;
    try {
      auth.updateEmail(a.user, { email: f.email, emailConfirm: f.email_confirm }, ctx.ip);
      redirect(ctx.res, '/account?msg=email_saved');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      accountView(ctx, a, { error: err.message, status: err.status });
    }
  });

  router.post('/account/recovery-codes', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/account?msg=confirm_again', true)) return;
    page(ctx, 'Recovery codes', V.recoveryCodesPage({ codes: auth.regenerateRecoveryCodes(a.user, ctx.ip), fresh: false }), { user: a.user });
  });

  router.post('/account/sessions/:id/revoke', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/account?msg=confirm_again')) return;
    const target = auth.store.sessionsForUser(a.user.id).find((s) => s.hash.startsWith(ctx.params.id) && ctx.params.id.length === 16);
    if (target) auth.revoke(target.hash, a.user.username, ctx.ip);
    redirect(ctx.res, '/account?msg=revoked');
  });

  return { page, form, csrfToken, current, requireWeb, requireFresh, NOTICES };
}

function browserName(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

