// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What a downgrade does to sites over the new limit: the newest ones stop taking changes after a grace, nothing is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import { setup, subscribe, billingOf, DAY } from './billing-fixtures.js';

const post = (srv, token, p, body) => api(srv.url, 'POST', p, { token, body });
const GRACE = 14 * DAY;

async function sixSitesOnPro(ctx) {
  const { srv, fake, token } = ctx;
  const paid = await subscribe(srv, fake, token, { plan: 'pro' });
  assert.equal(paid.confirm.body.plan, 'pro');
  for (let i = 1; i <= 6; i++) {
    assert.equal((await post(srv, token, '/api/v1/sites', { name: `pro-s${i}` })).status, 201);
    srv.clock.advance(1000);
  }
}

test('BIL-10: after a cancel the newest sites over the Free limit take no changes once the grace has run, and are never removed', async () => {
  const ctx = await setup();
  const { srv, token } = ctx;
  try {
    await sixSitesOnPro(ctx);
    srv.billing.requireWritableSite('user:alice', 'pro-s6'); // Pro: nothing to refuse
    const cancelled = await post(srv, token, '/api/v1/billing/cancel', {});
    assert.equal(cancelled.body.plan, 'pro', 'a cancel keeps the paid month');
    const canceledAt = cancelled.body.subscription.endsAt;
    srv.clock.advance(canceledAt - srv.clock() + 1); // and the month runs out
    assert.equal((await billingOf(srv, token)).plan, 'free');

    const v = await billingOf(srv, token);
    assert.deepEqual(v.overQuota.sites, ['pro-s4', 'pro-s5', 'pro-s6'], 'the oldest three keep their places');
    assert.equal(v.overQuota.readOnlyFrom, canceledAt + GRACE, 'told to the member, with the date');
    assert.equal(v.usage.sites, 6);

    srv.billing.requireWritableSite('user:alice', 'pro-s6'); // inside the grace: still writable
    srv.clock.advance(GRACE - 1000);
    srv.billing.requireWritableSite('user:alice', 'pro-s6');
    srv.clock.advance(2000);
    for (const s of ['pro-s4', 'pro-s5', 'pro-s6']) {
      assert.throws(() => srv.billing.requireWritableSite('user:alice', s), (e) => e.status === 402 && e.code === 'site_read_only', s);
    }
    for (const s of ['pro-s1', 'pro-s2', 'pro-s3']) srv.billing.requireWritableSite('user:alice', s);
    assert.equal(Object.keys(srv.store.data.sites).length, 6, 'nothing was deleted');

    // Removing an older site gives its place to the newest of the read-only ones.
    assert.equal((await api(srv.url, 'DELETE', '/api/v1/sites/pro-s1', { token })).status, 200);
    srv.billing.requireWritableSite('user:alice', 'pro-s4');
    assert.throws(() => srv.billing.requireWritableSite('user:alice', 'pro-s5'), (e) => e.status === 402);
  } finally { await srv.close(); }
});

test('BIL-10: starting a new checkout, or paying again, does not reset or leave the grace', async () => {
  const ctx = await setup();
  const { srv, fake, token } = ctx;
  try {
    await sixSitesOnPro(ctx);
    const cancelled = await post(srv, token, '/api/v1/billing/cancel', {});
    srv.clock.advance(cancelled.body.subscription.endsAt - srv.clock() + 1); // the paid month runs out
    srv.clock.advance(5 * DAY);
    // A checkout that is never paid replaces the cancelled record; the clock that began when the paid month ended keeps running.
    assert.equal((await post(srv, token, '/api/v1/billing/checkout', { plan: 'pro', provider: 'stripe' })).status, 200);
    srv.clock.advance(GRACE - 5 * DAY + 1000);
    assert.throws(() => srv.billing.requireWritableSite('user:alice', 'pro-s6'), (e) => e.status === 402);

    // Paying again lifts it.
    fake.st.periodEnd = Math.floor(srv.clock() / 1000) + 30 * 86_400; // a new month, from now
    const again = await subscribe(srv, fake, token, { plan: 'pro' });
    assert.equal(again.confirm.body.plan, 'pro');
    srv.billing.requireWritableSite('user:alice', 'pro-s6');
    assert.equal((await billingOf(srv, token)).overQuota, undefined);
  } finally { await srv.close(); }
});

test('BIL-10: a paid period that ran out is dated from its end plus the seven days, with no event needed', async () => {
  const ctx = await setup();
  const { srv, fake, token } = ctx;
  try {
    const end = srv.clock() + 30 * DAY;
    fake.st.periodEnd = Math.floor(end / 1000);
    await sixSitesOnPro(ctx);
    srv.clock.advance(30 * DAY + 7 * DAY + 1000);
    const v = await billingOf(srv, token);
    assert.equal(v.plan, 'free');
    assert.equal(v.overQuota.readOnlyFrom, Math.floor(end / 1000) * 1000 + 7 * DAY + GRACE);
    srv.billing.requireWritableSite('user:alice', 'pro-s6');
    srv.clock.advance(GRACE);
    assert.throws(() => srv.billing.requireWritableSite('user:alice', 'pro-s6'), (e) => e.status === 402);
  } finally { await srv.close(); }
});

test('BIL-10: an account that never paid keeps what it has, and is not made read-only', async () => {
  const { srv, token } = await setup();
  try {
    for (let i = 1; i <= 3; i++) await post(srv, token, '/api/v1/sites', { name: `free-s${i}` });
    // The operator lowers the Free limit, or a pool that predates the cap holds more than it should.
    srv.billing.plans.free.limits.sites = 2;
    srv.clock.advance(365 * DAY);
    srv.billing.requireWritableSite('user:alice', 'free-s3');
    assert.equal((await billingOf(srv, token)).overQuota.readOnlyFrom, null, 'listed as over, not locked');
    assert.equal((await post(srv, token, '/api/v1/sites', { name: 'free-s4' })).status, 402, 'but nothing new');
  } finally { await srv.close(); }
});
