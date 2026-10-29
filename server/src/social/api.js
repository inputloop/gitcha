// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// HTTP routes for the social side: the GraphQL endpoint, media upload, and
// media download. Media is served with a strict CSP (Content Security Policy:
// the browser's rules for what a page may load or run) in sandbox mode, and
// with no type sniffing (the browser may not guess a different file type).
// Every stored file was checked at upload to be a known image, video, audio or
// PDF format (see sniffMedia in social.js).
import { json, send, readBody } from '../http.js';
import { HttpError } from '../errors.js';

/** Adds the social routes to the router. */
export function registerSocialApi(router, { graphql, social, principals, store, config, auth }) {
  router.post('/api/graphql', (ctx) => graphql.handle(ctx));
  router.get('/api/graphql', (ctx) => graphql.handle(ctx));

  router.post('/api/v1/media', async (ctx) => {
    const h = ctx.req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    // Agent keys ("gak_...") are refused here: they open only the paid sandboxes.
    if (token.startsWith('gak_')) throw new HttpError(401, 'unauthenticated', 'Agent keys work only for the paid sandboxes.');
    const principal = token ? principals.fromToken(token, ctx.ip) : null;
    if (!principal) throw new HttpError(401, 'unauthenticated', 'Upload with a Bearer token.');
    // People must have passed their regular 2FA check (two-factor: a code from an authenticator app).
    if (principal.kind === 'user' && principal.auth) auth.requireMfa(principal.auth);
    // Read one byte more than the limit, so uploadMedia can tell that a file is too big.
    const buf = await readBody(ctx.req, config.social.maxMediaBytes + 1);
    json(ctx.res, 201, social.uploadMedia(principal, buf));
  });

  router.get('/media/:file', (ctx) => {
    // The name is "<id>.<ext>". Only the id counts: a 64-character hex SHA-256 hash we have stored.
    const [id] = ctx.params.file.split('.');
    const m = store.data.media[id];
    if (!/^[a-f0-9]{64}$/.test(id) || !m) throw new HttpError(404, 'not_found', 'Not found.');
    // A file's name is its hash, so its bytes never change and it may be cached for a year.
    // The CSP and sandbox stop a file from running scripts even when it is opened on its own.
    send(ctx.res, 200, store.readBlob(id), {
      'Content-Type': m.type, 'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });
}
