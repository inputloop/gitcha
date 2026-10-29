// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A small cookie-keeping browser for the web tests: it follows no redirects, keeps what Set-Cookie sends and
// posts the CSRF token the server issued, as a real browser does with a form.

export class Browser {
  constructor(srv, cookies = {}, headers = {}) {
    this.srv = srv;
    this.jar = { ...cookies };
    this.headers = headers;
  }

  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }

  keep(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = decodeURIComponent(pair.slice(i + 1));
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') delete this.jar[name];
      else this.jar[name] = value;
    }
  }

  async go(p, { method = 'GET', form, headers = {} } = {}) {
    const res = await fetch(this.srv.url + p, {
      method, redirect: 'manual',
      headers: { Cookie: this.cookieHeader(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...this.headers, ...headers },
      body: form ? new URLSearchParams(form) : undefined,
    });
    this.keep(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }

  /** Visit a page so the server issues this browser's CSRF cookie, then return it. */
  async csrf(prime = '/register') {
    if (!this.jar.gitcha_csrf) await this.go(prime);
    return this.jar.gitcha_csrf;
  }

  /** POST a form with the CSRF token the server issued. */
  async post(p, fields = {}, { headers } = {}) {
    const token = await this.csrf();
    return this.go(p, { method: 'POST', form: { _csrf: token, ...fields }, headers });
  }
}
