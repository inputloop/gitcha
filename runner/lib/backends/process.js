// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The process backend runs a job as a plain child process on the runner host.
// It is NOT a sandbox: the job can read anything the runner's user can. It
// exists for development and tests only, and refuses to start unless the
// operator unlocks it explicitly.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const name = 'process';

export function assertAllowed(config) {
  if (!config.unsafeProcess) {
    throw new Error('The process backend gives jobs no isolation. Use --backend bcontain, or set GITCHA_RUNNER_UNSAFE_PROCESS=1 on a throwaway machine for development.');
  }
}

/** Run workdir/run.sh. Resolves { code, output, timedOut }. */
export function run({ workdir, timeoutMs, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn('sh', [path.join(workdir, 'run.sh')], {
      cwd: workdir, detached: true,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GITCHA_JOB: workdir, ...(process.env.GITCHA_ORGVM_CMD ? { GITCHA_ORGVM_CMD: process.env.GITCHA_ORGVM_CMD } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const take = (d) => { const s = d.toString('utf8'); output += s; onOutput?.(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 137, output, timedOut });
    });
  });
}
