// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The browser-facing sign-in surface, driven like a browser: redirects, CSRF and the Account page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, deviceLogin, api } from './helpers.js';
import { Browser } from './browser.js';

const REGISTRY = 'https://registry.example';

/** A signed-in browser: a real web session (as a login would make) and the CSRF cookie the server hands out. */
export async function signedIn(srv, user) {
  const { token } = srv.auth.createSession(srv.store.userByName(user.username), { kind: 'web', name: 'test browser', ip: '127.0.0.1' });
  return { sid: token };
}

async function call(srv, p, { cookie, method = 'GET', form, headers = {} } = {}) {
  const r = await fetch(srv.url + p, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return { status: r.status, location: r.headers.get('location'), text: await r.text(), setCookie: r.headers.getSetCookie?.() ?? [] };
}

const HOSTILE = [
  '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\u0000/evil.example', '/\u001f/evil.example',
  '//evil.example', '/\\evil.example', '/\\\\evil.example', '/\t\\evil.example', 'https://evil.example/', 'javascript:alert(1)',
  '/ /evil.example'.replace(' ', '\u0009'), '', undefined, null, 42, '/'.repeat(5000),
];

test('AUTH-2: a hostile next= never leaves the registry, whatever the browser strips', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv);
    const { sid } = await signedIn(srv, u);
    // Reached by a signed-in GET /login?next=, which needs no CSRF token at all.
    for (const next of HOSTILE.filter((n) => typeof n === 'string')) {
      const r = await call(srv, `/login?next=${encodeURIComponent(next)}`, { cookie: `gitcha_sid=${sid}` });
      assert.equal(r.status, 303, JSON.stringify(next));
      const dest = new URL(r.location, REGISTRY);
      assert.equal(dest.origin, REGISTRY, `next=${JSON.stringify(next.slice(0, 20))} led to ${dest.href}`);
    }
    // A plain same-site path still goes where it asked, query string kept.
    const ok = await call(srv, `/login?next=${encodeURIComponent('/packages/foo?x=1&y=2')}`, { cookie: `gitcha_sid=${sid}` });
    assert.equal(ok.location, '/packages/foo?x=1&y=2');
  } finally { await srv.close(); }
});

test('AUTH-2: safeNext resolves to this origin for every hostile shape, and keeps honest ones', async () => {
  const { safeNext } = await import('../src/web.js');
  for (const n of HOSTILE) {
    const out = safeNext(n);
    assert.equal(new URL(out, REGISTRY).origin, REGISTRY, JSON.stringify(String(n).slice(0, 20)));
    assert.ok(out.startsWith('/') && !/[\u0000-\u001f]/.test(out) && !out.startsWith('//'));
  }
  assert.equal(safeNext('/teams/acme?msg=left'), '/teams/acme?msg=left');
});

/** A browser that holds a real web session for `user`, as a sign-in would leave it. */
async function loggedIn(srv, user) {
  const { sid } = await signedIn(srv, user);
  return new Browser(srv, { gitcha_sid: sid });
}

test('AUTH-4 (web): the Account form carries its own code, and a locked check does not break it (AUTH-8)', async () => {
  const srv = await startServer({ overrides: { policy: { lockedChecks: ['interval'] } } });
  try {
    const u = createUser(srv);
    const b = await loggedIn(srv, u);
    const page = await b.go('/account');
    assert.equal(page.status, 200);
    assert.match(page.text, /name="code"/, 'the settings form asks for a code');
    assert.match(page.text, /name="interval"[^>]*disabled/, 'the locked box is shown disabled');
    // The browser-shaped submit of the untouched form: the disabled box is not sent at all.
    const noCode = await b.post('/account/checks', { new_network: 'on', sensitive: 'on' });
    assert.notEqual(noCode.location, '/account?msg=checks_saved', 'no code, no change');
    assert.equal(noCode.status, 401, `got ${noCode.status}`);
    assert.match(noCode.text, /code from your authenticator app/);
    // A stale step-up is not a code for the form (the session was just created, so the window is open).
    const saved = await b.post('/account/checks', { sensitive: 'on', code: u.nextCode() });
    assert.equal(saved.status, 303, saved.text.match(/alert[^>]*>([^<]*)/)?.[1]);
    assert.equal(saved.location, '/account?msg=checks_saved');
    const stored = srv.store.userByName(u.username).mfaChecks;
    assert.equal(stored.new_network, false, 'unchecked boxes turn off');
    assert.equal(stored.sensitive, true);
    assert.equal(stored.interval, undefined, 'the locked key is not part of the change');
  } finally { await srv.close(); }
});

test('AUTH-4 (web): making someone an owner on the team page needs a code of its own', async () => {
  const srv = await startServer();
  try {
    const u = createUser(srv, 'alice');
    createUser(srv, 'bobby');
    const token = await deviceLogin(srv, u);
    await api(srv.url, 'POST', '/api/v1/teams', { token, body: { name: 'acme' } });
    const b = await loggedIn(srv, u);
    const maintainer = await b.post('/teams/acme/members', { username: 'bobby', role: 'maintainer' });
    assert.equal(maintainer.status, 303, 'a maintainer grant uses the open window');
    const noCode = await b.post('/teams/acme/members', { username: 'bobby', role: 'owner' });
    assert.equal(noCode.status, 401);
    assert.match(noCode.text, /code from your authenticator app/);
    assert.equal(srv.store.team('acme').members[srv.store.userByName('bobby').id].role, 'maintainer');
    const owner = await b.post('/teams/acme/members', { username: 'bobby', role: 'owner', code: u.nextCode() });
    assert.equal(owner.status, 303);
    assert.equal(srv.store.team('acme').members[srv.store.userByName('bobby').id].role, 'owner');
  } finally { await srv.close(); }
});
