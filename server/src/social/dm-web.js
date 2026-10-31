// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The Messages page (/messages) and the JSON routes its script calls (/api/v1/dm/...). The page is a plain
// shell: all the encrypting and decrypting happens in the browser, in /static/dm.js, because the point is that
// this server never has the keys. See dm.js beside this file for what is stored and why.
//
// Every /api/v1/dm route needs the web session (the cookie) with its 2FA checks, or a device token, and from a
// browser the X-Gitcha-CSRF header too, on reads as well as writes: another site can then neither send nor
// even ask. (CSRF is a trick where another site makes your browser send a request.) Setting or replacing a
// key, and fetching the locked backup, need a fresh code, like other sensitive actions.
import { HttpError, mfaRequired } from '../errors.js';
import fs from 'node:fs';
import { json, readJson, send } from '../http.js';
import { safeEqual } from '../crypto.js';
import { h } from '../views.js';

const SHARED = Object.fromEntries(['dm-protocol.js', 'dm-client.js'].map((f) => [f, fs.readFileSync(new URL(`../../../extension/lib/${f}`, import.meta.url))]));

export function registerDm(router, { auth, config, web, dm }) {
  const { page, current, requireWeb, csrfValid, csrfToken } = web;

  /** The caller of a /api/v1/dm route: a checked web session (with the CSRF header) or a device token. */
  const caller = (ctx, { fresh = false } = {}) => {
    const hdr = ctx.req.headers.authorization ?? '';
    const bearer = /^Bearer (.+)$/.exec(hdr)?.[1];
    let a;
    if (bearer) {
      a = auth.authenticate(bearer, ctx.ip);
    } else {
      a = current(ctx);
      if (a) {
        const site = ctx.req.headers['sec-fetch-site'];
        const token = ctx.req.headers['x-gitcha-csrf'] ?? '';
        if ((site !== undefined && site !== 'same-origin') || !ctx.cookies.gitcha_csrf || !safeEqual(token, ctx.cookies.gitcha_csrf) || !csrfValid(ctx, token)) {
          throw new HttpError(403, 'csrf', 'Send the X-Gitcha-CSRF header from this site\'s own page.');
        }
      }
    }
    if (!a) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    const state = auth.mfaState(a, fresh ? { fresh: config.policy.sensitiveWindow } : {});
    if (!state.ok) throw mfaRequired(state.reason);
    return a;
  };

  router.get('/messages', (ctx) => {
    const a = requireWeb(ctx);
    if (!a) return;
    page(ctx, 'Messages', messagesPage({ username: a.user.username, to: ctx.url.searchParams.get('to') ?? '', csrf: csrfToken(ctx) }), { user: a.user, wide: true });
  });

  router.get('/api/v1/dm/me', (ctx) => {
    const a = caller(ctx);
    json(ctx.res, 200, { ...dm.me(a.user), blocked: dm.blockedBy(a.user) });
  });
  router.put('/api/v1/dm/identity', async (ctx) => {
    const a = caller(ctx, { fresh: true });
    json(ctx.res, 200, await dm.setIdentity(a.user, await readJson(ctx.req, 512 * 1024), ctx.ip));
  });
  router.put('/api/v1/dm/prekey', async (ctx) => {
    const a = caller(ctx);
    json(ctx.res, 200, await dm.rotatePrekey(a.user, await readJson(ctx.req, 512 * 1024)));
  });
  // A new device needs a fresh code for the backup; a device that signs today's proof with the identity key does not.
  router.get('/api/v1/dm/backup', async (ctx) => {
    const a = caller(ctx);
    if (!(await dm.provesIdentity(a.user, ctx.url.searchParams.get('proof')))) caller(ctx, { fresh: true });
    json(ctx.res, 200, dm.backup(a.user));
  });
  router.get('/api/v1/dm/keys/:username', (ctx) => { caller(ctx); json(ctx.res, 200, dm.keyView(dm.person(ctx.params.username))); });
  router.get('/api/v1/dm/box', (ctx) => json(ctx.res, 200, dm.box(caller(ctx).user, { after: ctx.url.searchParams.get('after') })));
  router.post('/api/v1/dm/send', async (ctx) => {
    const a = caller(ctx);
    json(ctx.res, 201, dm.send(a.user, await readJson(ctx.req, 256 * 1024)));
  });
  router.post('/api/v1/dm/block', async (ctx) => {
    const a = caller(ctx);
    const { username, blocked = true } = await readJson(ctx.req);
    json(ctx.res, 200, dm.setBlock(a.user, username, Boolean(blocked), ctx.ip));
  });

  // The two files that do the encrypting. They live in extension/lib, so the gitcha CLI ships the very same
  // files: anyone can compare what this server sends with the copies in their own package (gitcha messages
  // check-page).
  for (const [name, source] of Object.entries(SHARED)) {
    router.get(`/static/${name}`, (ctx) => send(ctx.res, 200, source, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));
  }
}

