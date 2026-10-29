// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What the Stripe and PayPal code share when they call the provider: a time
// limit, and one fixed message for the user, whatever the provider said. The
// provider's own words can name accounts, prices and keys, so they go to the
// server log instead.
import { HttpError } from '../errors.js';

export const PROVIDER_TIMEOUT_MS = 10_000; // give up after 10 seconds

/** Builds the error a user sees (a 502), and logs the detail. `status` is the provider's HTTP status, when there was one. */
export function providerError(name, code, log, detail, status) {
  log?.error(`billing: ${name} call failed: ${detail}`);
  const err = new HttpError(502, code, `${name} could not complete the request. Try again later; if it keeps happening the operator can see why in the server log.`);
  return Object.assign(err, { providerStatus: status });
}

/** Like fetch(), but gives up after `timeoutMs` and reports any network failure as a providerError. */
export async function providerFetch({ fetchImpl, name, code, log, timeoutMs, what }, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw providerError(name, code, log, `${what}: ${err.name === 'TimeoutError' || err.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : err.message}`);
  }
}
