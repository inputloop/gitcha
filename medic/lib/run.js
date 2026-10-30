// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// One way to run a program and read what it said. Every probe and remedy goes through a runner made here, so
// the tests can hand in a stand-in that answers from a table instead of touching systemd or Cassandra.
import { execFile } from 'node:child_process';

/**
 * makeRunner(): a function run(cmd, args, {timeout, input}) that resolves to {code, out, err} and never throws.
 * A missing program gives code 127; a timeout gives code 124 (as the timeout(1) command does).
 */
export function makeRunner({ exec = execFile } = {}) {
  return (cmd, args = [], { timeout = 20_000, input, env } = {}) => new Promise((resolve) => {
    let child;
    try {
      child = exec(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: env ?? process.env, encoding: 'utf8' }, (err, out, errOut) => {
        if (!err) return resolve({ code: 0, out: out ?? '', err: errOut ?? '' });
        if (err.code === 'ENOENT') return resolve({ code: 127, out: '', err: `${cmd}: not found` });
        if (err.killed || err.signal === 'SIGTERM') return resolve({ code: 124, out: out ?? '', err: `${cmd}: no answer within ${timeout} ms` });
        resolve({ code: typeof err.code === 'number' ? err.code : 1, out: out ?? '', err: errOut || err.message });
      });
    } catch (err) {
      return resolve({ code: 127, out: '', err: String(err?.message ?? err) });
    }
    if (input !== undefined && child?.stdin) { child.stdin.end(input); }
  });
}

/**
 * tableRunner(table): a runner for tests. `table` maps "cmd arg arg..." (joined by one space) to {code, out, err},
 * a string (its stdout, code 0), or a function of (cmd, args). Anything not in the table answers code 127.
 * Every call is recorded in runner.calls, so a test can say what was and was not run.
 */
export function tableRunner(table = {}) {
  const runner = async (cmd, args = []) => {
    const key = [cmd, ...args].join(' ');
    runner.calls.push(key);
    let hit = table[key] ?? table[cmd];
    if (typeof hit === 'function') hit = await hit(cmd, args);
    if (hit === undefined) return { code: 127, out: '', err: `${cmd}: not found` };
    if (typeof hit === 'string') return { code: 0, out: hit, err: '' };
    return { code: hit.code ?? 0, out: hit.out ?? '', err: hit.err ?? '' };
  };
  runner.calls = [];
  return runner;
}
