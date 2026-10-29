// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The HTTP client the CLI, the MCP server and the hook use to talk to a Gitcha server.
// Each method sends one request to the registry API (or GraphQL) and returns the JSON answer.
import crypto from 'node:crypto';

// An error from the server or the network. `status` is the HTTP status (0 when no answer came back),
// and `code` is the short error name the server sent, such as "mfa_required".
export class GitchaError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, ...extra });
  }
  get mfaRequired() { return this.code === 'mfa_required'; }
  get unauthenticated() { return this.code === 'unauthenticated'; }
}

// One client per server. It sends the saved device token, if any, as a Bearer token.
export class GitchaClient {
  // timeoutMs limits the whole exchange, body included. That way a server that stalls cannot hang a command or a hook.
  constructor({ server, token = null, userAgent = 'gitcha-cli', timeoutMs = 60_000 }) {
    Object.assign(this, { server, token, userAgent, timeoutMs });
  }

  timedOut() {
    return new GitchaError(0, 'timeout', `The Gitcha server at ${this.server} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
  }

  // Send one request. It sends JSON and expects JSON back, unless `raw` asks for the bare response.
  // It refuses redirects, so the token is never sent on to another address.
  // Any non-2xx answer becomes a GitchaError that carries the server's error code and message.
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
  // The change itself uses up the code (AUTH-4). A step-up done earlier is not enough.
  setSecurity(checks, code) { return this.request('PUT', '/api/v1/security', { body: { checks, code } }); }
  search(q = '', { team } = {}) {
    return this.request('GET', `/api/v1/packages?q=${encodeURIComponent(q)}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
  }
  info(name) { return this.request('GET', `/api/v1/packages/${encodeURIComponent(name)}`); }
  yank(name, version, yanked = true) {
    return this.request('POST', `/api/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/yank`, { body: { yanked } });
  }

  // Upload a package tarball as base64, with its sha256 hash so the server can check it arrived whole.
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

  /**
   * Send a GraphQL query (one endpoint that takes a query text). Gitcha uses it for agents, projects,
   * tasks, reviews, posts and keys. The first GraphQL error becomes a GitchaError.
   */
  async graphql(query, variables) {
    const body = await this.request('POST', '/api/graphql', { body: { query, variables } });
    if (body.errors?.length) {
      const x = body.errors[0].extensions ?? {};
      throw new GitchaError(x.status ?? 400, x.code ?? 'graphql_error', body.errors[0].message, x.reason ? { reason: x.reason } : {});
    }
    return body.data;
  }

  /**
   * Download a tarball. The reply must carry the integrity (hash) and version headers.
   * When we ask for a set version, the answer must be that version. If the registry answers with another one,
   * we refuse it instead of believing it.
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
