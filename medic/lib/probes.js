// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The probes: what the medic looks at. Every probe only reads (systemctl show, journalctl, a file, a port, a URL);
// nothing here changes the machine. Each one is guarded, so a probe that fails leaves a note in facts.errors and
// the others still run. The result is one plain object, `facts`, that the rules read and the report shows.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const JOURNAL_LINES = 80;
const SYSTEM_LOG_LINES = 200;
/** Cassandra's own keyspaces: a data directory with only these holds no user data. */
export const SYSTEM_KEYSPACES = new Set(['system', 'system_auth', 'system_distributed', 'system_schema', 'system_traces', 'system_views', 'system_virtual_schema']);

/** The set of outside things a probe may touch; tests hand in stand-ins. */
export function defaultIo(run) {
  return {
    run,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    readdir: (p) => fs.readdirSync(p),
    exists: (p) => fs.existsSync(p),
    hostname: () => os.hostname(),
    now: () => new Date(),
    /** Is something listening on host:port? Resolves true or false within `timeout` ms. */
    portOpen: (host, port, timeout = 2000) => new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(timeout, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    }),
    fetchJson: async (url, timeout = 3000) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

/** `systemctl show` for one unit, as an object; unit: null when systemd is not there or does not know the unit. */
async function unitState(io, unit) {
  const r = await io.run('systemctl', ['show', '-p', 'LoadState,ActiveState,SubState,UnitFileState,NRestarts,Result,ExecMainStatus,ActiveEnterTimestamp', unit]);
  if (r.code !== 0 && !r.out) return null;
  const o = {};
  for (const line of r.out.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1); }
  if (o.LoadState === 'not-found') return { known: false };
  return {
    known: true,
    active: o.ActiveState ?? '',
    sub: o.SubState ?? '',
    enabled: o.UnitFileState ?? '',
    restarts: Number(o.NRestarts ?? 0),
    result: o.Result ?? '',
    exitStatus: Number(o.ExecMainStatus ?? 0),
    since: o.ActiveEnterTimestamp ?? '',
  };
}

async function journal(io, unit, n = JOURNAL_LINES) {
  const r = await io.run('journalctl', ['-u', unit, '-n', String(n), '--no-pager', '-o', 'cat']);
  return r.code === 0 ? r.out.split('\n').filter(Boolean) : [];
}

async function installed(io, pkg) {
  const r = await io.run('dpkg-query', ['-W', '-f=${Status}', pkg]);
  return r.code === 0 && /install ok installed/.test(r.out);
}

/** The few cassandra.yaml keys that decide whether a node starts and whether Gitcha can reach it. */
export function parseCassandraYaml(text) {
  const top = (key) => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text);
    if (!m) return undefined;
    return m[1].trim().replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
  };
  const seeds = /^\s*-\s*seeds:\s*["']?([^"'\n]*)["']?/m.exec(text);
  return {
    clusterName: top('cluster_name'),
    listenAddress: top('listen_address'),
    rpcAddress: top('rpc_address'),
    nativeTransportPort: Number(top('native_transport_port') ?? 9042),
    seeds: (seeds?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    authenticator: top('authenticator'),
  };
}

function lastLines(text, n) { const a = text.split('\n'); return a.slice(Math.max(0, a.length - n)).filter(Boolean); }

/**
 * gather(settings, io): every probe, as one facts object. `settings` is config.gitchaSettings(); `io` is defaultIo()
 * or a test's stand-in. Secrets are never read here (gitcha.env is read by config.js and only its names reach facts).
 */
