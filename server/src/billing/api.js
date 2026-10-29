// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The JSON API and the webhooks for billing. Each route checks who is calling
// and then hands the work to BillingService (billing.js). A webhook is a call
// the payment provider (Stripe or PayPal) makes to us when something changes.
import { json, readJson, readBody } from '../http.js';
import { makeGuards } from '../api.js';

/** Adds the billing routes to the router. */
export function registerBillingApi(router, { auth, billing, config }) {
  const { verified } = makeGuards(auth, config);

  // `verified` means signed in with the regular 2FA check passed (2FA: a code from an authenticator app).
  router.get('/api/v1/billing', (ctx) => {
    const a = verified(ctx);
    json(ctx.res, 200, billing.view(a.user, ctx.url.searchParams.get('owner') || undefined));
  });

  // Starting, changing or cancelling payment is sensitive, so it needs a fresh 2FA code.
  router.post('/api/v1/billing/checkout', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = (await readJson(ctx.req)) ?? {};
    json(ctx.res, 200, await billing.checkout(a.user, { owner: body.owner, plan: body.plan, provider: body.provider }, ctx.ip));
  });

  // Called after the browser comes back from the provider's checkout page.
  router.post('/api/v1/billing/confirm', async (ctx) => {
    const a = verified(ctx);
    const body = (await readJson(ctx.req)) ?? {};
    json(ctx.res, 200, await billing.confirmReturn(a.user, { owner: body.owner, provider: body.provider, sessionId: body.session_id, subscriptionId: body.subscription_id }, ctx.ip));
  });

  router.post('/api/v1/billing/cancel', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = (await readJson(ctx.req)) ?? {};
    json(ctx.res, 200, await billing.cancel(a.user, { owner: body.owner }, ctx.ip));
  });

  router.post('/api/v1/billing/portal', async (ctx) => {
    const a = verified(ctx, { sensitive: true });
    const body = (await readJson(ctx.req)) ?? {};
    json(ctx.res, 200, await billing.portal(a.user, { owner: body.owner }));
  });

  // Webhooks: the signature is the only proof of who sent them, so we read the exact bytes (at most 512 KB) and check them.
  for (const provider of ['stripe', 'paypal']) {
    router.post(`/api/v1/billing/${provider}/webhook`, async (ctx) => {
      const raw = await readBody(ctx.req, 512 * 1024);
      json(ctx.res, 200, await billing.webhook(provider, raw, ctx.req.headers));
    });
  }
}
