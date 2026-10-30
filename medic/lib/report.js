// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The report: findings and actions in plain words, for a terminal, a chat room or a log line.
import { remedyOf } from './remedies.js';
import { headline } from './rules.js';

const MARK = { bad: 'PROBLEM', warn: 'WARNING', info: 'note', ok: 'ok' };

/** The full report, as text a person reads top to bottom. */
export function render({ facts, findings, actions = [], agent = null, config = {} }) {
  const lines = [];
  lines.push(`gitcha-medic ${config.identity ?? ''} ${facts.at}`.trim());
  lines.push(headline(findings, facts));
  lines.push('');
  for (const x of findings) {
    lines.push(`${MARK[x.level].padEnd(8)} ${x.what}`);
    lines.push(`         because: ${x.why}`);
    if (x.remedy && x.level !== 'ok') {
      const r = remedyOf(x.remedy);
      const did = actions.find((a) => a.name === x.remedy);
      if (did?.ran) lines.push(`         done (${r.class}): ${r.title}: ${did.ok ? 'ok' : `FAILED ${did.err || did.out}`}`);
      else if (did?.parked) lines.push(`         parked (${r.class}): ${r.title}; ${did.parked}`);
      else if (r.class === 'safe') lines.push(`         remedy (safe, runs with --heal or GITCHA_MEDIC_HEAL=safe): ${r.title}: ${r.how}`);
      else if (r.class === 'confirm') lines.push(`         remedy (needs your yes: sudo gitcha-medic --yes ${x.remedy}): ${r.title}.\n           ${r.how}`);
      else lines.push(`         by hand: ${r.title}.\n           ${r.how.replace(/\n/g, '\n           ')}`);
    }
  }
  if (agent) {
    lines.push('');
    lines.push(`agent (${agent.vendor}${agent.model ? `, ${agent.model}` : ''}): ${agent.summary || agent.error || '(nothing said)'}`);
    for (const a of agent.actions ?? []) lines.push(`  asked for ${a.name}: ${a.ran ? (a.ok ? 'ran, ok' : `ran, failed: ${a.err}`) : `parked: ${a.parked}`}`);
  }
  const facing = facts.gitcha?.settings ?? {};
  lines.push('');
  lines.push(`watching: gitcha ${facing.host}:${facing.port} (${facing.publicUrl || 'no public URL'}), store ${facing.store}${facing.store === 'cassandra' ? ` at ${(facing.contactPoints ?? []).map((p) => `${p.host}:${p.port}`).join(', ')}, keyspace ${facing.keyspace}, instance ${facing.instance}` : ''}`);
  return lines.join('\n');
}

/** A few lines for a chat room: the headline, each problem, and what was done or is waiting on a person. */
export function brief({ facts, findings, actions = [], agent = null }) {
  const out = [headline(findings, facts)];
  for (const x of findings.filter((y) => y.level === 'bad' || y.level === 'warn')) {
    const did = actions.find((a) => a.name === x.remedy);
    let tail = '';
    if (did?.ran) tail = did.ok ? ` [${x.remedy}: done]` : ` [${x.remedy}: FAILED]`;
    else if (did?.parked) tail = ` [${x.remedy}: ${did.parked}]`;
    else if (x.remedy && remedyOf(x.remedy).class === 'confirm') tail = ` [waiting on a person: sudo gitcha-medic --yes ${x.remedy}]`;
    out.push(`- ${x.what}${tail}`);
  }
  if (agent?.summary) out.push(`agent: ${agent.summary}`);
  return out.join('\n');
}

/** The machine-readable form (gitcha-medic --json). */
export function toJSON({ facts, findings, actions = [], agent = null }) {
  return { at: facts.at, host: facts.host, headline: headline(findings, facts), findings, actions, agent, facts };
}
