// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The runner loop. It claims a job from the server, runs it in the chosen backend (bcontain or process),
// streams its log back, and reports the result. Several jobs may run at once (--concurrency).
// bin/gitcha-runner.js starts it with `gitcha-runner run`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as processBackend from './backends/process.js';
import * as bcontainBackend from './backends/bcontain.js';
import { prepare, readOutput } from './script.js';

// The ways a job can run. "bcontain" isolates each job in a VM; "process" does not isolate at all.
export const BACKENDS = { process: processBackend, bcontain: bcontainBackend };

// Talks to the server's runner API. The runner token goes in the Authorization header.
// Calls about one job also send that job's own token (X-Gitcha-Job-Token).
export class RunnerClient {
  constructor({ server, token, version }) {
    Object.assign(this, { server: server.replace(/\/$/, ''), token, version });
  }

  // Send one request. A 204 answer gives null. An error answer throws an Error that carries `status`.
  async call(method, p, { body, raw, jobToken, contentType } = {}) {
    const res = await fetch(this.server + p, {
      method,
      headers: {
        'User-Agent': `gitcha-runner/${this.version}`,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(jobToken ? { 'X-Gitcha-Job-Token': jobToken } : {}),
        ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}),
      },
      body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.message ?? msg; } catch { /* not JSON */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  // claim() asks the server to wait up to waitMs for a job (a long poll). No job gives null.
  register(body) { return this.call('POST', '/api/v1/runner/register', { body }); }
  claim(waitMs) { return this.call('POST', '/api/v1/runner/claim', { body: { wait_ms: waitMs } }); }
  source(id, jobToken) { return this.call('GET', `/api/v1/runner/jobs/${id}/source`, { raw: true, jobToken }); }
  log(id, jobToken, text) { return this.call('POST', `/api/v1/runner/jobs/${id}/log`, { body: text, contentType: 'text/plain; charset=utf-8', jobToken }); }
  complete(id, jobToken, body) { return this.call('POST', `/api/v1/runner/jobs/${id}/complete`, { body, jobToken }); }
}

/**
 * Run one claimed job from start to end: fetch its source, build the job folder, run it, send the log,
 * and report the result. It never throws: failures are reported to the server instead.
 * The job folder is deleted at the end unless config.keepWorkdirs is set.
 */
export async function executeJob(client, config, { job, job_token: jobToken }, say = () => {}) {
  const backend = BACKENDS[config.backend];
  const workdir = fs.mkdtempSync(path.join(config.workRoot ?? os.tmpdir(), `gitcha-${job.id}-`));
  let pending = '';
  let partial = '';
  // Stream the CI log line by line, with our step markers turned into readable headings.
  // `partial` holds a line that has not ended yet; `pending` holds text waiting to be sent.
  const take = (s) => {
    const lines = (partial + s).split('\n');
    partial = lines.pop();
    if (lines.length) pending += readOutput(lines.join('\n'), 0).log + '\n';
  };
  // The server keeps no more than a quarter of a megabyte per log call, so we send small pieces.
  // If a call fails, its piece is kept for the next try. If the server says "this job is already over"
  // (cancelled or timed out: HTTP 409 or 401), we take that as an order to stop the job.
  const stopper = new AbortController();
  let ticks = 0;
  const PIECE = 16 * 1024; // characters, so at most 64 KiB on the wire
  let sending = null;
  const flush = () => (sending ??= sendPending().finally(() => { sending = null; })); // one call at a time
  const sendPending = async () => {
    if (stopper.signal.aborted) return;
    if (!pending) {
      // With no new output we still check in every 5 seconds. Otherwise a cancelled build would run
      // to its timeout without anyone noticing.
      if (++ticks % 5 === 0) await client.log(job.id, jobToken, '').catch((err) => { if (err.status === 409 || err.status === 401) stopper.abort(); });
      return;
    }
    while (pending && !stopper.signal.aborted) {
      const piece = pending.slice(0, PIECE);
      try { await client.log(job.id, jobToken, piece); } catch (err) {
        if (err.status === 409 || err.status === 401) stopper.abort(); // finished on the server: nothing more to send
        return; // anything else: the piece stays in `pending` for the next tick
      }
      pending = pending.slice(piece.length);
    }
  };
  const ticker = job.kind === 'ci' ? setInterval(flush, 1000) : null;
  say(`job ${job.id} (${job.kind}) started`);
  try {
    const source = job.hasSource ? await client.source(job.id, jobToken) : null;
    prepare(workdir, job, source);
    const image = job.kind === 'ci' ? job.spec.pipeline.image : (job.spec.fn.image ?? config.defaultImage);
    const result = await backend.run({
      workdir, timeoutMs: job.timeoutMs, config, image,
      cpus: config.cpus, memoryMb: job.kind === 'fn' ? Math.min(job.spec.fn.memoryMb, config.memoryMb ?? job.spec.fn.memoryMb) : config.memoryMb, // never above the operator's own memory limit
      onOutput: job.kind === 'ci' ? take : null, signal: stopper.signal,
    });
    if (stopper.signal.aborted) { say(`job ${job.id} was ended by the server; stopped`); return; }
    const parsed = readOutput(result.output, result.code);
    if (job.kind === 'ci') {
      // Send the rest of the log, then the artifact (only for a passing build) and the final status.
      if (partial) take('\n');
      await flush();
      while (pending && !stopper.signal.aborted) { const before = pending.length; await flush(); if (pending.length === before) break; }
      const ok = !result.timedOut && parsed.exitCode === 0;
      const artifactFile = path.join(workdir, 'artifact.tgz');
      const artifact = ok && fs.existsSync(artifactFile) ? fs.readFileSync(artifactFile).toString('base64') : null;
      await client.log(job.id, jobToken, `\n${result.timedOut ? '[gitcha-runner] the job ran out of time\n' : ''}[gitcha-runner] exit code ${parsed.exitCode}\n`).catch(() => {});
      await client.complete(job.id, jobToken, { status: result.timedOut ? 'timed_out' : ok ? 'succeeded' : 'failed', exit_code: parsed.exitCode, artifact });
    } else {
      // A function sends only the last 50,000 characters of its log, then its response.
      await client.log(job.id, jobToken, parsed.log.slice(-50_000)).catch(() => {});
      if (result.timedOut) await client.complete(job.id, jobToken, { status: 'timed_out' });
      else if (parsed.response) await client.complete(job.id, jobToken, { status: 'succeeded', exit_code: parsed.exitCode, response: parsed.response });
      else await client.complete(job.id, jobToken, { status: 'failed', exit_code: parsed.exitCode, error: 'The function produced no response.' });
    }
    say(`job ${job.id} finished (exit ${parsed.exitCode}${result.timedOut ? ', timed out' : ''})`);
  } catch (err) {
    say(`job ${job.id} failed: ${err.message}`);
    await flush();
    await client.complete(job.id, jobToken, { status: 'failed', error: `runner: ${err.message}` }).catch(() => {});
  } finally {
    if (ticker) clearInterval(ticker);
    if (!config.keepWorkdirs) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Claim and run jobs until stopped (by `signal`), or after one job with `once`.
 * A failed claim waits and tries again, doubling the wait each time up to 60 seconds.
 * A 401 (token no longer accepted) ends the loop, because retrying would never work.
 */
export async function loop(client, config, { once = false, say = () => {}, signal } = {}) {
  BACKENDS[config.backend].assertAllowed(config);
  const running = new Set();
  let backoff = 1000;
  while (!signal?.aborted) {
    if (running.size >= (config.concurrency ?? 1)) {
      await Promise.race(running);
      continue;
    }
    let claimed;
    try {
      claimed = await client.claim(once ? 2000 : 25_000);
      backoff = 1000;
    } catch (err) {
      say(`claim failed: ${err.message}; retrying in ${backoff / 1000}s`);
      if (err.status === 401) throw new Error('The server no longer accepts this runner token. Register the runner again.');
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    if (!claimed) { if (once) break; continue; }
    const p = executeJob(client, config, claimed, say).finally(() => running.delete(p));
    running.add(p);
    if (once) { await p; break; }
  }
  await Promise.all(running);
}
