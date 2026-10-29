// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// BIL-1a and BIL-1b: what the Stripe webhook does with a signature header or a body that is not the plain case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, stripeEvent, STRIPE_WH } from './billing-fixtures.js';

const hmac = (t, body) => crypto.createHmac('sha256', STRIPE_WH).update(`${t}.`).update(body).digest('hex');
const send = (srv, body, header) => fetch(`${srv.url}/api/v1/billing/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': header } });

test('BIL-1a: a v1 of the right length in characters but not in bytes is a bad signature (400), not a crash (500)', async () => {
  const { srv } = await setup();
  try {
    const body = stripeEvent(srv, 'invoice.payment_failed', { subscription: 'sub_1' });
    const t = Math.floor(srv.clock() / 1000);
    const good = hmac(t, body);
    const crafted = `${good.slice(0, 63)}é`; // 64 characters, 65 bytes
    const res = await send(srv, body, `t=${t},v1=${crafted}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_signature');
    // Decoding the hex alone would also take a good signature with junk after it; only an exact match counts.
    assert.equal((await send(srv, body, `t=${t},v1=${good}zz`)).status, 400, 'a good signature with trailing characters');
    assert.equal((await send(srv, body, `t=${t},v1=${good}`)).status, 200, 'and the plain good one still works');
  } finally { await srv.close(); }
});

test('BIL-1b: the signature covers the exact bytes of the body, not their lossy text decoding', async () => {
  const { srv } = await setup();
  try {
    const t = Math.floor(srv.clock() / 1000);
    const around = (byte) => Buffer.concat([Buffer.from(`{"id":"evt_bytes","type":"x.y","created":${t},"livemode":false,"data":{"object":{}},"pad":"`), Buffer.from([byte]), Buffer.from('"}')]);
    assert.equal(around(0xff).toString('utf8'), around(0xfe).toString('utf8'), 'the two bodies decode to the same text');
    // A signature made over the decoded text of one body is not a signature for the other body's bytes.
    const lossy = await send(srv, around(0xfe), `t=${t},v1=${hmac(t, around(0xff).toString('utf8'))}`);
    assert.equal(lossy.status, 400);
    assert.equal((await lossy.json()).error, 'bad_signature');
    // A signature made over the bytes, as Stripe makes it, holds for those bytes.
    const own = await send(srv, around(0xff), `t=${t},v1=${hmac(t, around(0xff))}`);
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { ignored: true, reason: 'unknown_subscription' });
  } finally { await srv.close(); }
});
