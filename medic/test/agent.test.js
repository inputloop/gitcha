// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The agent step against a stand-in Claude API: the tool loop, the consent gate, and that no secret leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consult, TOOLS } from '../lib/agent.js';
import { medicConfig } from '../lib/config.js';
import { tableRunner } from '../lib/run.js';

/** A fetch stand-in that plays a scripted Claude: each call answers the next script entry and records the request. */
function scripted(script, { status = 200 } = {}) {
  const seen = [];
  let i = 0;
  const fetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const content = script[Math.min(i, script.length - 1)]; i++;
    return { ok: status === 200, status, json: async () => (status === 200 ? { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content } : { error: { message: 'bad key' } }) };
  };
  fetchFn.seen = seen;
  return fetchFn;
}

const facts = { host: 'gw19', at: 'now', gitcha: { settings: { store: 'cassandra' } }, cassandra: { savedClusterName: 'Test Cluster' }, secrets: { GITCHA_CASSANDRA_PASSWORD: 'hunter2' } };
const findings = [{ id: 'cassandra-cluster-name', level: 'bad', what: 'names differ', why: 'log', remedy: 'reset-empty-cassandra' }];
const config = medicConfig({ GITCHA_MEDIC_AGENT: 'claude', GITCHA_MEDIC_AGENT_KEY_FILE: '/etc/inputloop/gitcha/claude.key' }, { hostname: 'gw19' });
const readFile = (p) => (p === '/etc/inputloop/gitcha/claude.key' ? 'sk-ant-api03-SECRETSECRETSECRET\n' : (() => { throw new Error('ENOENT'); })());

test('claude: probes again, asks for a confirm remedy (parked, nothing runs), asks for a safe one (runs), and finishes with done', async () => {
  const fetchFn = scripted([
    [{ type: 'text', text: 'Let me look at Cassandra.' }, { type: 'tool_use', id: 't1', name: 'probe', input: { name: 'cassandra' } }],
    [{ type: 'tool_use', id: 't2', name: 'remedy', input: { name: 'reset-empty-cassandra', reason: 'the data dir is empty' } }, { type: 'tool_use', id: 't3', name: 'remedy', input: { name: 'restart-gitcha', reason: 'bring it up' } }],
    [{ type: 'tool_use', id: 't4', name: 'done', input: { summary: 'The cluster name changed after first start; a person must say yes to the reset.' } }],
  ]);
  const run = tableRunner({ 'systemctl restart gitcha.service': '' });
  const probed = [];
  const out = await consult({ config, facts, findings, reprobe: async (n) => { probed.push(n); return { yaml: { clusterName: 'x' } }; }, run, io: {}, fetchFn, readFile });
  assert.equal(out.vendor, 'claude');
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.error, undefined);
  assert.match(out.summary, /a person must say yes/);
  assert.deepEqual(probed, ['cassandra']);
  assert.equal(out.actions.length, 2);
  const parked = out.actions.find((a) => a.name === 'reset-empty-cassandra');
  assert.equal(parked.ran, false);
  assert.match(parked.parked, /needs a person's yes/);
  const ran = out.actions.find((a) => a.name === 'restart-gitcha');
  assert.deepEqual([ran.ran, ran.ok, ran.askedBy], [true, true, 'claude']);
  assert.deepEqual(run.calls, ['systemctl restart gitcha.service'], 'only the safe remedy touched the machine');
  // The requests: the key in the header only, the version pinned, fallbacks on, tools declared, nothing secret in the body.
  const first = fetchFn.seen[0];
  assert.equal(first.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(first.headers['x-api-key'], 'sk-ant-api03-SECRETSECRETSECRET');
  assert.equal(first.headers['anthropic-version'], '2026-10-21');
  assert.equal(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(first.body.fallbacks, 'default');
  assert.deepEqual(first.body.tools.map((t) => t.name), ['probe', 'remedy', 'done']);
  assert.equal(first.body.output_config.effort, 'medium');
  for (const req of fetchFn.seen) {
    const text = JSON.stringify(req.body);
    assert.ok(!text.includes('hunter2'), 'the Cassandra password never reaches the model');
    assert.ok(!text.includes('SECRETSECRET'), 'the API key never reaches the body');
  }
  // The transcript grew the right way: assistant, then tool_result for each tool_use, in one user turn.
  const last = fetchFn.seen[2].body.messages;
  assert.equal(last.at(-2).role, 'assistant');
  assert.deepEqual(last.at(-1).content.map((b) => b.tool_use_id), ['t2', 't3']);
});

test('claude: no key file means a clear error and no request', async () => {
  const fetchFn = scripted([[{ type: 'text', text: 'hi' }]]);
  const out = await consult({ config, facts, findings, reprobe: async () => ({}), run: tableRunner({}), io: {}, fetchFn, readFile: () => { throw new Error('ENOENT'); } });
  assert.match(out.error, /no API key/);
  assert.equal(fetchFn.seen.length, 0);
});

test('claude: an HTTP error is reported with the server\'s words; the loop stops', async () => {
  const fetchFn = scripted([[{ type: 'text', text: '' }]], { status: 401 });
  const out = await consult({ config, facts, findings, reprobe: async () => ({}), run: tableRunner({}), io: {}, fetchFn, readFile });
  assert.match(out.error, /HTTP 401: bad key/);
  assert.equal(fetchFn.seen.length, 1);
});

test('claude: the loop ends at maxRounds even if the model never says done', async () => {
  const fetchFn = scripted([[{ type: 'tool_use', id: 'x', name: 'probe', input: { name: 'system' } }]]);
  const c = medicConfig({ GITCHA_MEDIC_AGENT: 'claude', GITCHA_MEDIC_AGENT_KEY: 'k', GITCHA_MEDIC_AGENT_ROUNDS: '3', GITCHA_MEDIC_AGENT_FALLBACKS: 'no' }, { hostname: 'gw19' });
  const out = await consult({ config: c, facts, findings, reprobe: async () => ({}), run: tableRunner({}), io: {}, fetchFn, readFile });
  assert.equal(fetchFn.seen.length, 3);
  assert.equal(out.rounds, 3);
  assert.equal(fetchFn.seen[0].headers['anthropic-beta'], undefined, 'fallbacks off: no beta header');
  assert.equal(fetchFn.seen[0].body.fallbacks, undefined);
});

test('the other vendors say they are not written yet, in those words, instead of pretending', async () => {
  for (const v of ['local', 'inputloop', 'openai']) {
    const out = await consult({ config: medicConfig({ GITCHA_MEDIC_AGENT: v }, { hostname: 'gw19' }), facts, findings, reprobe: async () => ({}), run: tableRunner({}), io: {} });
    assert.match(out.error, new RegExp(`the ${v} vendor is not written yet \\(TODO\\)`));
  }
  assert.equal(await consult({ config: medicConfig({}, { hostname: 'gw19' }), facts, findings }), null, 'vendor none: no agent step at all');
});

test('the tools are strict and the remedy tool only names remedies the medic knows', () => {
  for (const t of TOOLS) { assert.equal(t.strict, true); assert.equal(t.input_schema.additionalProperties, false); }
  assert.ok(TOOLS[1].input_schema.properties.name.enum.includes('reset-empty-cassandra'));
});
