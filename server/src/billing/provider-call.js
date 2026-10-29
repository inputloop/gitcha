// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What the payment providers have in common when we call them: a time limit, and one fixed message for the user
// whatever the provider said (its own words name accounts, prices and keys; they go to the server log instead).
import { HttpError } from '../errors.js';

export const PROVIDER_TIMEOUT_MS = 10_000;

/** The error a user sees, with the detail logged. `status` is the provider's HTTP status when there was one. */
export function providerError(name, code, log, detail, status) {
  log?.error(`billing: ${name} call failed: ${detail}`);
  const err = new HttpError(502, code, `${name} could not complete the request. Try again later; if it keeps happening the operator can see why in the server log.`);
  return Object.assign(err, { providerStatus: status });
}

/** fetch() that gives up after `timeoutMs` and reports any failure as a providerError. */
export async function providerFetch({ fetchImpl, name, code, log, timeoutMs, what }, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw providerError(name, code, log, `${what}: ${err.name === 'TimeoutError' || err.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : err.message}`);
  }
}
