// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A remote member as the hub sees it: one gateway URL, one bearer token read from the environment at call time
// (never kept on disk in the sandbox, never shown), JSON-RPC by POST. Also answers a plain Streamable HTTP MCP
// server that replies in JSON, so a member need not be behind our gateway at all.
import fs from 'node:fs';

/**
 * readRoster(text): the hub's roster, JSON: { "members": { NAME: { "url": "https://...", "tokenEnv": "OMNI_TOKEN_NAME",
 * "tokenFile": PATH } } }. `tokenEnv` names the environment variable (a cloud environment's secret) holding the token.
 */
export function readRoster(text) {
  const cfg = JSON.parse(text);
  const members = cfg.members ?? {};
  const problems = [];
  for (const [name, m] of Object.entries(members)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) problems.push(`${name}: a member name is lower-case letters, digits, _ and -`);
    if (!/^https?:\/\//.test(m.url ?? '')) problems.push(`${name}: url must be http(s)://...`);
    if (!m.tokenEnv && !m.tokenFile) problems.push(`${name}: needs tokenEnv (the environment variable holding its token) or tokenFile`);
  }
  if (problems.length) throw new Error(`roster: ${problems.join('; ')}`);
  return members;
}

export class Remote {
  constructor(name, spec, { fetchFn = fetch, env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
    Object.assign(this, { name, spec, fetchFn, env, readFile, next: 1, tools: [], info: null, error: null });
  }

  token() {
    if (this.spec.tokenFile) { try { return this.readFile(this.spec.tokenFile).trim(); } catch { return ''; } }
    return this.env[this.spec.tokenEnv] ?? '';
  }

  async request(method, params, { timeout = 60_000 } = {}) {
    const token = this.token();
    if (!token) throw new Error(`${this.name}: no token (${this.spec.tokenEnv ? `set ${this.spec.tokenEnv} in the environment` : `${this.spec.tokenFile} is unreadable`})`);
    const id = this.next++;
    let res;
    try {
      res = await this.fetchFn(this.spec.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) { throw new Error(`${this.name}: cannot reach ${this.spec.url}: ${err?.cause?.code ?? err?.message ?? err}`); }
    if (res.status === 401) throw new Error(`${this.name}: the gateway refused the token`);
    const text = await res.text();
    let msg;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // A Streamable HTTP server may answer in SSE: take the last data: line that is JSON for our id.
      for (const line of text.split('\n')) if (line.startsWith('data:')) { try { const m = JSON.parse(line.slice(5)); if (m.id === id) msg = m; } catch { /* not ours */ } }
    } else { try { msg = JSON.parse(text); } catch { /* below */ } }
    if (!msg) throw new Error(`${this.name}: HTTP ${res.status}, not a JSON-RPC answer`);
    if (msg.error) throw new Error(`${this.name}: ${msg.error.message}`);
    return msg.result;
  }

  async notify(method, params) {
    const token = this.token();
    try { await this.fetchFn(this.spec.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method, params }), signal: AbortSignal.timeout(10_000) }); } catch { /* a notification is best effort */ }
  }

  /** Initialise and list tools; a failure is kept in this.error, so the hub can say which member is out. */
  async connect() {
    try {
      this.info = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'omni-hub', version: '0.2.0' } }, { timeout: 20_000 });
      await this.notify('notifications/initialized', {});
      this.tools = (await this.request('tools/list', {}, { timeout: 20_000 }))?.tools ?? [];
      this.error = null;
    } catch (err) { this.error = err.message; this.tools = []; }
    return this;
  }

  call(name, args) { return this.request('tools/call', { name, arguments: args }); }
}