/**
 * The Messages page. The script (/static/dm.js) fills it in. The CSRF cookie is HttpOnly (scripts cannot
 * read it), so the page carries the same token in data-csrf for the script to send back as a header. Without the script the page says so, rather
 * than show nothing: messages cannot be read without it, by design.
 */
export const messagesPage = ({ username, to, csrf }) => h`
<link rel="stylesheet" href="/static/dm.css">
<div class="page-head"><h1>Messages</h1><span class="badge ok">end-to-end encrypted</span></div>
<div id="dm" class="dm" data-me="${username}" data-to="${to}" data-csrf="${csrf}">
  <noscript><div class="alert error">Messages are encrypted on your device, so this page needs JavaScript. Or use the gitcha command line: gitcha messages.</div></noscript>
  <p class="muted" id="dm-loading">Opening your messages...</p>
  <section class="card dm-setup" id="dm-setup" hidden>
    <h2>Set up encrypted messages</h2>
    <p>This device will make your keys. They stay here: the server only gets the public halves, so it can never read your messages. Every 7 days this device makes a fresh key for new messages and, after 30 days, destroys the old ones, so keys stolen later cannot open older messages.</p>
    <p>A backup passphrase lets you read your messages on another device, or after clearing this browser. The server keeps your keys locked with it and never sees the passphrase. Without one, your messages live only on this device.</p>
    <form id="dm-setup-form">
      <label>Backup passphrase <span class="muted">(at least 12 characters; leave empty for no backup)</span> <input type="password" name="passphrase" autocomplete="new-password" minlength="12"></label>
      <label>Passphrase again <input type="password" name="again" autocomplete="new-password"></label>
      <button class="btn">Make my keys</button>
    </form>
  </section>
  <section class="card dm-restore" id="dm-restore" hidden>
    <h2>Unlock your messages on this device</h2>
    <p id="dm-restore-why"></p>
    <form id="dm-restore-form">
      <label>Backup passphrase <input type="password" name="passphrase" autocomplete="current-password"></label>
      <button class="btn">Unlock</button>
    </form>
    <details class="dm-replace"><summary>Start over with new keys</summary>
      <p>Messages sent to your old keys cannot be read with new ones. People you write to will be told your key changed.</p>
      <button class="btn danger" id="dm-replace" type="button">Make new keys</button>
    </details>
  </section>
  <div class="dm-grid" id="dm-main" hidden>
    <aside class="card dm-list">
      <form id="dm-new" class="dm-new"><label class="sr-only" for="dm-new-to">Write to</label><input id="dm-new-to" name="to" placeholder="Write to (username)" autocomplete="off" required><button class="btn small">Open</button></form>
      <ul id="dm-conversations" class="dm-conversations"></ul>
      <p class="small muted">Your key: <code id="dm-my-fp"></code></p>
    </aside>
    <section class="card dm-thread" id="dm-thread">
      <p class="muted">Choose a conversation, or write to someone.</p>
    </section>
  </div>
  <p class="small muted dm-note">Only you and the person you write to can read these messages. The server keeps sealed envelopes that do not say who sent them, all padded to a few fixed sizes, and deletes them after 30 days; messages you have opened stay on this device. Compare safety numbers with the other person, in person or by another channel, to be sure no one is in between.</p>
  <div class="alert error" id="dm-error" role="alert" hidden></div>
</div>
<script src="/static/dm.js" type="module"></script>`;
