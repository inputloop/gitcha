// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// HTTP client for the Gitcha registry API.
import crypto from 'node:crypto';

export class GitchaError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, ...extra });
  }
  get mfaRequired() { return this.code === 'mfa_required'; }
  get unauthenticated() { return this.code === 'unauthenticated'; }
}

export class GitchaClient {
  // timeoutMs bounds the whole exchange, body included, so a registry that stalls cannot hang a command or a hook.
  constructor({ server, token = null, userAgent = 'gitcha-cli', timeoutMs = 60_000 }) {
    Object.assign(this, { server, token, userAgent, timeoutMs });
  }

  timedOut() {
    return new GitchaError(0, 'timeout', `The Gitcha server at ${this.server} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
  }

  async request(method, path, { body, raw = false } = {}) {
    let res;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      res = await fetch(this.server + path, {
        method,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw this.timedOut();
      throw new GitchaError(0, 'network', `Cannot reach the Gitcha server at ${this.server} (${err.cause?.code ?? err.message}).`);
    }
    if (!res.ok) {
      let payload = {};
      try { payload = await res.json(); } catch { /* non-JSON error */ }
      if (signal.aborted) throw this.timedOut();
      const { error, message, ...extra } = payload ?? {};
      throw new GitchaError(res.status, error ?? 'http_error', message ?? `HTTP ${res.status}`, extra);
    }
    if (raw) return res;
    try {
      return await res.json();
    } catch (err) {
      if (err.name === 'TimeoutError' || signal.aborted) throw this.timedOut();
      throw new GitchaError(res.status, 'bad_response', 'The Gitcha server sent an answer that is not JSON.');
    }
  }

  health() { return this.request('GET', '/api/v1/health'); }
  login(username, password) { return this.request('POST', '/api/v1/auth/login', { body: { username, password } }); }
  loginMfa(ticket, code, deviceName) { return this.request('POST', '/api/v1/auth/login/mfa', { body: { ticket, code, device_name: deviceName } }); }
  stepUp(code) { return this.request('POST', '/api/v1/auth/step-up', { body: { code } }); }
  whoami() { return this.request('GET', '/api/v1/auth/whoami'); }
  logout() { return this.request('POST', '/api/v1/auth/logout'); }
  getSecurity() { return this.request('GET', '/api/v1/security'); }
  setSecurity(checks) { return this.request('PUT', '/api/v1/security', { body: { checks } }); }
  search(q = '', { team } = {}) {
    return this.request('GET', `/api/v1/packages?q=${encodeURIComponent(q)}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
  }
  info(name) { return this.request('GET', `/api/v1/packages/${encodeURIComponent(name)}`); }
  yank(name, version, yanked = true) {
    return this.request('POST', `/api/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/yank`, { body: { yanked } });
  }

  publish(tarball, { team, private: priv } = {}) {
    const integrity = `sha256-${crypto.createHash('sha256').update(tarball).digest('hex')}`;
    return this.request('PUT', '/api/v1/packages', { body: { tarball: tarball.toString('base64'), integrity, team, private: priv } });
  }

  transfer(name, team) { return this.request('POST', `/api/v1/packages/${encodeURIComponent(name)}/transfer`, { body: { team } }); }
  setVisibility(name, priv) { return this.request('POST', `/api/v1/packages/${encodeURIComponent(name)}/visibility`, { body: { private: priv } }); }

  // ---- teams ----
  teams() { return this.request('GET', '/api/v1/teams'); }
  team(name) { return this.request('GET', `/api/v1/teams/${encodeURIComponent(name)}`); }
  createTeam(name, description) { return this.request('POST', '/api/v1/teams', { body: { name, description } }); }
  setMember(team, username, role) {
    return this.request('PUT', `/api/v1/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(username)}`, { body: { role } });
  }
  removeMember(team, username) {
    return this.request('DELETE', `/api/v1/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(username)}`);
  }
  deleteTeam(team) { return this.request('DELETE', `/api/v1/teams/${encodeURIComponent(team)}`); }

  /** GraphQL: the API for agents, projects, tasks, reviews, posts and keys. Errors become GitchaErrors. */
  async graphql(query, variables) {
    const body = await this.request('POST', '/api/graphql', { body: { query, variables } });
    if (body.errors?.length) {
      const x = body.errors[0].extensions ?? {};
      throw new GitchaError(x.status ?? 400, x.code ?? 'graphql_error', body.errors[0].message, x.reason ? { reason: x.reason } : {});
    }
    return body.data;
  }

  /**
   * Download a tarball. The reply must carry the integrity and version headers, and when a version was asked
   * for it must be that version: a registry that answers another one is refused, not believed.
   */
  async download(name, version = 'latest') {
    const res = await this.request('GET', `/api/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/tarball`, { raw: true });
    const integrity = res.headers.get('x-gitcha-integrity');
    const answered = res.headers.get('x-gitcha-version');
    if (!integrity || !/^sha256-[0-9a-f]{64}$/.test(integrity) || !answered) {
      throw new GitchaError(0, 'bad_response', `The registry sent ${name}@${version} without a valid integrity or version header. Refusing it.`);
    }
    if (version !== 'latest' && answered !== version) {
      throw new GitchaError(0, 'version_mismatch', `Asked the registry for ${name}@${version} and it answered with ${answered}. Refusing it.`);
    }
    let data;
    try {
      data = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw this.timedOut();
      throw new GitchaError(0, 'network', `The download of ${name}@${version} from ${this.server} broke off (${err.cause?.code ?? err.message}).`);
    }
    return { data, integrity, version: answered };
  }
}
