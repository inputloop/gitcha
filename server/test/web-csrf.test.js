// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Web writes (AUTH-10): the CSRF token is bound to the session and rotated at sign-in, and a write must come from
// this site. Driven like a browser, with the cookie jar of test/browser.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser } from './helpers.js';
import { Browser } from './browser.js';

// A write with no side effects for the signed-in cases: a sign-up with a bad name answers 400 once the CSRF checks pass, 403 when not.
const probe = (b, token, headers = {}) => b.go('/register', { method: 'POST', form: { _csrf: token, username: 'x', password: 'x' }, headers });

/** Sign in through the real forms; returns the browser and the token it held before it signed in. */
async function webSignIn(srv, user) {
  const b = new Browser(srv);
  const before = await b.csrf('/login');
  const first = await b.post('/login', { username: user.username, password: user.password });
  assert.equal(first.status, 303, first.text.slice(0, 200));
  const second = await b.post('/login/2fa', { code: user.nextCode() });
  assert.equal(second.status, 303, second.text.slice(0, 200));
  return { b, before };
}

test('AUTH-10: a CSRF value planted in cookie and form is refused; only a token the server minted passes', async () => {
  const srv = await startServer();
  try {
    const planted = 'planted-by-a-sibling-subdomain-0123456789';
    assert.equal((await probe(new Browser(srv, { gitcha_csrf: planted }), planted)).status, 403, 'an equal pair is not enough');
    const honest = new Browser(srv);
    assert.equal((await probe(honest, await honest.csrf())).status, 400, 'the server\'s own token passes (the sign-up form then says the name is bad)');
  } finally { await srv.close(); }
});

test('AUTH-10: a token belongs to the session it was issued with, and sign-in replaces the one held before', async () => {
  const srv = await startServer();
  try {
    const alice = createUser(srv, 'alice');
    const bob = createUser(srv, 'bobby', 'another long passphrase');
    const a = await webSignIn(srv, alice);
    const b = await webSignIn(srv, bob);
    const tokenA = a.b.jar.gitcha_csrf;
    const tokenB = b.b.jar.gitcha_csrf;
    assert.notEqual(tokenA, a.before, 'the token was rotated at sign-in');
    assert.equal((await probe(a.b, tokenA)).status, 400, 'a session\'s own token passes');
    // Bob plants Alice's token in his own cookie and form: it is valid HMAC output, but for her session.
    b.b.jar.gitcha_csrf = tokenA;
    assert.equal((await probe(b.b, tokenA)).status, 403, 'a token from another session fails');
    b.b.jar.gitcha_csrf = tokenB;
    assert.equal((await probe(b.b, tokenB)).status, 400);
    // The token held before sign-in (bound to no session) is dead once there is one.
    a.b.jar.gitcha_csrf = a.before;
    assert.equal((await probe(a.b, a.before)).status, 403, 'the pre-sign-in token no longer works');
  } finally { await srv.close(); }
});

test('AUTH-10: a web write must come from this site (Sec-Fetch-Site, else Origin)', async () => {
  const srv = await startServer({ overrides: { publicUrl: 'https://registry.example' } });
  try {
    const b = new Browser(srv);
    const token = await b.csrf();
    // /verify with no session just redirects to sign-in: a side-effect-free write that counts against no limiter.
    const status = async (headers) => (await b.go('/verify', { method: 'POST', form: { _csrf: token, code: '1' }, headers })).status;
    assert.equal(await status({}), 303, 'no browser hints at all (a script or an old browser): the token alone');
    assert.equal(await status({ 'Sec-Fetch-Site': 'same-origin' }), 303);
    assert.equal(await status({ 'Sec-Fetch-Site': 'same-origin', Origin: 'null' }), 303, 'our Referrer-Policy makes browsers send Origin null on a same-site form post');
    assert.equal(await status({ 'Sec-Fetch-Site': 'cross-site' }), 403);
    assert.equal(await status({ 'Sec-Fetch-Site': 'same-site' }), 403, 'a sibling subdomain is not this site');
    assert.equal(await status({ Origin: 'https://evil.example' }), 403);
    assert.equal(await status({ Origin: 'https://registry.example.evil.example' }), 403);
    assert.equal(await status({ Origin: 'not a url' }), 403);
    assert.equal(await status({ Origin: 'https://registry.example' }), 303, 'the public URL');
    assert.equal(await status({ Origin: srv.url }), 303, 'the host the request itself was sent to');
    assert.equal(await status({ Origin: 'null' }), 303, 'Origin null without Sec-Fetch-Site is let through; the token still has to match');
  } finally { await srv.close(); }
});
