// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The agent step: when the rules leave something unexplained (or GITCHA_MEDIC_AGENT is set and --ask is given),
// an AI model is shown the redacted facts and findings and given three tools: probe (read one of the medic's
// probes again), remedy (ask for a remedy by name) and done (say what it concluded). The consent gate holds
// here exactly as for the medic itself: a remedy the agent asks for runs only if its class is `safe`; a `confirm`
// one is parked for a person, and the agent is told so. No secret reaches the model: everything it sees has been
// through config.redact(), and the API key is read from GITCHA_MEDIC_AGENT_KEY_FILE (mode 600) per call.
//
// Vendors: claude (the Claude API over plain HTTPS; the medic ships no npm dependencies, as the runner does).
// TODO local (an Ollama or llama-bridge endpoint on this host or the mesh), inputloop (a Mentat or Tavern resident
// reached through the Wire or a Tavern tool), openai (any /v1/chat/completions server). Each is one function with
// the shape of askClaude(); until written they say so plainly instead of pretending.
import fs from 'node:fs';
import { redact } from './config.js';
import { apply, REMEDIES } from './remedies.js';

export const TOOLS = [
  { name: 'probe', description: 'Read one of the medic\'s probes again and get its facts. Names: gitcha, cassandra, proxy, system.', input_schema: { type: 'object', properties: { name: { type: 'string', enum: ['gitcha', 'cassandra', 'proxy', 'system'] } }, required: ['name'], additionalProperties: false }, strict: true },
  { name: 'remedy', description: 'Ask the medic to run a remedy by name. Only remedies of class safe run; a confirm one is parked for a person and you are told; manual ones are for hands. Give the reason in one sentence.', input_schema: { type: 'object', properties: { name: { type: 'string', enum: Object.keys(REMEDIES) }, reason: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false }, strict: true },
  { name: 'done', description: 'Finish: say in two or three plain sentences what is wrong, what was done, and what a person should do next.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }, strict: true },
];

export const SYSTEM = [
  'You are gitcha-medic\'s second opinion on one Debian host that runs a Gitcha server (a small forge: Node, listening on loopback),',
  'an Apache Cassandra node it keeps its database in, and an nginx reverse proxy in front. You are shown the medic\'s facts and its',
  'own findings. Say what is wrong in plain words a ninth-grader follows, and only what the facts support; say when they do not.',
  'Use the probe tool to look again, the remedy tool to ask for a change by name, and done when you have a conclusion.',
  'You cannot grant consent: a remedy that moves data or edits files is parked until a person says yes, and that is right.',
  'Never ask for anything that deletes data, edits settings or touches secret.key. Be brief.',
].join(' ');

/** The API key: from the key file (read now, not kept), else the setting. Empty when there is none. */
export function readKey(agent, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  if (agent.keyFile) { try { return readFile(agent.keyFile).trim(); } catch { return ''; } }
  return agent.key || '';
}

/**
 * askClaude({config, facts, findings, tools: {probe, remedy}, fetchFn}): the Claude API, Messages endpoint, with a
 * tool loop of at most config.agent.maxRounds rounds. Returns {vendor, model, summary, actions, rounds, error?}.
 */
export async function askClaude({ config, facts, findings, callTool, fetchFn = fetch, readFile }) {
  const a = config.agent;
  const key = readKey(a, readFile);
  if (!key) return { vendor: 'claude', model: a.model, summary: '', actions: [], error: 'no API key: set GITCHA_MEDIC_AGENT_KEY_FILE (a file holding the key, mode 600) in /etc/inputloop/gitcha/medic.env' };
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  const body = { model: a.model, max_tokens: 4000, system: SYSTEM, tools: TOOLS, output_config: { effort: a.effort } };
  // Refusal fallback, on by default (GITCHA_MEDIC_AGENT_FALLBACKS=no turns it off): a policy decline is re-run on a
  // fallback model inside the same call. The scalar form takes the 2026-07-01 beta header.
  if (a.fallbacks) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
  const messages = [{ role: 'user', content: `Host ${facts.host}, ${facts.at}.\n\nThe medic's findings:\n${JSON.stringify(redact(findings), null, 1)}\n\nThe facts they rest on:\n${JSON.stringify(redact(facts), null, 1)}\n\nWhat is wrong, and what should happen next? Use the tools; end with done.` }];
  const actions = [];
  let summary = '';
  for (let round = 1; round <= a.maxRounds; round++) {
    let res;
    try {
      res = await fetchFn(`${a.url.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, messages }), signal: AbortSignal.timeout(120_000) });
    } catch (err) { return { vendor: 'claude', model: a.model, summary, actions, rounds: round, error: `could not reach ${a.url}: ${err?.message ?? err}` }; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { vendor: 'claude', model: a.model, summary, actions, rounds: round, error: `HTTP ${res.status}: ${json?.error?.message ?? 'no detail'}` };
    if (json.stop_reason === 'refusal') return { vendor: 'claude', model: a.model, summary, actions, rounds: round, error: `the model declined (${json.stop_details?.category ?? 'no category'})` };
    const content = Array.isArray(json.content) ? json.content : [];
    messages.push({ role: 'assistant', content });
    const uses = content.filter((b) => b.type === 'tool_use');
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!uses.length) { summary = summary || text; break; }
    const results = [];
    let finished = false;
    for (const u of uses) {
      const input = typeof u.input === 'string' ? JSON.parse(u.input) : (u.input ?? {});
      let result;
      if (u.name === 'done') { summary = String(input.summary ?? text); finished = true; result = 'noted'; }
      else if (u.name === 'probe') result = JSON.stringify(redact(await callTool.probe(String(input.name))));
      else if (u.name === 'remedy') { const got = await callTool.remedy(String(input.name), String(input.reason ?? '')); actions.push(got); result = JSON.stringify(got); }
      else result = `unknown tool ${u.name}`;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
    }
    messages.push({ role: 'user', content: results });
    if (finished) break;
    if (json.stop_reason === 'max_tokens') { summary = summary || text; break; }
  }
  return { vendor: 'claude', model: a.model, summary, actions, rounds: messages.filter((m) => m.role === 'assistant').length };
}

const notYet = (vendor, hint) => async ({ config }) => ({ vendor, model: config.agent.model, summary: '', actions: [], error: `the ${vendor} vendor is not written yet (TODO): ${hint}` });

export const VENDOR_ADAPTERS = {
  claude: askClaude,
  // TODO: local models. One function: POST {url}/api/chat (Ollama) or /v1/chat/completions with the same three tools;
  // llama-bridge on this host or over the mesh is the first target.
  local: notYet('local', 'an Ollama or llama-bridge endpoint at GITCHA_MEDIC_AGENT_URL, same three tools'),
  // TODO: inputloop's own agents: a Mentat or a Tavern resident, reached through a Tavern tool or the Wire; the
  // medic would post its facts and wait for a reply with the same tool grammar.
  inputloop: notYet('inputloop', 'a Mentat or Tavern resident reached through Tavern or the Wire'),
  // TODO: any OpenAI-compatible server (vendored or self-hosted), /v1/chat/completions with function tools.
  openai: notYet('openai', 'an OpenAI-compatible /v1/chat/completions endpoint at GITCHA_MEDIC_AGENT_URL'),
};

/**
 * consult({config, facts, findings, reprobe, run, io, fetchFn}): run the configured vendor with the medic's tools.
 * `reprobe(name)` gives one probe's facts; remedies go through remedies.apply with allow 'safe', never more.
 */
export async function consult({ config, facts, findings, reprobe, run, io, fetchFn, readFile }) {
  const vendor = config.agent.vendor;
  if (vendor === 'none') return null;
  const adapter = VENDOR_ADAPTERS[vendor];
  if (!adapter) return { vendor, summary: '', actions: [], error: `unknown vendor ${vendor}` };
  const callTool = {
    probe: async (name) => reprobe(name),
    remedy: async (name, reason) => ({ ...(await apply(name, { run, io }, { allow: 'safe' })), reason, askedBy: vendor }),
  };
  return adapter({ config, facts, findings, callTool, fetchFn, readFile });
}
