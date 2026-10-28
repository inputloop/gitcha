export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const mfaRequired = (reason, message) =>
  new HttpError(401, 'mfa_required', message ?? 'A fresh two-factor code is required.', { reason });
