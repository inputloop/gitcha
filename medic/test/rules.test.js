// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The rules, against pictures of real machines: the first is gw19 on 2026-10-30 as its keeper found it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnose, digest, headline } from '../lib/rules.js';
import { remedyOf } from '../lib/remedies.js';

const settings = { store: 'cassandra', contactPoints: [{ host: '127.0.0.1', port: 9042 }], cassandraIsLocal: true, datacenter: 'datacenter1', keyspace: 'gitcha', instance: 'main', host: '127.0.0.1', port: 4873, publicUrl: 'https://gitcha.inputloop.com', dataDir: '/var/lib/gitcha' };
const unit = (active, sub, enabled = 'enabled', extra = {}) => ({ known: true, active, sub, enabled, restarts: 0, result: 'success', exitStatus: 0, since: '', ...extra });

/** gw19: cassandra.yaml's cluster_name was changed from "Test Cluster" after Cassandra's first start, with nothing of ours in it yet. */
const gw19 = () => ({
  host: 'gw19', at: '2026-10-30T03:50:00.000Z', errors: [],
  gitcha: {
    settings, unit: unit('activating', 'auto-restart', 'enabled', { restarts: 41, result: 'exit-code', exitStatus: 1 }),
    journal: ['gitcha: starting; opening the database: Cassandra 127.0.0.1 (data center datacenter1), keyspace gitcha, instance main',
      'gitcha: cannot start: cannot reach Cassandra at 127.0.0.1 (data center datacenter1): 127.0.0.1:9042 ECONNREFUSED. Is Cassandra running there (systemctl status cassandra)? To use one file instead, set GITCHA_STORE=file (packages: in /etc/inputloop/gitcha/gitcha.env, or dpkg-reconfigure inputloop-gitcha).'],
    cannotStart: ['cannot reach Cassandra at 127.0.0.1 (data center datacenter1): 127.0.0.1:9042 ECONNREFUSED. Is Cassandra running there (systemctl status cassandra)? To use one file instead, set GITCHA_STORE=file (packages: in /etc/inputloop/gitcha/gitcha.env, or dpkg-reconfigure inputloop-gitcha).'],
    lastCannotStart: 'cannot reach Cassandra at 127.0.0.1 (data center datacenter1): 127.0.0.1:9042 ECONNREFUSED. Is Cassandra running there (systemctl status cassandra)? To use one file instead, set GITCHA_STORE=file (packages: in /etc/inputloop/gitcha/gitcha.env, or dpkg-reconfigure inputloop-gitcha).',
    portOpen: false, health: { ok: false },
  },
  cassandra: {
    wanted: true, local: true, installed: true, unit: unit('activating', 'auto-restart', 'enabled', { restarts: 7, result: 'exit-code', exitStatus: 3 }),
    journal: ['cassandra.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED'],
    systemLog: ['ERROR [main] 2026-10-30 03:43:10,112 CassandraDaemon.java:897 - Exception encountered during startup',
      'org.apache.cassandra.exceptions.ConfigurationException: Saved cluster name Test Cluster != configured name com.inputloop.gitcha'],
    yaml: { clusterName: 'com.inputloop.gitcha', listenAddress: '127.0.0.1', rpcAddress: '127.0.0.1', nativeTransportPort: 9042, seeds: ['127.0.0.1:7000'] },
    data: { dir: '/var/lib/cassandra/data', keyspaces: ['system', 'system_schema', 'system_auth', 'system_distributed', 'system_traces'], userKeyspaces: [] },
    ports: { '127.0.0.1:9042': false }, anyPortOpen: false,
    savedClusterName: 'Test Cluster', configuredClusterName: 'com.inputloop.gitcha', memoryTrouble: false, listenTrouble: false,
  },
  proxy: { nginx: { installed: true, unit: unit('active', 'running'), configOk: true, configSays: 'syntax is ok', upstreams: [{ file: '/etc/nginx/sites-enabled/gitcha', to: 'http://127.0.0.1:4873' }] }, caddy: { installed: false }, publicHealth: { status: 502, ok: false, error: '' } },
  system: { memMB: 7936, memAvailableMB: 5000, disks: [{ path: '/var/lib/gitcha', availMB: 40000, usedPct: 31 }] },
});

test('gw19: the cluster-name clash is named first, with the move-aside remedy because nothing of ours is on disk', () => {
  const found = diagnose(gw19());
  assert.equal(found[0].id, 'cassandra-cluster-name');
  assert.equal(found[0].level, 'bad');
  assert.match(found[0].what, /Test Cluster/);
  assert.match(found[0].what, /com\.inputloop\.gitcha/);
  assert.equal(found[0].remedy, 'reset-empty-cassandra');
  assert.equal(remedyOf(found[0].remedy).class, 'confirm', 'moving data aside waits for a person');
  const g = found.find((x) => x.id === 'gitcha-down-cassandra');
  assert.ok(g, 'Gitcha is reported as down because of Cassandra, not as a second fault');
  assert.equal(g.remedy, undefined);
  assert.ok(!found.some((x) => x.id === 'proxy-502'), 'a 502 while Gitcha is down is not a proxy fault');
  assert.match(headline(found, gw19()), /^gw19: Gitcha is DOWN: cassandra-cluster-name/);
});

