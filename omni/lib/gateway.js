// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The gateway: the host side of Omni. It runs on a machine you own (a ghostwheel node, or your desk) and puts
// stdio MCP servers that live there (vibrobeast's mentcached, persona, tavernface, llamabridge, c4face; Tavern's
// own mcp; Gitcha's) behind HTTP, one URL per member, each behind its own bearer token. A Claude session in a
// cloud sandbox reaches them through the hub (lib/hub.js), or directly as a remote MCP server: the gateway speaks
// the JSON-RPC-over-POST part of MCP's Streamable HTTP transport.
//
// It listens on loopback unless told otherwise, so a TLS proxy (nginx) is the one thing on the network. Each
// member is one child process, started on first use and kept; its stdin and stdout are the newline-delimited
// JSON-RPC both vibrobeast's rpc.py and gitcha's mcp.js speak. Requests from many HTTP callers are serialised
// per member and their ids remapped, so two sessions can share one memory seat without crossing wires.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

/** Read the members file: { "members": { NAME: { "command": [...], "env": {...}, "tokenFile": PATH, "cwd": DIR } } }. */
export function readMembers(path, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const cfg = JSON.parse(readFile(path));
  const members = cfg.members ?? {};
  const problems = [];
  for (const [name, m] of Object.entries(members)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) problems.push(`${name}: a member name is lower-case letters, digits, _ and -`);
    if (!Array.isArray(m.command) || !m.command.length) problems.push(`${name}: command must be a non-empty list`);
    if (!m.tokenFile && !m.token) problems.push(`${name}: needs tokenFile (a file holding the bearer token, mode 600)`);
  }
  if (problems.length) throw new Error(`members file ${path}: ${problems.join('; ')}`);
  return members;
}

/** One stdio MCP child, with requests serialised and ids remapped. */
export class Member {
  constructor(name, spec, { spawnFn = spawn, log = () => {} } = {}) {
    Object.assign(this, { name, spec, spawnFn, log, child: null, next: 1, waiting: new Map(), initialized: null, tools: [] });
  }

  start() {
    if (this.child) return;
    const [cmd, ...args] = this.spec.command;
    this.child = this.spawnFn(cmd, args, { cwd: this.spec.cwd, env: { ...process.env, ...(this.spec.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('exit', (code) => {
      this.log(`${this.name}: exited (${code})`);
      for (const [, w] of this.waiting) w.reject(new Error(`${this.name} exited (${code})`));
      this.waiting.clear(); this.child = null; this.initialized = null;
    });
    this.child.stderr.on('data', (d) => this.log(`${this.name}: ${String(d).trim()}`));
    readline.createInterface({ input: this.child.stdout, terminal: false }).on('line', (line) => {
      if (!line.trim()) return;
      let msg; try { msg = JSON.parse(line); } catch { return this.log(`${this.name}: not JSON: ${line.slice(0, 120)}`); }
      const w = this.waiting.get(msg.id);
      if (w) { this.waiting.delete(msg.id); w.resolve(msg); }
    });
  }

  /** Send one request (or a notification when `id` is null) to the child; resolve with its reply. */
  request(method, params, { timeout = 60_000 } = {}) {
    this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${this.name}: no answer to ${method} within ${timeout} ms`)); }, timeout);
      this.waiting.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) { this.start(); this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }

  /** Initialise once (the child sees one client: the gateway), and remember the tools it offers. */
  async ready() {
    if (!this.initialized) {
      this.initialized = (async () => {
        const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'omni-gateway', version: '0.2.0' } });
        if (init.error) throw new Error(`${this.name}: initialize: ${init.error.message}`);
        this.notify('notifications/initialized', {});
        const list = await this.request('tools/list', {});
        this.tools = list.result?.tools ?? [];
        return init.result;
      })();
      this.initialized.catch(() => { this.initialized = null; });
    }
    return this.initialized;
  }

  stop() { if (this.child) { this.child.kill(); this.child = null; } }
}

const readToken = (spec) => (spec.tokenFile ? fs.readFileSync(spec.tokenFile, 'utf8').trim() : spec.token);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * createGateway({members, log}): an http.Server. Routes:
 *   GET  /health                 {"ok":true,"members":[...]} (no token)
 *   POST /mcp/NAME               one JSON-RPC message; Authorization: Bearer TOKEN (that member's); answers JSON
 *   GET  /mcp/NAME               405 (no server-to-client stream here; the hub does not need one)
 * initialize is answered by the gateway itself (the child was initialised once); every other request goes to the
 * child and comes back as its answer, with the caller's id. Notifications get 202 and nothing else.
 */
export function createGateway({ members, log = () => {}, spawnFn, readTokenFn = readToken, memberFactory }) {
  const live = new Map();
  const member = (name) => {
    if (!live.has(name)) live.set(name, memberFactory ? memberFactory(name, members[name]) : new Member(name, members[name], { spawnFn, log }));
    return live.get(name);
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true, members: Object.keys(members) });
    const m = /^\/mcp\/([a-z][a-z0-9_-]*)$/.exec(url.pathname);
    if (!m) return send(404, { error: 'no such path' });
    const name = m[1];
    if (!members[name]) return send(404, { error: `no member named ${name}` });
    if (req.method !== 'POST') return send(405, { error: 'POST one JSON-RPC message' }, { allow: 'POST' });
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    let token; try { token = readTokenFn(members[name]); } catch (err) { return send(500, { error: `token for ${name} unreadable: ${err.message}` }); }
    if (!auth || !same(auth[1], token)) return send(401, { error: 'bearer token missing or wrong' }, { 'www-authenticate': 'Bearer' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) return send(413, { error: 'too big' }); }
    let msg; try { msg = JSON.parse(body); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC object per POST' } });
    const mem = member(name);
    try {
      if (msg.method === 'initialize') {
        const init = await mem.ready();
        return send(200, { jsonrpc: '2.0', id: msg.id, result: { ...init, serverInfo: { name: `omni-gateway/${name}`, version: '0.2.0', upstream: init.serverInfo } } });
      }
      if (msg.id === undefined || msg.id === null) { if (msg.method !== 'notifications/initialized') mem.notify(msg.method, msg.params); return send(202); }
      await mem.ready();
      const reply = await mem.request(msg.method, msg.params ?? {});
      return send(200, { ...reply, id: msg.id });
    } catch (err) {
      log(`${name}: ${err.message}`);
      return send(502, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: err.message } });
    }
  });
  server.stopMembers = () => { for (const m of live.values()) m.stop(); };
  server.members = live;
  return server;
}
