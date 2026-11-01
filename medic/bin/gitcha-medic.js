#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// gitcha-medic: look at Gitcha, its Cassandra and its proxy here; say what is wrong and why; mend what is safe when asked;
// park the rest for a person; tell syslog and the configured rooms.
//
//   sudo gitcha-medic                 look, and say (exit 0: all well; 1: something is wrong; 2: usage)
//   sudo gitcha-medic --heal          also run the safe remedies (start a stopped service, restart a stuck one)
//   sudo gitcha-medic --ask           also consult the configured agent (GITCHA_MEDIC_AGENT), which may ask for safe remedies
//   sudo gitcha-medic --yes NAME      run one confirm-class remedy, after you have read what it does (--list says)
//   sudo gitcha-medic --list          the remedies and their classes
//   sudo gitcha-medic --json          the facts and findings as JSON (for C4OK or another program)
//   sudo gitcha-medic --quiet         rooms hear only a change, or a heartbeat every GITCHA_MEDIC_REPEAT (the timer's mode)
//   sudo gitcha-medic --no-channels   say nothing anywhere but here
// The timer (gitcha-medic.timer) runs: gitcha-medic --quiet --heal --ask    (--heal and --ask only as medic.env allows).
import fs from 'node:fs';
import path from 'node:path';
import { gitchaSettings, loadMedicEnv, medicConfig, readEnvFiles, redact } from '../lib/config.js';
import { defaultIo, gather } from '../lib/probes.js';
import { diagnose, digest, headline } from '../lib/rules.js';
import { apply, REMEDIES } from '../lib/remedies.js';
import { brief, render, toJSON } from '../lib/report.js';
import { announce } from '../lib/channels.js';
import { consult } from '../lib/agent.js';
import { makeRunner } from '../lib/run.js';

const usage = () => fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => /^\/\/ {3}sudo gitcha-medic|^\/\/ gitcha-medic:/.test(l)).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--') && a !== '--yes'));
const yes = args.includes('--yes') ? args[args.indexOf('--yes') + 1] : null;
const known = new Set(['--heal', '--ask', '--list', '--json', '--quiet', '--no-channels', '--help', '-h']);
for (const f of flags) if (!known.has(f)) { console.error(`gitcha-medic: unknown option ${f}\n${usage()}`); process.exit(2); }
if (flags.has('--help') || flags.has('-h')) { console.log(usage()); process.exit(0); }
if (args.includes('--yes') && !yes) { console.error('gitcha-medic: --yes needs a remedy name (--list)'); process.exit(2); }

if (flags.has('--list')) {
  for (const [name, r] of Object.entries(REMEDIES)) console.log(`${name.padEnd(28)} ${r.class.padEnd(8)} ${r.title}\n${' '.repeat(37)}${r.how.replace(/\n/g, `\n${' '.repeat(37)}`)}`);
  process.exit(0);
}

const env = loadMedicEnv();
const config = medicConfig(env);
const heal = flags.has('--heal') || (flags.has('--quiet') && config.heal === 'safe');
const ask = flags.has('--ask') || (flags.has('--quiet') && config.agent.vendor !== 'none');
for (const w of config.warnings) console.error(`gitcha-medic: ${w}`);
if (process.getuid?.() !== 0) console.error('gitcha-medic: not root: journals, gitcha.env and remedies need root, so the picture will have holes (sudo gitcha-medic)');

const settings = gitchaSettings(readEnvFiles(config.gitchaEnvFiles));
const run = makeRunner();
const io = defaultIo(run);
Object.assign(io, { mkdir: (p) => fs.mkdirSync(p, { recursive: true }), rename: (a, b) => fs.renameSync(a, b) });

if (yes) {
  const r = REMEDIES[yes];
  if (!r) { console.error(`gitcha-medic: no remedy named ${yes} (--list)`); process.exit(2); }
  if (r.class === 'manual') { console.error(`gitcha-medic: ${yes} is for hands only:\n${r.how}`); process.exit(2); }
  console.log(`gitcha-medic: ${r.title}\n${r.how}`);
  const got = await apply(yes, { run, io }, { allow: 'confirm' });
  console.log(got.ok ? `done: ${got.out || 'ok'}` : `FAILED: ${got.err || got.out}`);
  await run('logger', ['-t', 'gitcha-medic', '-p', got.ok ? 'daemon.notice' : 'daemon.err', `${config.identity} a person ran ${yes}: ${got.ok ? 'ok' : `failed: ${got.err}`}`]);
  process.exit(got.ok ? 0 : 1);
}

let facts = await gather(settings, io);
let findings = diagnose(facts);
const actions = [];
if (heal) {
  for (const x of findings) {
    if (x.level === 'ok' || !x.remedy || REMEDIES[x.remedy]?.class !== 'safe' || x.remedy === 'wait') continue;
    actions.push(await apply(x.remedy, { run, io }, { allow: 'safe' }));
  }
  if (actions.some((a) => a.ran)) {
    // Look again, so the report says how things stand after the mending, not before.
    await new Promise((r) => setTimeout(r, 3000));
    facts = await gather(settings, io);
    findings = diagnose(facts);
  }
}
let agent = null;
if (ask) {
  const reprobe = async (name) => { const f = await gather(settings, io); return f[name] ?? { error: `no probe named ${name}` }; };
  agent = await consult({ config, facts, findings, reprobe, run, io });
  if (agent?.actions?.some((a) => a.ran)) { facts = await gather(settings, io); findings = diagnose(facts); }
  if (agent?.error) console.error(`gitcha-medic: agent: ${agent.error}`);
}

const everything = { facts, findings, actions, agent: agent ? { ...agent, actions: agent.actions } : null, config };
if (flags.has('--json')) console.log(JSON.stringify(redact(toJSON(everything)), null, 2));
else console.log(render(everything));

if (!flags.has('--no-channels')) {
  const worst = findings.some((x) => x.level === 'bad') ? 'bad' : findings.some((x) => x.level === 'warn') ? 'warn' : 'ok';
  const message = { headline: headline(findings, facts), brief: brief(everything), findings: redact(findings), worst, at: facts.at };
  // --quiet: syslog every time; the rooms only when the picture changed, or at the heartbeat interval.
  let channels = config.channels;
  const statePath = path.join(config.stateDir, 'last.json');
  if (flags.has('--quiet')) {
    let last = {};
    try { last = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
    const now = digest(findings);
    const changed = last.digest !== now;
    const due = !last.toldAt || Date.now() - Date.parse(last.toldAt) > config.repeat;
    const acted = actions.some((a) => a.ran) || agent?.actions?.some((a) => a.ran);
    if (!changed && !due && !acted) channels = channels.filter((c) => c === 'syslog');
    try { fs.mkdirSync(config.stateDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ digest: now, at: facts.at, toldAt: channels.length > 1 || changed ? facts.at : last.toldAt ?? facts.at })); }
    catch (err) { console.error(`gitcha-medic: could not keep state in ${statePath}: ${err.message}`); }
  }
  const rows = await announce({ ...config, channels }, message, { run });
  for (const r of rows) if (!r.ok) console.error(`gitcha-medic: ${r.channel}: ${r.said}`);
}
process.exit(findings.some((x) => x.level === 'bad') ? 1 : 0);