export async function gather(settings, io) {
  const facts = { host: io.hostname(), at: io.now().toISOString(), gitcha: { settings: { ...settings } }, cassandra: {}, proxy: {}, system: {}, errors: [] };
  const step = async (name, fn) => { try { await fn(); } catch (err) { facts.errors.push(`${name}: ${err?.message ?? err}`); } };

  await step('gitcha unit', async () => {
    const g = facts.gitcha;
    g.unit = await unitState(io, 'gitcha.service');
    g.journal = await journal(io, 'gitcha');
    g.cannotStart = g.journal.filter((l) => /gitcha: cannot start:/.test(l)).map((l) => l.replace(/^.*gitcha: cannot start: /, ''));
    g.lastCannotStart = g.cannotStart.at(-1) ?? '';
    g.lostLease = g.journal.some((l) => /lost (its|the) lease|lease (was )?lost/i.test(l));
  });
  await step('gitcha port', async () => {
    const g = facts.gitcha;
    const host = ['0.0.0.0', '::', ''].includes(settings.host) ? '127.0.0.1' : settings.host;
    g.portOpen = await io.portOpen(host, settings.port);
    g.health = { ok: false };
    if (g.portOpen) {
      try {
        const { status, body } = await io.fetchJson(`http://${host.includes(':') ? `[${host}]` : host}:${settings.port}/api/v1/health`);
        g.health = { ok: status === 200 && body?.service === 'gitcha', status, version: body?.version ?? '', service: body?.service ?? '' };
      } catch (err) { g.health = { ok: false, error: String(err?.message ?? err) }; }
    }
    if (g.portOpen && !g.health.ok) {
      const ss = await io.run('ss', ['-ltnp']);
      g.portHolder = ss.out.split('\n').find((l) => l.includes(`:${settings.port} `)) ?? '';
    }
  });

  await step('cassandra', async () => {
    const c = facts.cassandra;
    c.wanted = settings.store === 'cassandra';
    c.local = settings.cassandraIsLocal;
    c.installed = await installed(io, 'cassandra');
    c.unit = c.installed || io.exists('/etc/cassandra/cassandra.yaml') ? await unitState(io, 'cassandra.service') : null;
    c.journal = c.unit?.known ? await journal(io, 'cassandra') : [];
    c.systemLog = io.exists('/var/log/cassandra/system.log') ? lastLines(io.readFile('/var/log/cassandra/system.log'), SYSTEM_LOG_LINES) : [];
    if (io.exists('/etc/cassandra/cassandra.yaml')) c.yaml = parseCassandraYaml(io.readFile('/etc/cassandra/cassandra.yaml'));
    const dataDir = '/var/lib/cassandra/data';
    if (io.exists(dataDir)) {
      const keyspaces = io.readdir(dataDir).filter((n) => !n.startsWith('.'));
      c.data = { dir: dataDir, keyspaces, userKeyspaces: keyspaces.filter((k) => !SYSTEM_KEYSPACES.has(k)) };
    } else {
      c.data = { dir: dataDir, keyspaces: [], userKeyspaces: [], missing: true };
    }
    c.ports = {};
    for (const p of settings.contactPoints) c.ports[`${p.host}:${p.port}`] = await io.portOpen(p.host, p.port);
    c.anyPortOpen = Object.values(c.ports).some(Boolean);
    const all = [...c.journal, ...c.systemLog].join('\n');
    const nameClash = /Saved cluster name (.+?) != configured name (.+?)\s*$/m.exec(all);
    c.savedClusterName = nameClash ? nameClash[1].trim() : undefined;
    c.configuredClusterName = nameClash ? nameClash[2].trim() : undefined;
    c.memoryTrouble = /Insufficient memory|Could not reserve enough space|OutOfMemoryError|Cannot allocate memory|There is insufficient memory for the Java Runtime/.test(all);
    c.noJava = /JAVA_HOME|java: not found|Unable to find java|no java/i.test(all) && !c.anyPortOpen;
    c.listenTrouble = /Cannot assign requested address|Unable to bind|Address already in use.*(7000|9042)/.test(all);
  });

  await step('proxy', async () => {
    const p = facts.proxy;
    p.nginx = { installed: await installed(io, 'nginx') };
    if (p.nginx.installed) {
      p.nginx.unit = await unitState(io, 'nginx.service');
      const t = await io.run('nginx', ['-t']);
      p.nginx.configOk = t.code === 0;
      p.nginx.configSays = (t.err || t.out).split('\n').filter(Boolean).slice(-3).join(' ');
      p.nginx.upstreams = [];
      for (const dir of ['/etc/nginx/conf.d', '/etc/nginx/sites-enabled']) {
        if (!io.exists(dir)) continue;
        for (const f of io.readdir(dir)) {
          const text = io.readFile(path.join(dir, f));
          for (const m of text.matchAll(/proxy_pass\s+(\S+?);/g)) p.nginx.upstreams.push({ file: path.join(dir, f), to: m[1] });
        }
      }
    }
    p.caddy = { installed: await installed(io, 'caddy') };
    if (settings.publicUrl) {
      // The public URL, answered by this machine: curl --resolve makes the proxy here answer for its own name.
      const u = new URL(settings.publicUrl);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      const r = await io.run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', '--resolve', `${u.hostname}:${port}:127.0.0.1`, `${settings.publicUrl}/api/v1/health`]);
      p.publicHealth = r.code === 127 ? { skipped: 'curl is not installed' } : { status: Number(r.out.trim()) || 0, ok: r.code === 0 && r.out.trim() === '200', error: r.code === 0 ? '' : r.err.trim() };
    }
  });

  await step('omni', async () => {
    // The Omni gateway, when its package is here: its unit, and /health on loopback (no token needed for that).
    const o = facts.omni = { installed: await installed(io, 'inputloop-gitcha-omni-gateway') };
    if (!o.installed) return;
    o.unit = await unitState(io, 'omni-gateway.service');
    o.membersFile = io.exists('/etc/inputloop/omni/members.json');
    o.portOpen = await io.portOpen('127.0.0.1', 8769);
    o.health = { ok: false };
    if (o.portOpen) {
      try { const { status, body } = await io.fetchJson('http://127.0.0.1:8769/health'); o.health = { ok: status === 200 && body?.ok === true, status, members: body?.members ?? [] }; }
      catch (err) { o.health = { ok: false, error: String(err?.message ?? err) }; }
    }
    o.journal = o.unit?.known ? await journal(io, 'omni-gateway', 40) : [];
    o.memberFaults = o.journal.filter((l) => /omni-gateway: \S+: (exited|no answer|not JSON)/.test(l)).slice(-5);
  });

  await step('system', async () => {
    const s = facts.system;
    const mem = /^MemTotal:\s+(\d+)/m.exec(io.readFile('/proc/meminfo'));
    const avail = /^MemAvailable:\s+(\d+)/m.exec(io.readFile('/proc/meminfo'));
    s.memMB = mem ? Math.round(Number(mem[1]) / 1024) : undefined;
    s.memAvailableMB = avail ? Math.round(Number(avail[1]) / 1024) : undefined;
    s.disks = [];
    for (const p of [settings.dataDir, '/var/lib/cassandra', '/var/log']) {
      if (!io.exists(p)) continue;
      const r = await io.run('df', ['-Pk', p]);
      const row = r.out.split('\n')[1]?.trim().split(/\s+/);
      if (row?.length >= 6) s.disks.push({ path: p, availMB: Math.round(Number(row[3]) / 1024), usedPct: Number(row[4].replace('%', '')) });
    }
  });
  return facts;
}
