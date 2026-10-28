// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Gitcha function harness for runtime "node". Runs inside the sandbox.
// usage: node node.mjs ENTRY REQUEST.json
// The handler is the module's default export (or `handler`). It receives a
// request and returns a string, an object { status, headers, body }, or any
// JSON value. The response leaves on one marker line on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = '@@GITCHA-RESPONSE@@';
const [entry, reqFile] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
const body = Buffer.from(raw.body ?? '', 'base64');
const request = {
  method: raw.method ?? 'GET', path: raw.path ?? '/', query: raw.query ?? {}, headers: raw.headers ?? {},
  body: body.toString('utf8'), bodyBase64: raw.body ?? '',
  json() { return body.length ? JSON.parse(body.toString('utf8')) : null; },
};

function emit(res) {
  process.stdout.write(`\n${MARK} ${Buffer.from(JSON.stringify(res)).toString('base64')}\n`);
}

function toResponse(out) {
  if (out === undefined || out === null) return { status: 204, headers: {}, body: '' };
  if (typeof out === 'string') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: out };
  if (Buffer.isBuffer(out)) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: out.toString('base64'), bodyEncoding: 'base64' };
  if (typeof out === 'object' && ('status' in out || 'body' in out) && !Array.isArray(out)) {
    const b = out.body;
    if (Buffer.isBuffer(b)) return { status: out.status ?? 200, headers: out.headers ?? {}, body: b.toString('base64'), bodyEncoding: 'base64' };
    if (typeof b === 'string' || b === undefined) return { status: out.status ?? 200, headers: out.headers ?? {}, body: b ?? '' };
    return { status: out.status ?? 200, headers: { 'content-type': 'application/json', ...(out.headers ?? {}) }, body: JSON.stringify(b) };
  }
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) };
}

try {
  const mod = await import(pathToFileURL(path.resolve(entry)).href);
  const handler = mod.default ?? mod.handler;
  if (typeof handler !== 'function') throw new Error(`${entry} exports no default function or "handler"`);
  emit(toResponse(await handler(request)));
} catch (err) {
  console.error(err?.stack ?? String(err));
  emit({ status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'The function threw an error.\n', error: String(err?.message ?? err).slice(0, 500) });
  process.exitCode = 1;
}
