// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The channels, each against a stand-in: a Tavern-shaped local server, a webhook, a chadgram file, a C4 folder, logger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { announce } from '../lib/channels.js';
import { medicConfig } from '../lib/config.js';
import { tableRunner } from '../lib/run.js';
import { brief, render } from '../lib/report.js';

const message = { headline: 'gw19: Gitcha is DOWN: cassandra-cluster-name.', brief: 'gw19: Gitcha is DOWN: cassandra-cluster-name.\n- Cassandra refuses to start [waiting on a person: sudo gitcha-medic --yes reset-empty-cassandra]', findings: [{ id: 'cassandra-cluster-name', level: 'bad', what: 'Cassandra refuses to start', remedy: 'reset-empty-cassandra' }], worst: 'bad', at: '2026-10-30T03:50:00.000Z' };

/** A local HTTP server that records requests; answers 200 unless the path says otherwise. */
function server(record) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { record.push({ path: req.url, auth: req.headers.authorization ?? '', body }); res.statusCode = req.url.includes('fail') ? 500 : 200; res.end('{}'); });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });
}

test('syslog: the headline and each finding go through logger with a priority that fits', async () => {
  const run = tableRunner({ logger: '' });
  const config = medicConfig({ GITCHA_MEDIC_CHANNELS: 'syslog' }, { hostname: 'gw19' });
  const rows = await announce(config, message, { run });
  assert.deepEqual(rows, [{ channel: 'syslog', ok: true, said: 'logged' }]);
  assert.equal(run.calls.length, 2);
  assert.match(run.calls[0], /^logger -t gitcha-medic -p daemon\.err gitcha-medic@gw19 gw19: Gitcha is DOWN/);
  assert.match(run.calls[1], /daemon\.err gitcha-medic@gw19 bad cassandra-cluster-name: Cassandra refuses to start/);
});

test('syslog without logger(1): a row that says so, not a crash', async () => {
  const rows = await announce(medicConfig({}, { hostname: 'gw19' }), message, { run: tableRunner({}) });
  assert.equal(rows[0].ok, false);
  assert.match(rows[0].said, /logger\(1\) is not installed/);
});

test('tavern: POST /api/say with the agent token from agent.json, as the configured name, in the room', async () => {
  const got = [];
  const srv = await server(got);
  const config = medicConfig({ GITCHA_MEDIC_CHANNELS: 'tavern', GITCHA_MEDIC_TAVERN_AGENT_JSON: '/var/lib/tavern/agent.json', GITCHA_MEDIC_TAVERN_ROOM: 'ops' }, { hostname: 'gw19' });
  const rows = await announce(config, message, { readFile: () => JSON.stringify({ port: srv.port, pid: 1, token: 't0k3n' }) });
  await srv.close();
  assert.deepEqual(rows, [{ channel: 'tavern', ok: true, said: 'said in ops' }]);
  assert.equal(got[0].path, '/api/say');
  assert.equal(got[0].auth, 'Bearer t0k3n');
  const body = JSON.parse(got[0].body);
  assert.equal(body.as, 'medic@gw19');
  assert.equal(body.room, 'ops');
  assert.match(body.text, /Gitcha is DOWN/);
});

test('tavern: no agent.json configured is one failed row and nothing else breaks', async () => {
  const run = tableRunner({ logger: '' });
  const rows = await announce(medicConfig({ GITCHA_MEDIC_CHANNELS: 'tavern,syslog' }, { hostname: 'gw19' }), message, { run, readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(rows[0].ok, false);
  assert.match(rows[0].said, /GITCHA_MEDIC_TAVERN_AGENT_JSON/);
  assert.equal(rows[1].ok, true, 'syslog still happened');
});

test('webhook: JSON by POST; a 500 is reported', async () => {
  const got = [];
  const srv = await server(got);
  const ok = await announce(medicConfig({ GITCHA_MEDIC_CHANNELS: 'webhook', GITCHA_MEDIC_WEBHOOK_URL: `http://127.0.0.1:${srv.port}/hook` }, { hostname: 'gw19' }), message, {});
  const bad = await announce(medicConfig({ GITCHA_MEDIC_CHANNELS: 'webhook', GITCHA_MEDIC_WEBHOOK_URL: `http://127.0.0.1:${srv.port}/fail` }, { hostname: 'gw19' }), message, {});
  await srv.close();
  assert.equal(ok[0].ok, true);
  const body = JSON.parse(got[0].body);
  assert.equal(body.source, 'gitcha-medic');
  assert.equal(body.level, 'bad');
  assert.deepEqual(body.findings[0], { id: 'cassandra-cluster-name', level: 'bad', what: 'Cassandra refuses to start', remedy: 'reset-empty-cassandra' });
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].said, /HTTP 500/);
});

