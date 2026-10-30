// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The probes, against a stand-in machine: commands answer from a table, files from a map, ports from a set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gather, parseCassandraYaml } from '../lib/probes.js';
import { gitchaSettings, parseEnvFile, readEnvFiles, redact, medicConfig } from '../lib/config.js';
import { tableRunner } from '../lib/run.js';

const YAML = `# cassandra.yaml
cluster_name: 'com.inputloop.gitcha'
num_tokens: 16
seed_provider:
    - class_name: org.apache.cassandra.locator.SimpleSeedProvider
      parameters:
          - seeds: "127.0.0.1:7000"
listen_address: 127.0.0.1
rpc_address: 127.0.0.1
# native_transport_port: 9999
native_transport_port: 9042
authenticator: AllowAllAuthenticator
`;

const show = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');

function machine({ cassandraUp = false, gitchaUp = false } = {}) {
  const files = {
    '/etc/cassandra/cassandra.yaml': YAML,
    '/var/log/cassandra/system.log': cassandraUp ? 'INFO  [main] Startup complete' : 'ERROR [main] CassandraDaemon.java:897 - Exception encountered during startup\norg.apache.cassandra.exceptions.ConfigurationException: Saved cluster name Test Cluster != configured name com.inputloop.gitcha',
    '/proc/meminfo': 'MemTotal:        8126464 kB\nMemFree:         100 kB\nMemAvailable:    5120000 kB\n',
    '/etc/nginx/sites-enabled/gitcha': 'server { location / { proxy_pass http://127.0.0.1:4873; } }',
  };
  const dirs = { '/var/lib/cassandra/data': ['system', 'system_schema', 'system_auth'], '/etc/nginx/sites-enabled': ['gitcha'], '/var/lib/gitcha': [], '/var/lib/cassandra': ['data'], '/var/log': [] };
  const run = tableRunner({
    'systemctl show -p LoadState,ActiveState,SubState,UnitFileState,NRestarts,Result,ExecMainStatus,ActiveEnterTimestamp gitcha.service': show({ LoadState: 'loaded', ActiveState: gitchaUp ? 'active' : 'activating', SubState: gitchaUp ? 'running' : 'auto-restart', UnitFileState: 'enabled', NRestarts: gitchaUp ? 0 : 41, Result: gitchaUp ? 'success' : 'exit-code', ExecMainStatus: gitchaUp ? 0 : 1 }),
    'systemctl show -p LoadState,ActiveState,SubState,UnitFileState,NRestarts,Result,ExecMainStatus,ActiveEnterTimestamp cassandra.service': show({ LoadState: 'loaded', ActiveState: cassandraUp ? 'active' : 'activating', SubState: cassandraUp ? 'running' : 'auto-restart', UnitFileState: 'enabled', NRestarts: 7, Result: 'exit-code', ExecMainStatus: 3 }),
    'systemctl show -p LoadState,ActiveState,SubState,UnitFileState,NRestarts,Result,ExecMainStatus,ActiveEnterTimestamp nginx.service': show({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', UnitFileState: 'enabled', NRestarts: 0, Result: 'success', ExecMainStatus: 0 }),
    'journalctl -u gitcha -n 80 --no-pager -o cat': gitchaUp ? 'Gitcha registry v0.2.0' : 'gitcha: starting; opening the database: Cassandra 127.0.0.1 (data center datacenter1), keyspace gitcha, instance main\ngitcha: cannot start: cannot reach Cassandra at 127.0.0.1 (data center datacenter1): 127.0.0.1:9042 ECONNREFUSED. Is Cassandra running there (systemctl status cassandra)?',
    'journalctl -u cassandra -n 80 --no-pager -o cat': 'cassandra.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED',
    'dpkg-query -W -f=${Status} cassandra': 'install ok installed',
    'dpkg-query -W -f=${Status} nginx': 'install ok installed',
    'dpkg-query -W -f=${Status} caddy': { code: 1, err: 'dpkg-query: no packages found matching caddy' },
    'nginx -t': { code: 0, err: 'nginx: configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful' },
    'curl -sS -o /dev/null -w %{http_code} --max-time 8 --resolve gitcha.inputloop.com:443:127.0.0.1 https://gitcha.inputloop.com/api/v1/health': gitchaUp ? '200' : { code: 22, out: '502', err: 'curl: (22) The requested URL returned error: 502' },
    'df -Pk /var/lib/gitcha': 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 31000000 69000000 31% /',
    'df -Pk /var/lib/cassandra': 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 31000000 69000000 31% /',
    'df -Pk /var/log': 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 31000000 69000000 31% /',
  });
  const open = new Set([...(cassandraUp ? ['127.0.0.1:9042'] : []), ...(gitchaUp ? ['127.0.0.1:4873'] : [])]);
  const io = {
    run,
    readFile: (p) => { if (p in files) return files[p]; throw new Error(`ENOENT ${p}`); },
    readdir: (p) => { if (p in dirs) return dirs[p]; throw new Error(`ENOENT ${p}`); },
    exists: (p) => p in files || p in dirs,
    hostname: () => 'gw19', now: () => new Date('2026-10-30T03:50:00Z'),
    portOpen: async (h, port) => open.has(`${h}:${port}`),
    fetchJson: async (url) => (url.includes(':4873/') && gitchaUp ? { status: 200, body: { service: 'gitcha', version: '0.2.0' } } : { status: 503, body: {} }),
  };
  return { run, io, files, dirs };
}

const settings = gitchaSettings(parseEnvFile('GITCHA_STORE=cassandra\nGITCHA_CASSANDRA_CONTACT_POINTS=127.0.0.1\nGITCHA_PUBLIC_URL="https://gitcha.inputloop.com/"\nGITCHA_CASSANDRA_PASSWORD="hunter2"\n'));

test('gather: gw19 as it stood; the cluster-name clash is read from system.log, the data dir shows no keyspace of ours', async () => {
  const { io, run } = machine();
  const facts = await gather(settings, io);
  assert.equal(facts.host, 'gw19');
  assert.equal(facts.errors.length, 0, JSON.stringify(facts.errors));
  assert.equal(facts.cassandra.savedClusterName, 'Test Cluster');
  assert.equal(facts.cassandra.configuredClusterName, 'com.inputloop.gitcha');
  assert.deepEqual(facts.cassandra.data.userKeyspaces, []);
  assert.equal(facts.cassandra.yaml.clusterName, 'com.inputloop.gitcha');
  assert.equal(facts.cassandra.anyPortOpen, false);
  assert.match(facts.gitcha.lastCannotStart, /^cannot reach Cassandra/);
  assert.equal(facts.gitcha.unit.restarts, 41);
  assert.equal(facts.proxy.publicHealth.status, 502);
  assert.deepEqual(facts.proxy.nginx.upstreams, [{ file: '/etc/nginx/sites-enabled/gitcha', to: 'http://127.0.0.1:4873' }]);
  assert.equal(facts.system.memMB, 7936);
  assert.equal(facts.system.disks[0].usedPct, 31);
  // Every command was a reading one.
  for (const call of run.calls) assert.match(call, /^(systemctl show|journalctl|dpkg-query|nginx -t|curl -sS|df -Pk|ss -ltnp)/, `only reads: ${call}`);
});

test('gather: all up; health read from the port', async () => {
  const { io } = machine({ cassandraUp: true, gitchaUp: true });
  const facts = await gather(settings, io);
  assert.equal(facts.gitcha.health.ok, true);
  assert.equal(facts.gitcha.health.version, '0.2.0');
  assert.equal(facts.cassandra.anyPortOpen, true);
  assert.equal(facts.cassandra.savedClusterName, undefined);
  assert.equal(facts.proxy.publicHealth.ok, true);
});

test('gather: a probe that throws leaves a note and the others still answer', async () => {
  const { io } = machine();
  io.readFile = (p) => { if (p === '/proc/meminfo') throw new Error('boom'); return machine().io.readFile(p); };
  const facts = await gather(settings, io);
  assert.ok(facts.errors.some((e) => /^system: boom/.test(e)));
  assert.equal(facts.cassandra.savedClusterName, 'Test Cluster');
});

test('parseCassandraYaml reads the keys that matter and skips commented ones', () => {
  const y = parseCassandraYaml(YAML);
  assert.deepEqual(y, { clusterName: 'com.inputloop.gitcha', listenAddress: '127.0.0.1', rpcAddress: '127.0.0.1', nativeTransportPort: 9042, seeds: ['127.0.0.1:7000'], authenticator: 'AllowAllAuthenticator' });
  assert.equal(parseCassandraYaml("cluster_name: 'Test Cluster'\nlisten_address: localhost\n").clusterName, 'Test Cluster');
});

test('settings: env files are read like the unit reads them, later files win, and secrets never leave', () => {
  const env = readEnvFiles(['/a', '/b', '/missing'], { readFile: (p) => ({ '/a': 'GITCHA_STORE=file\nGITCHA_PORT=4873   # the port\nGITCHA_CASSANDRA_PASSWORD="p\\"w"\n', '/b': '#GITCHA_STORE=cassandra\nGITCHA_STORE=cassandra\nGITCHA_CASSANDRA_CONTACT_POINTS=gw33:9042, gw26\n' })[p] ?? (() => { throw new Error('ENOENT'); })() });
  assert.equal(env.GITCHA_STORE, 'cassandra');
  assert.equal(env.GITCHA_PORT, '4873');
  assert.equal(env.GITCHA_CASSANDRA_PASSWORD, 'p"w');
  const s = gitchaSettings(env);
  assert.deepEqual(s.contactPoints, [{ host: 'gw33', port: 9042 }, { host: 'gw26', port: 9042 }]);
  assert.equal(s.cassandraIsLocal, false);
  assert.equal(gitchaSettings({}).store, 'file');
  const out = redact({ GITCHA_CASSANDRA_PASSWORD: 'hunter2', note: 'key sk-ant-api03-abcdefghijklmnop here', list: [{ STRIPE_SECRET_KEY: 'x' }], GITCHA_PORT: '4873' });
  assert.equal(out.GITCHA_CASSANDRA_PASSWORD, '[redacted]');
  assert.equal(out.note, 'key [redacted] here');
  assert.equal(out.list[0].STRIPE_SECRET_KEY, '[redacted]');
  assert.equal(out.GITCHA_PORT, '4873');
});

test('medic settings: defaults, channels, and a warning for an unknown name instead of silence', () => {
  const c = medicConfig({}, { hostname: 'gw19' });
  assert.equal(c.identity, 'gitcha-medic@gw19');
  assert.deepEqual(c.channels, ['syslog']);
  assert.equal(c.heal, 'report');
  assert.equal(c.agent.vendor, 'none');
  assert.equal(c.repeat, 6 * 3_600_000);
  const d = medicConfig({ GITCHA_MEDIC_CHANNELS: 'syslog,tavern,bogus', GITCHA_MEDIC_AGENT: 'claude', GITCHA_MEDIC_HEAL: 'safe', GITCHA_MEDIC_REPEAT: '30m' }, { hostname: 'gw19' });
  assert.deepEqual(d.channels, ['syslog', 'tavern']);
  assert.match(d.warnings[0], /unknown channel "bogus"/);
  assert.equal(d.agent.model, 'claude-opus-5-5');
  assert.equal(d.agent.url, 'https://api.anthropic.com');
  assert.equal(d.repeat, 30 * 60_000);
  assert.equal(d.heal, 'safe');
});
