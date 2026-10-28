// JSON API and webhooks for billing.
import { json, readJson, readBody } from '../http.js';
import { makeGuards } from '../api.js';

export function registerBillingApi(router, { auth, billing, config }) {
  const { verified } = makeGuards(auth, config);

  router.get('/api/v1/billing', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, billing.view(a.user, ctx.url.searchParams.get('owner') || undefined));
  });

  // Starting, changing or cancelling payment is sensitive: a fresh 2FA code.
  router.post('/api/v1/billing/checkout', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req);
    json(ctx.res, 200, await billing.checkout(a.user, { owner: body.owner, plan: body.plan, provider: body.provider }, ctx.ip));
  });

  router.post('/api/v1/billing/confirm', async (ctx) => {
    const a = verified(ctx);
    const body = await readJson(ctx.req);
    json(ctx.res, 200, await billing.confirmReturn(a.user, { owner: body.owner, provider: body.provider, sessionId: body.session_id, subscriptionId: body.subscription_id }));
  });

  router.post('/api/v1/billing/cancel', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req);
    json(ctx.res, 200, await billing.cancel(a.user, { owner: body.owner }, ctx.ip));
  });

  router.post('/api/v1/billing/portal', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = await readJson(ctx.req);
    json(ctx.res, 200, await billing.portal(a.user, { owner: body.owner }));
  });

  // Webhooks: the signature is the only authentication, so read the exact bytes.
  for (const provider of ['stripe', 'paypal']) {
    router.post(`/api/v1/billing/${provider}/webhook`, async (ctx) => {
      const raw = await readBody(ctx.req, 512 * 1024);
      json(ctx.res, 200, await billing.webhook(provider, raw, ctx.req.headers));
    });
  }
}
