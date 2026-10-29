// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Shared set-up for the social, GraphQL and operations tests: a server, a few
// signed-in people, a GraphQL caller and (for the tests that push) real git.
// At most five people per server: the sign-up limiter allows five an hour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer, createUser, deviceLogin } from './helpers.js';

const run = promisify(execFile);

export const ok = (r) => { assert.equal(r.errors, undefined, JSON.stringify(r.errors)); return r.data; };
export const code = (r) => r.errors?.[0]?.extensions?.code ?? r.error;

/** A server and the named people, each with a device token. `tokens[name]` is the bearer token. */
export async function startSocial({ people = ['alice', 'bob', 'carol'], ...opts } = {}) {
  const srv = await startServer(opts);
  const users = {};
  const tokens = {};
  try {
    people.forEach((name, i) => { users[name] = createUser(srv, name, `quiet harbour light number ${i}`); });
    for (const name of people) tokens[name] = await deviceLogin(srv, users[name]);
  } catch (err) { await srv.close(); throw err; }
  const gql = async (token, query, variables, headers = {}) => {
    const res = await fetch(`${srv.url}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    return { status: res.status, ...body };
  };
  /** Type a fresh code for a person so a sensitive action can follow (opens the ten-minute window). */
  const stepUp = async (name) => {
    const res = await fetch(`${srv.url}/api/v1/auth/step-up`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[name]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: users[name].nextCode() }) });
    assert.equal(res.status, 200);
  };
  return { srv, users, tokens, gql, stepUp };
}

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-fix-'));

// Async on purpose: the server runs in this process, so a blocking git would deadlock it.
export async function git(cwd, args, env = {}) {
  try {
    return (await run('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })).stdout;
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err.stderr || err.message}`);
  }
}

/** Commit a new file whose message ends in the agent's byline. */
export async function commit(dir, message) {
  const file = `f-${Math.random().toString(16).slice(2)}.txt`;
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  await git(dir, ['add', file]);
  await git(dir, ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

/** Push one commit to owner/name as `agent` (its owner's token is the password). */
export async function pushAs(srv, dir, { token, agent, project, byline }) {
  const port = new URL(srv.url).port;
  await commit(dir, `work\n\n${byline}`);
  await git(dir, ['push', '-q', `http://${agent}:${token}@127.0.0.1:${port}/git/${project}.git`, 'HEAD:refs/heads/main']);
}

export async function newRepo() {
  const dir = tmp();
  await git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
