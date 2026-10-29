// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The error types the server throws on purpose. app.js turns each one into a reply with the right
// HTTP status code: JSON for the API, an HTML error page for the website.

/**
 * An error that becomes an HTTP reply. `status` is the HTTP status code (such as 404), `code` is a
 * short name programs can check (such as 'not_found'), `message` is for people, and `extra` holds
 * more fields to add to the JSON reply.
 */
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * A 401 reply that asks for a fresh two-factor code (MFA: multi-factor authentication, meaning a
 * second proof such as an app code on top of the password). `reason` tells the client why.
 */
export const mfaRequired = (reason, message) =>
  new HttpError(401, 'mfa_required', message ?? 'A fresh two-factor code is required.', { reason });