test('gw19 with a gitcha keyspace already on disk: the rename-by-hand path, never a move', () => {
  const f = gw19();
  f.cassandra.data.keyspaces.push('gitcha'); f.cassandra.data.userKeyspaces = ['gitcha'];
  const found = diagnose(f);
  assert.equal(found[0].id, 'cassandra-cluster-name');
  assert.equal(found[0].remedy, 'rename-cassandra-cluster');
  assert.equal(remedyOf(found[0].remedy).class, 'manual');
  assert.match(found[0].why, /keyspaces of ours: gitcha/);
});

test('Cassandra up, Gitcha failed earlier: a safe restart is the remedy', () => {
  const f = gw19();
  f.cassandra = { ...f.cassandra, unit: unit('active', 'running'), ports: { '127.0.0.1:9042': true }, anyPortOpen: true, savedClusterName: undefined, configuredClusterName: undefined, systemLog: [] };
  f.gitcha.unit = unit('failed', 'failed', 'enabled', { result: 'exit-code' });
  const found = diagnose(f);
  assert.equal(found[0].id, 'gitcha-waiting-for-cassandra');
  assert.equal(found[0].remedy, 'restart-gitcha');
  assert.equal(remedyOf('restart-gitcha').class, 'safe');
  assert.ok(found.some((x) => x.id === 'cassandra-up' && x.level === 'ok'));
});

test('Cassandra installed and simply stopped: start it (safe)', () => {
  const f = gw19();
  f.cassandra = { ...f.cassandra, unit: unit('inactive', 'dead'), systemLog: [], journal: [], savedClusterName: undefined, configuredClusterName: undefined };
  const found = diagnose(f);
  assert.equal(found[0].id, 'cassandra-stopped');
  assert.equal(found[0].remedy, 'start-cassandra');
});

test('Cassandra out of memory on a small machine: a manual heap cap, and the memory warning', () => {
  const f = gw19();
  f.cassandra = { ...f.cassandra, savedClusterName: undefined, configuredClusterName: undefined, memoryTrouble: true, systemLog: ['There is insufficient memory for the Java Runtime Environment to continue.'] };
  f.system.memMB = 1900;
  const found = diagnose(f);
  assert.equal(found[0].id, 'cassandra-memory');
  assert.equal(found[0].remedy, 'cap-cassandra-heap');
  assert.ok(found.some((x) => x.id === 'memory-small'));
});

test('all well: one ok headline, no remedies, digest "ok"', () => {
  const f = gw19();
  f.cassandra = { ...f.cassandra, unit: unit('active', 'running'), ports: { '127.0.0.1:9042': true }, anyPortOpen: true, savedClusterName: undefined, configuredClusterName: undefined, systemLog: [] };
  f.gitcha = { ...f.gitcha, unit: unit('active', 'running'), journal: [], cannotStart: [], lastCannotStart: '', portOpen: true, health: { ok: true, status: 200, version: '0.2.0', service: 'gitcha' } };
  f.proxy.publicHealth = { status: 200, ok: true, error: '' };
  const found = diagnose(f);
  assert.ok(found.every((x) => x.level === 'ok'), JSON.stringify(found.filter((x) => x.level !== 'ok')));
  assert.equal(digest(found), 'ok');
  assert.match(headline(found, f), /up and nothing needs doing/);
});

test('Gitcha up but the proxy answers 502: a proxy fault, by hand', () => {
  const f = gw19();
  f.cassandra = { ...f.cassandra, unit: unit('active', 'running'), ports: { '127.0.0.1:9042': true }, anyPortOpen: true, savedClusterName: undefined, configuredClusterName: undefined, systemLog: [] };
  f.gitcha = { ...f.gitcha, unit: unit('active', 'running'), journal: [], cannotStart: [], lastCannotStart: '', portOpen: true, health: { ok: true, status: 200, version: '0.2.0', service: 'gitcha' } };
  f.proxy.nginx.upstreams = [{ file: '/etc/nginx/sites-enabled/gitcha', to: 'http://127.0.0.1:4874' }];
  const found = diagnose(f);
  assert.ok(found.some((x) => x.id === 'proxy-502' && x.remedy === 'manual-nginx'));
  assert.ok(found.some((x) => x.id === 'nginx-upstream'));
});

