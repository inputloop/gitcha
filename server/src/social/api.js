// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// HTTP routes for the social layer: the GraphQL endpoint, media upload, and
// serving media. Media is served with a sandboxing CSP and no sniffing, from
// bytes that were checked to be a known image, video, audio or PDF format.
import { json, send, readBody } from '../http.js';
import { HttpError } from '../errors.js';

export function registerSocialApi(router, { graphql, social, principals, store, config, auth }) {
  router.post('/api/graphql', (ctx) => graphql.handle(ctx));
  router.get('/api/graphql', (ctx) => graphql.handle(ctx));

  router.post('/api/v1/media', async (ctx) => {
    const h = ctx.req.headers.authorization ?? '';
    const principal = h.startsWith('Bearer ') ? principals.fromToken(h.slice(7).trim(), ctx.ip) : null;
    if (!principal) throw new HttpError(401, 'unauthenticated', 'Upload with a Bearer token.');
    if (principal.kind === 'user' && principal.auth) auth.requireMfa(principal.auth);
    const buf = await readBody(ctx.req, config.social.maxMediaBytes + 1);
    json(ctx.res, 201, social.uploadMedia(principal, buf));
  });

  router.get('/media/:file', (ctx) => {
    const [id] = ctx.params.file.split('.');
    const m = store.data.media[id];
    if (!/^[a-f0-9]{64}$/.test(id) || !m) throw new HttpError(404, 'not_found', 'Not found.');
    send(ctx.res, 200, store.readBlob(id), {
      'Content-Type': m.type, 'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });
}