test('chadgram: one ilmsg/1 line appended, shaped as CONTRACT-il-net.md shapes it', async () => {
  let appended = '';
  const rows = await announce(medicConfig({ GITCHA_MEDIC_CHANNELS: 'chadgram', GITCHA_MEDIC_CHADGRAM_FILE: '/var/lib/gitcha-medic/chad.jsonl', GITCHA_MEDIC_CHADGRAM_NET: 'yard' }, { hostname: 'gw19' }), message, { appendFile: (p, s) => { appended += `${p}:${s}`; } });
  assert.equal(rows[0].ok, true);
  const [path, line] = appended.split(/:(.+)/s);
  assert.equal(path, '/var/lib/gitcha-medic/chad.jsonl');
  assert.ok(line.endsWith('\n'));
  const msg = JSON.parse(line);
  assert.equal(msg.v, 'ilmsg/1');
  assert.match(msg.id, /^[0-9a-f]{16}$/);
  assert.equal(typeof msg.ts, 'number');
  assert.deepEqual(msg.from, { net: 'yard', env: 'gitcha-medic@gw19', game: 'gitcha-medic', who: 'gitcha-medic@gw19' });
  assert.equal(msg.kind, 'alert');
  assert.match(msg.body, /Gitcha is DOWN/);
});

test('c4: a postcard file in the folder, named by time, level and identity', async () => {
  const wrote = [];
  const rows = await announce(medicConfig({ GITCHA_MEDIC_CHANNELS: 'c4', GITCHA_MEDIC_C4_DIR: '/c4/inbox' }, { hostname: 'gw19' }), message, { mkdir: () => {}, writeFile: (p, s) => wrote.push([p, s]) });
  assert.equal(rows[0].ok, true);
  assert.match(wrote[0][0], /^\/c4\/inbox\/2026-10-30T03-50-00-000Z-bad-gitcha-medic@gw19\.md$/);
  assert.match(wrote[0][1], /^# gitcha-medic gitcha-medic@gw19 2026-10-30T03:50:00\.000Z\n/);
});

test('the report says each finding, why, and what waits on a person; the brief fits a room', () => {
  const facts = { host: 'gw19', at: '2026-10-30T03:50:00.000Z', gitcha: { settings: { host: '127.0.0.1', port: 4873, publicUrl: 'https://gitcha.inputloop.com', store: 'cassandra', contactPoints: [{ host: '127.0.0.1', port: 9042 }], keyspace: 'gitcha', instance: 'main' } } };
  const findings = [
    { id: 'cassandra-cluster-name', level: 'bad', what: 'Cassandra refuses to start: names differ.', why: 'Its log says so.', remedy: 'reset-empty-cassandra' },
    { id: 'gitcha-waiting-for-cassandra', level: 'warn', what: 'Gitcha failed earlier.', why: 'Journal.', remedy: 'restart-gitcha' },
  ];
  const actions = [{ name: 'restart-gitcha', class: 'safe', title: 'restart Gitcha', ran: true, ok: true, out: '', err: '' }];
  const text = render({ facts, findings, actions, config: { identity: 'gitcha-medic@gw19' } });
  assert.match(text, /PROBLEM  Cassandra refuses to start/);
  assert.match(text, /because: Its log says so\./);
  assert.match(text, /needs your yes: sudo gitcha-medic --yes reset-empty-cassandra/);
  assert.match(text, /done \(safe\): restart Gitcha: ok/);
  assert.match(text, /watching: gitcha 127\.0\.0\.1:4873 \(https:\/\/gitcha\.inputloop\.com\), store cassandra at 127\.0\.0\.1:9042/);
  const short = brief({ facts, findings, actions });
  assert.match(short, /^gw19: Gitcha is DOWN: cassandra-cluster-name; also gitcha-waiting-for-cassandra\./);
  assert.match(short, /\[waiting on a person: sudo gitcha-medic --yes reset-empty-cassandra\]/);
  assert.match(short, /\[restart-gitcha: done\]/);
});
