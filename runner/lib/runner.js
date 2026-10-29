// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The runner loop: claim a job, run it in the configured backend, stream its
// log, report the result. Several jobs may run at once (--concurrency).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as processBackend from './backends/process.js';
import * as bcontainBackend from './backends/bcontain.js';
import { prepare, readOutput } from './script.js';

export const BACKENDS = { process: processBackend, bcontain: bcontainBackend };

export class RunnerClient {
  constructor({ server, token, version }) {
    Object.assign(this, { server: server.replace(/\/$/, ''), token, version });
  }

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

  register(body) { return this.call('POST', '/api/v1/runner/register', { body }); }
  claim(waitMs) { return this.call('POST', '/api/v1/runner/claim', { body: { wait_ms: waitMs } }); }
  source(id, jobToken) { return this.call('GET', `/api/v1/runner/jobs/${id}/source`, { raw: true, jobToken }); }
  log(id, jobToken, text) { return this.call('POST', `/api/v1/runner/jobs/${id}/log`, { body: text, contentType: 'text/plain; charset=utf-8', jobToken }); }
  complete(id, jobToken, body) { return this.call('POST', `/api/v1/runner/jobs/${id}/complete`, { body, jobToken }); }
}

/** Run one claimed job end to end. Never throws: failures are reported to the server. */
export async function executeJob(client, config, { job, job_token: jobToken }, say = () => {}) {
  const backend = BACKENDS[config.backend];
  const workdir = fs.mkdtempSync(path.join(config.workRoot ?? os.tmpdir(), `gitcha-${job.id}-`));
  let pending = '';
  let partial = '';
  // Stream the CI log line by line, with our markers turned into readable headings.
  const take = (s) => {
    const lines = (partial + s).split('\n');
    partial = lines.pop();
    if (lines.length) pending += readOutput(lines.join('\n'), 0).log + '\n';
  };
  // The server keeps no more than a quarter of a megabyte per log call, so send in small pieces, keep what a failed call
  // carried for the next try, and treat "this job is already over" (cancelled, timed out) as an order to stop.
  const stopper = new AbortController();
  let ticks = 0;
  const PIECE = 16 * 1024; // characters, so at most 64 KiB on the wire
  let sending = null;
  const flush = () => (sending ??= sendPending().finally(() => { sending = null; })); // one call at a time
  const sendPending = async () => {
    if (stopper.signal.aborted) return;
    if (!pending) {
      // Silence still has to ask once in a while, or a cancelled build would run to its timeout unnoticed.
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
      cpus: config.cpus, memoryMb: job.kind === 'fn' ? Math.min(job.spec.fn.memoryMb, config.memoryMb ?? job.spec.fn.memoryMb) : config.memoryMb, // never above the operator's own cap
      onOutput: job.kind === 'ci' ? take : null, signal: stopper.signal,
    });
    if (stopper.signal.aborted) { say(`job ${job.id} was ended by the server; stopped`); return; }
    const parsed = readOutput(result.output, result.code);
    if (job.kind === 'ci') {
      if (partial) take('\n');
      await flush();
      while (pending && !stopper.signal.aborted) { const before = pending.length; await flush(); if (pending.length === before) break; }
      const ok = !result.timedOut && parsed.exitCode === 0;
      const artifactFile = path.join(workdir, 'artifact.tgz');
      const artifact = ok && fs.existsSync(artifactFile) ? fs.readFileSync(artifactFile).toString('base64') : null;
      await client.log(job.id, jobToken, `\n${result.timedOut ? '[gitcha-runner] the job ran out of time\n' : ''}[gitcha-runner] exit code ${parsed.exitCode}\n`).catch(() => {});
      await client.complete(job.id, jobToken, { status: result.timedOut ? 'timed_out' : ok ? 'succeeded' : 'failed', exit_code: parsed.exitCode, artifact });
    } else {
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

/** Claim and run jobs until stopped. */
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
