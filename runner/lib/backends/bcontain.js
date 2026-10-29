// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The bContain backend runs each job in its own throwaway VM (virtual machine: a separate computer
// made in software) with `bcontain run IMAGE ... -- sh -c BOOTSTRAP` (inputloop/bContain).
// This is the default backend and the one that keeps jobs isolated.
//
// bContain has no volume mounts (no way to share a folder with the VM). So the job folder travels
// over the VM's user-mode network. The runner serves it on 127.0.0.1 behind a one-time token.
// The guest (the VM) reaches the host at 10.0.2.2 (QEMU's user-mode gateway address), downloads it,
// runs run.sh, and posts any artifact (a file the job produced) back the same way.
//
// Limits that come from bContain today (see its README): the image needs /bin/sh and wget
// (busybox images have both). Everything runs as root inside the VM. The guest can reach the
// outside network (there is no network-off switch yet). There is no disk quota.
// The VM, not the network, is what keeps the job isolated.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { packFiles } from '../../../extension/lib/tar.js';

export const name = 'bcontain';
export const GUEST_HOST = '10.0.2.2';

export function assertAllowed() { /* always allowed: this is the isolating backend */ }

// List every regular file under `dir` with its bytes. Paths use "/" on every platform.
// Links are skipped (only real folders and files are taken).
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push({ path: path.relative(base, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
  }
  return out;
}

/**
 * The exact argv (list of command-line words) handed to bcontain. Exported for tests and for
 * `gitcha-runner bcontain-command`. Inside the VM, the bootstrap script downloads the bundle,
 * unpacks it in /job and runs /job/package/run.sh.
 */
export function command({ bin = 'bcontain', image, cpus = 1, memoryMb = 512, port, token }) {
  // The image name comes from a job. A name that starts with "-" would be read as an option by the
  // launcher, so only plain image names are allowed (up to 200 characters).
  if (!/^[A-Za-z0-9][\w./:@-]{0,199}$/.test(String(image))) throw new Error(`refusing image "${String(image).slice(0, 60)}": not a plain image reference`);
  const base = `http://${GUEST_HOST}:${port}/${token}`;
  const bootstrap = `set -e; mkdir -p /job; cd /job; wget -q -O b.tgz ${base}/bundle.tgz; tar xzf b.tgz; rm b.tgz; exec sh /job/package/run.sh`;
  return [bin, 'run', image, '--cpus', String(cpus), '--memory', `${memoryMb}M`, '--display', 'headless',
    '-e', 'GITCHA_JOB=/job/package', '-e', `GITCHA_UPLOAD=${base}/artifact`, '--', 'sh', '-c', bootstrap];
}

/**
 * A tiny web server for one job, on loopback (127.0.0.1, reachable only from this machine and its VMs).
 * It serves the bundle and accepts the artifact. Both URLs start with the secret token.
 * An artifact bigger than maxArtifact is cut off and deleted.
 */
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

// Run one job: pack the job folder, start the file server, boot the VM, and collect its output.
// Resolves { code, output, timedOut }.
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
      // bContain boots a VM, so allow extra time for the boot (60 seconds by default) on top of the job's own limit.
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs + (config.bootAllowanceMs ?? 60_000));
      const stop = () => child.kill('SIGKILL'); // the server said this job is over (cancelled)
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
      child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ code: code ?? 137, output, timedOut }); });
    });
  } finally {
    server.close();
  }
}
