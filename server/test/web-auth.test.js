// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The browser-facing sign-in surface, driven like a browser: redirects, CSRF and the Account page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser } from './helpers.js';

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
