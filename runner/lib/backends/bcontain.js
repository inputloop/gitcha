// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The bContain backend runs each job in its own throwaway VM with
// `bcontain run IMAGE ... -- sh -c BOOTSTRAP` (inputloop/bContain).
//
// bContain has no volume mounts, so the job directory travels over the VM's
// user-mode network: the runner serves it on 127.0.0.1 behind a one-time
// token, the guest reaches the host at 10.0.2.2 (QEMU's user-mode gateway),
// downloads it, runs run.sh, and posts any artifact back the same way.
//
// Limits inherited from bContain today (see its README): the image needs
// /bin/sh and wget (busybox images have both); everything runs as root inside
// the VM; the guest has outbound network access (there is no network-off
// switch yet); no disk quota. The VM, not the network, is the isolation.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { packFiles } from '../../../extension/lib/tar.js';

export const name = 'bcontain';
export const GUEST_HOST = '10.0.2.2';

export function assertAllowed() { /* always allowed: this is the isolating backend */ }

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push({ path: path.relative(base, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
  }
  return out;
}

/** The exact argv handed to bcontain (exported for tests and `--dry-run`). */
export function command({ bin = 'bcontain', image, cpus = 1, memoryMb = 512, port, token }) {
  const base = `http://${GUEST_HOST}:${port}/${token}`;
  const bootstrap = `set -e; mkdir -p /job; cd /job; wget -q -O b.tgz ${base}/bundle.tgz; tar xzf b.tgz; rm b.tgz; exec sh /job/package/run.sh`;
  return [bin, 'run', image, '--cpus', String(cpus), '--memory', `${memoryMb}M`, '--display', 'headless',
    '-e', 'GITCHA_JOB=/job/package', '-e', `GITCHA_UPLOAD=${base}/artifact`, '--', 'sh', '-c', bootstrap];
}

/** Serve the bundle and accept the artifact, on loopback, for one job. */
function fileServer(bundle, token, artifactPath, maxArtifact) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/${token}/bundle.tgz`) {
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': bundle.length });
        return res.end(bundle);
      }
      if (req.method === 'POST' && req.url === `/${token}/artifact`) {
        const out = fs.createWriteStream(artifactPath);
        let n = 0;
        req.on('data', (c) => { n += c.length; if (n > maxArtifact) { req.destroy(); out.destroy(); fs.rmSync(artifactPath, { force: true }); } });
        req.pipe(out);
        out.on('finish', () => { res.writeHead(204); res.end(); });
        return undefined;
      }
      res.writeHead(404);
      return res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function run({ workdir, timeoutMs, onOutput, config, image, cpus, memoryMb, signal }) {
  const bundle = packFiles(walk(workdir));
  const token = crypto.randomBytes(16).toString('hex');
  const artifactPath = path.join(workdir, 'artifact.tgz');
  const server = await fileServer(bundle, token, artifactPath, config.maxArtifactBytes ?? 200 * 1024 * 1024);
  const argv = command({ bin: config.bcontainBin, image, cpus, memoryMb, port: server.address().port, token });
  try {
    return await new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(config.bcontainHome ? { BCONTAIN_HOME: config.bcontainHome } : {}) } });
      let output = '';
      let timedOut = false;
      const take = (d) => { const s = d.toString('utf8'); output += s; onOutput?.(s); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => { output += `\ngitcha-runner: could not start ${argv[0]}: ${err.message}\n`; });
      // bContain boots a VM: allow time for boot on top of the job's own limit.
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs + (config.bootAllowanceMs ?? 60_000));
      const stop = () => child.kill('SIGKILL'); // the server said this job is over (cancelled)
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
      child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ code: code ?? 137, output, timedOut }); });
    });
  } finally {
    server.close();
  }
}
