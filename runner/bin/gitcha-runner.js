#!/usr/bin/env node
// gitcha-runner: runs CI jobs and lambda functions for a Gitcha server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerClient, loop, BACKENDS } from '../lib/runner.js';
import { command as bcontainCommand } from '../lib/backends/bcontain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const home = process.env.GITCHA_RUNNER_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'gitcha-runner');
const configFile = path.join(home, 'runner.json');

const HELP = `gitcha-runner v${VERSION}: runs CI jobs and functions for a Gitcha server

  gitcha-runner register --server URL --token REGISTRATION_TOKEN --name NAME
                         [--labels a,b] [--capabilities ci,fn] [--backend bcontain|process]
  gitcha-runner run [--once] [--concurrency N]
  gitcha-runner status
  gitcha-runner bcontain-command      show the bContain command a job would use

Registration tokens come from the Gitcha web UI or API (admins: instance-wide;
team owners: for their team). The runner token is saved in ${configFile} (mode 600).

Backends:
  bcontain  each job in its own throwaway VM via inputloop/bContain (default; use this)
  process   a plain child process, NO isolation; refused unless GITCHA_RUNNER_UNSAFE_PROCESS=1

Environment: GITCHA_RUNNER_HOME, BCONTAIN_BIN, BCONTAIN_HOME, GITCHA_ORGVM_CMD (enables the orgvm label)`;

function args(argv) {
  const out = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (['once', 'help'].includes(k) || !argv[i + 1] || argv[i + 1].startsWith('--')) out.f[k] = true;
      else out.f[k] = argv[++i];
    } else out._.push(argv[i]);
  }
  return out;
}

function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {
    throw new Error(`Not registered yet. Run: gitcha-runner register --server URL --token TOKEN --name NAME`);
  }
  return {
    concurrency: 1, cpus: 2, memoryMb: 2048, defaultImage: 'docker.io/library/node:22-alpine', ...c,
    unsafeProcess: process.env.GITCHA_RUNNER_UNSAFE_PROCESS === '1',
    bcontainBin: process.env.BCONTAIN_BIN ?? c.bcontainBin ?? 'bcontain',
    bcontainHome: process.env.BCONTAIN_HOME ?? c.bcontainHome,
  };
}

async function main() {
  const { _, f } = args(process.argv.slice(2));
  const cmd = _[0];
  if (!cmd || f.help) return console.log(HELP);
  if (cmd === 'register') {
    for (const k of ['server', 'token', 'name']) if (typeof f[k] !== 'string') throw new Error(`--${k} is required`);
    const backend = f.backend ?? 'bcontain';
    if (!BACKENDS[backend]) throw new Error(`Unknown backend "${backend}".`);
    const labels = String(f.labels ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (process.env.GITCHA_ORGVM_CMD && !labels.includes('orgvm')) labels.push('orgvm');
    const client = new RunnerClient({ server: f.server, version: VERSION });
    const r = await client.register({
      token: f.token, name: f.name, labels, backend, version: VERSION,
      capabilities: String(f.capabilities ?? 'ci,fn').split(',').map((s) => s.trim()),
    });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile, JSON.stringify({ server: f.server, id: r.id, token: r.token, name: f.name, backend, labels, scope: r.scope }, null, 2) + '\n', { mode: 0o600 });
    return console.log(`registered runner ${f.name} (${r.id}), scope ${r.scope.type === 'team' ? `team ${r.scope.name}` : 'instance'}, backend ${backend}\nconfig: ${configFile}`);
  }
  if (cmd === 'status') {
    const c = loadConfig();
    return console.log(`runner ${c.name} (${c.id}) for ${c.server}\nbackend ${c.backend}, labels ${c.labels.join(',') || '(none)'}`);
  }
  if (cmd === 'bcontain-command') {
    return console.log(bcontainCommand({ image: 'IMAGE', cpus: 2, memoryMb: 2048, port: 'PORT', token: 'TOKEN' }).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
  }
  if (cmd === 'run') {
    const c = loadConfig();
    if (f.concurrency) c.concurrency = Math.max(1, Number(f.concurrency));
    if (c.backend === 'process') console.error('gitcha-runner: WARNING: the process backend gives jobs NO isolation.');
    const client = new RunnerClient({ server: c.server, token: c.token, version: VERSION });
    const ac = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
    console.log(`gitcha-runner ${c.name}: waiting for jobs from ${c.server} (${c.backend})`);
    return loop(client, c, { once: Boolean(f.once), signal: ac.signal, say: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
  }
  throw new Error(`Unknown command "${cmd}". Run gitcha-runner --help.`);
}

main().catch((err) => { console.error(`gitcha-runner: ${err.message}`); process.exitCode = 1; });
