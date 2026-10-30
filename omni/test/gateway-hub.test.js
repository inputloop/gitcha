// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// End to end: two stand-in stdio servers behind a gateway on 127.0.0.1, a hub in front of it, calls through the
// hub's MCP face. Tokens, clashes, errors, and that nothing but the members file decides what the gateway runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, readMembers } from '../lib/gateway.js';
import { buildHub } from '../lib/hub.js';
import { readRoster } from '../lib/remote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const standin = path.join(here, 'standin-server.mjs');
const members = {
  seat: { command: [process.execPath, standin], env: { STANDIN_NAME: 'seat' }, token: 'seat-token' },
  tavern: { command: [process.execPath, standin], env: { STANDIN_NAME: 'tavern' }, token: 'tavern-token' },
  broken: { command: [process.execPath, '-e', 'process.exit(3)'], token: 'x' },
};
let gateway; let base; const logs = [];
before(async () => {
  gateway = createGateway({ members, log: (s) => logs.push(s) });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});
after(async () => { gateway.stopMembers(); await new Promise((r) => gateway.close(r)); });

const post = (name, token, body) => fetch(`${base}/mcp/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('gateway: health needs no token; a member needs its own; wrong or missing is 401; an unknown member is 404', async () => {
  const h = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(h, { ok: true, members: ['seat', 'tavern', 'broken'] });
  assert.equal((await post('seat', null, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await post('seat', 'tavern-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'another member\'s token does not open this one');
  assert.equal((await post('nobody', 'seat-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
  assert.equal((await fetch(`${base}/mcp/seat`)).status, 405);
  const ok = await post('seat', 'seat-token', { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(ok.status, 200);
  const init = await ok.json();
  assert.equal(init.id, 7);
  assert.equal(init.result.serverInfo.name, 'omni-gateway/seat');
  assert.equal(init.result.serverInfo.upstream.name, 'standin-seat');
});

test('gateway: a member whose program dies answers 502 with the reason, and the others are unaffected', async () => {
  const r = await post('broken', 'x', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /exited \(3\)|no answer/);
  const ok = await post('tavern', 'tavern-token', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(ok.status, 200);
});

test('hub: reaches the members, offers their tools under the first claimant, carries a call and its answer, reports the one that is down', async () => {
  const rosterText = JSON.stringify({ members: {
    seat: { url: `${base}/mcp/seat`, tokenEnv: 'OMNI_TOKEN_SEAT' },
    tavern: { url: `${base}/mcp/tavern`, tokenEnv: 'OMNI_TOKEN_TAVERN' },
    broken: { url: `${base}/mcp/broken`, tokenEnv: 'OMNI_TOKEN_BROKEN' },
    gone: { url: 'http://127.0.0.1:9/mcp/gone', tokenEnv: 'OMNI_TOKEN_GONE' },
    silent: { url: `${base}/mcp/seat`, tokenEnv: 'OMNI_TOKEN_UNSET' },
  } });
  const env = { OMNI_TOKEN_SEAT: 'seat-token', OMNI_TOKEN_TAVERN: 'tavern-token', OMNI_TOKEN_BROKEN: 'x', OMNI_TOKEN_GONE: 'y' };
  const out = [];
  const hub = await buildHub({ rosterText, env, output: { write: (s) => out.push(JSON.parse(s)) } });
  const st = hub.status();
  const by = Object.fromEntries(st.members.map((m) => [m.name, m]));
  assert.equal(by.seat.reached, true); assert.equal(by.seat.tools, 3);
  assert.equal(by.tavern.reached, true);
  assert.equal(by.broken.reached, false); assert.match(by.broken.error, /exited|no answer/);
  assert.equal(by.gone.reached, false); assert.match(by.gone.error, /cannot reach/);
  assert.equal(by.silent.reached, false); assert.match(by.silent.error, /no token.*OMNI_TOKEN_UNSET/);
  assert.deepEqual(st.clashes.map((c) => c.split(':')[0]).sort(), ['boom', 'note_list', 'note_write'], 'tavern offered the same three names; seat keeps them');
  // Through the MCP face: tools/list has the hub's own tools and the members' (once each).
  await hub.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = out.at(-1).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['omni_status', 'omni_reach', 'skill_list', 'skill_read', 'note_write', 'note_list', 'boom']);
  assert.match(out.at(-1).result.tools.find((t) => t.name === 'note_write').description, /^\[seat\] write a note/);
  // A call goes to seat and comes back; a second session's call too (the gateway serialises per member).
  await hub.server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'note_write', arguments: { text: 'first' } } });
  assert.deepEqual(out.at(-1).result, { content: [{ type: 'text', text: 'seat: wrote generation 1' }] });
  await Promise.all([3, 4, 5].map((id) => hub.server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'note_write', arguments: { text: `n${id}` } } })));
  await hub.server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'note_list', arguments: {} } });
  assert.deepEqual(out.at(-1).result.content[0].text.split('\n').sort(), ['first', 'n3', 'n4', 'n5']);
  // A member's tool error comes back as the member gave it (isError), not as a hub crash.
  await hub.server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(out.at(-1).result.isError, true);
  assert.match(out.at(-1).result.content[0].text, /as asked/);
  // Bad arguments are refused by the hub before any network call.
  await hub.server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'note_write', arguments: { text: 5 } } });
  assert.match(out.at(-1).error.message, /Invalid arguments/);
  // The receipt line.
  await hub.server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'omni_reach', arguments: {} } });
  assert.match(out.at(-1).result.content[0].text, /^omni reach \S+: up seat, tavern; down broken \(.*\), gone \(.*\), silent \(.*\); skills none$/);
});

test('hub: with no roster at all it still serves its own tools and says so in the instructions', async () => {
  const out = [];
  const hub = await buildHub({ output: { write: (s) => out.push(JSON.parse(s)) } });
  await hub.server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.match(out.at(-1).result.instructions, /no members in the roster/);
  await hub.server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(out.at(-1).result.tools.length, 4);
});

test('readMembers and readRoster refuse the shapes that would be mistakes', () => {
  assert.throws(() => readMembers('/x', { readFile: () => JSON.stringify({ members: { Seat: { command: ['a'], token: 't' } } }) }), /lower-case/);
  assert.throws(() => readMembers('/x', { readFile: () => JSON.stringify({ members: { seat: { command: [], token: 't' } } }) }), /command/);
  assert.throws(() => readMembers('/x', { readFile: () => JSON.stringify({ members: { seat: { command: ['a'] } } }) }), /tokenFile/);
  assert.throws(() => readRoster(JSON.stringify({ members: { seat: { url: 'ftp://x', tokenEnv: 'T' } } })), /http/);
  assert.throws(() => readRoster(JSON.stringify({ members: { seat: { url: 'https://x' } } })), /tokenEnv/);
  assert.deepEqual(Object.keys(readRoster('{"members":{"a":{"url":"https://x/mcp/a","tokenEnv":"T"}}}')), ['a']);
});