test('the other cannot-start reasons each get their own finding, and none a safe remedy', () => {
  for (const [line, id] of [
    ['another Gitcha server (gw33, pid 812) owns instance main', 'gitcha-lease-held'],
    ['the database was written with a different secret key', 'gitcha-secret-key'],
    ['could not listen on 127.0.0.1:4873 (EADDRINUSE)', 'gitcha-port-in-use'],
    ['another process (pid 4) is already using /var/lib/gitcha', 'gitcha-data-dir-locked'],
    ['GITCHA_PORT must be a number', 'gitcha-setting'],
  ]) {
    const f = gw19();
    f.cassandra = { ...f.cassandra, unit: unit('active', 'running'), ports: { '127.0.0.1:9042': true }, anyPortOpen: true, savedClusterName: undefined, configuredClusterName: undefined, systemLog: [] };
    f.gitcha.unit = unit('failed', 'failed');
    f.gitcha.lastCannotStart = line;
    const found = diagnose(f);
    const hit = found.find((x) => x.id === id);
    assert.ok(hit, `${id} for "${line}"`);
    assert.notEqual(remedyOf(hit.remedy).class, 'safe', `${id} is never mended unasked`);
  }
});

test('Cassandra on other machines and unreachable: no local remedy is offered', () => {
  const f = gw19();
  f.gitcha.settings = { ...settings, contactPoints: [{ host: 'gw33', port: 9042 }, { host: 'gw26', port: 9042 }], cassandraIsLocal: false };
  f.cassandra = { wanted: true, local: false, installed: false, unit: null, journal: [], systemLog: [], ports: { 'gw33:9042': false, 'gw26:9042': false }, anyPortOpen: false, data: { keyspaces: [], userKeyspaces: [] } };
  const found = diagnose(f);
  assert.equal(found[0].id, 'cassandra-unreachable');
  assert.equal(remedyOf(found[0].remedy).class, 'manual');
});

test('the Omni gateway: absent is silence; stopped-but-enabled is a safe start; up is ok; a member fault is a warning', () => {
  const base = () => { const f = gw19(); f.cassandra = { ...f.cassandra, unit: unit('active', 'running'), ports: { '127.0.0.1:9042': true }, anyPortOpen: true, savedClusterName: undefined, configuredClusterName: undefined, systemLog: [] }; f.gitcha = { ...f.gitcha, unit: unit('active', 'running'), journal: [], cannotStart: [], lastCannotStart: '', portOpen: true, health: { ok: true, status: 200, version: '0.2.0', service: 'gitcha' } }; f.proxy.publicHealth = { status: 200, ok: true, error: '' }; return f; };
  assert.ok(!diagnose(base()).some((x) => x.id.startsWith('omni')), 'no omni package: no omni finding');
  let f = base(); f.omni = { installed: true, membersFile: false };
  assert.equal(diagnose(f).find((x) => x.id === 'omni-no-members').level, 'info');
  f = base(); f.omni = { installed: true, membersFile: true, unit: unit('inactive', 'dead'), portOpen: false, health: { ok: false } };
  const stopped = diagnose(f).find((x) => x.id === 'omni-gateway-stopped');
  assert.equal(stopped.level, 'bad'); assert.equal(stopped.remedy, 'start-omni-gateway'); assert.equal(remedyOf(stopped.remedy).class, 'safe');
  f = base(); f.omni = { installed: true, membersFile: true, unit: unit('active', 'running'), portOpen: true, health: { ok: true, status: 200, members: ['seat', 'tavern'] }, journal: ['omni-gateway: tavern: exited (1)'], memberFaults: ['omni-gateway: tavern: exited (1)'] };
  const found = diagnose(f);
  assert.ok(found.some((x) => x.id === 'omni-gateway-up' && x.level === 'ok' && /seat, tavern/.test(x.what)));
  assert.ok(found.some((x) => x.id === 'omni-member-faults' && x.level === 'warn'));
  f = base(); f.omni = { installed: true, membersFile: true, unit: unit('active', 'running'), portOpen: false, health: { ok: false } };
  assert.equal(diagnose(f).find((x) => x.id === 'omni-gateway-silent').remedy, 'restart-omni-gateway');
});

test('every remedy a rule names exists and has a class', () => {
  // Walk the rules file for remedy names (the fifth argument of f(...)) and check each against the table.
  const src = fs.readFileSync(new URL('../lib/rules.js', import.meta.url), 'utf8');
  const names = new Set([...src.matchAll(/'((?:start|restart|reset|rename|cap|setup|manual|wait)(?:-[a-z0-9-]+)?)'/g)].map((m) => m[1]));
  assert.ok(names.size >= 12, `found ${names.size} remedy names in rules.js`);
  for (const n of names) {
    assert.notEqual(remedyOf(n).how, `(no remedy named ${n} is known to this medic)`, `rules.js names ${n}`);
  }
});
