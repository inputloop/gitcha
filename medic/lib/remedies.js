// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The remedies, each with its class. The class is the consent gate, and it is mechanical:
//   safe     reversible and data-free (start or restart a service): the medic runs it when GITCHA_MEDIC_HEAL=safe,
//            and an agent may ask for it.
//   confirm  changes files or moves data: runs only when a person types `gitcha-medic --yes NAME`; the medic and
//            any agent can only ask. Each one checks its own preconditions again right before acting, and moves
//            things aside rather than deleting them.
//   manual   hands only: the medic says what it sees and what to try; it has no `run`.
// Nothing here deletes data, edits gitcha.env or debconf.env, or touches secret.key.

const SYSTEM_KEYSPACES = new Set(['system', 'system_auth', 'system_distributed', 'system_schema', 'system_traces', 'system_views', 'system_virtual_schema']);

export const REMEDIES = {
  'start-cassandra': {
    class: 'safe', title: 'start Cassandra',
    how: 'systemctl start cassandra, then wait for 9042 (its first start takes a minute or two).',
    run: async (ctx) => ctx.run('systemctl', ['start', 'cassandra.service'], { timeout: 120_000 }),
  },
  'restart-gitcha': {
    class: 'safe', title: 'restart Gitcha',
    how: 'systemctl restart gitcha; the start is finished only once Gitcha answers its health URL.',
    run: async (ctx) => ctx.run('systemctl', ['restart', 'gitcha.service'], { timeout: 200_000 }),
  },
  'start-gitcha': {
    class: 'safe', title: 'start Gitcha',
    how: 'systemctl start gitcha.',
    run: async (ctx) => ctx.run('systemctl', ['start', 'gitcha.service'], { timeout: 200_000 }),
  },
  'start-nginx': {
    class: 'safe', title: 'start nginx',
    how: 'nginx -t, then systemctl start nginx.',
    run: async (ctx) => {
      const t = await ctx.run('nginx', ['-t']);
      if (t.code !== 0) return { ...t, code: t.code || 1, err: `nginx -t refused the configuration; not started. ${t.err}` };
      return ctx.run('systemctl', ['start', 'nginx.service'], { timeout: 60_000 });
    },
  },
  wait: { class: 'safe', title: 'wait', how: 'Nothing to do but wait; the medic looks again on its next run.', run: async () => ({ code: 0, out: 'waited', err: '' }) },

  'reset-empty-cassandra': {
    class: 'confirm', title: 'move an empty Cassandra data directory aside and start again under the new cluster name',
    how: 'Stops Cassandra, moves /var/lib/cassandra/{data,commitlog,saved_caches,hints} to /var/lib/cassandra/medic-aside-<time>/ (nothing is deleted), and starts it, so it writes a fresh system keyspace under the cluster_name now in cassandra.yaml. Refuses when the data directory holds any keyspace that is not Cassandra\'s own.',
    run: async (ctx) => {
      const io = ctx.io;
      const dir = '/var/lib/cassandra/data';
      const keyspaces = io.exists(dir) ? io.readdir(dir).filter((n) => !n.startsWith('.')) : [];
      const ours = keyspaces.filter((k) => !SYSTEM_KEYSPACES.has(k));
      if (ours.length) return { code: 1, out: '', err: `refused: ${dir} holds keyspaces that are not Cassandra's own (${ours.join(', ')}); use rename-cassandra-cluster or keep the old name` };
      const stop = await ctx.run('systemctl', ['stop', 'cassandra.service'], { timeout: 120_000 });
      if (stop.code !== 0) return { ...stop, err: `could not stop cassandra: ${stop.err}` };
      const aside = `/var/lib/cassandra/medic-aside-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      io.mkdir(aside);
      const moved = [];
      for (const part of ['data', 'commitlog', 'saved_caches', 'hints']) {
        const from = `/var/lib/cassandra/${part}`;
        if (io.exists(from)) { io.rename(from, `${aside}/${part}`); moved.push(part); }
      }
      const start = await ctx.run('systemctl', ['start', 'cassandra.service'], { timeout: 120_000 });
      return { code: start.code, out: `moved ${moved.join(', ')} to ${aside}; ${start.out}`, err: start.err };
    },
  },
  'rename-cassandra-cluster': {
    class: 'manual', title: 'rename a Cassandra node that already holds data',
    how: [
      'Either put the old name back in cassandra.yaml and start Cassandra, or rename the node by hand, in this order:',
      '  1. set cluster_name back to the saved name in /etc/cassandra/cassandra.yaml and start cassandra',
      '  2. cqlsh -e "UPDATE system.local SET cluster_name = \'NEW NAME\' WHERE key = \'local\';"',
      '  3. nodetool flush system local',
      '  4. set cluster_name to NEW NAME in cassandra.yaml and systemctl restart cassandra',
      'Every node of a cluster must carry the same cluster_name; do it on each before they first see one another.',
    ].join('\n'),
  },
  'cap-cassandra-heap': {
    class: 'manual', title: 'give Cassandra a heap this machine can hold',
    how: 'In /etc/cassandra/cassandra-env.sh set MAX_HEAP_SIZE (for example "1G" on a 4 GB machine, with HEAP_NEWSIZE="200M"), or in /etc/cassandra/jvm-server.options set -Xms and -Xmx, then systemctl restart cassandra. Gitcha itself is capped at 2G by its unit.',
  },
  'setup-cassandra': {
    class: 'manual', title: 'install Cassandra here',
    how: 'sudo gitcha-setup-cassandra (adds Apache\'s apt repository, installs and starts one node, restarts Gitcha), or point GITCHA_CASSANDRA_CONTACT_POINTS at a cluster, or set GITCHA_STORE=file.',
  },
  'manual-cassandra-address': { class: 'manual', title: 'make the addresses agree', how: 'cassandra.yaml (listen_address, rpc_address, seeds, native_transport_port) and GITCHA_CASSANDRA_CONTACT_POINTS must name the same place. For one node on this machine: 127.0.0.1 everywhere. For a cluster: each node listens on its mesh address, the seeds list two or three of them, and Gitcha\'s contact points name a few.' },
  'manual-remote-cassandra': { class: 'manual', title: 'look at the Cassandra nodes', how: 'On each node: systemctl status cassandra; nodetool status. Between: a firewall on 9042, or the mesh being down.' },
  'manual-lease': { class: 'manual', title: 'one server per instance', how: 'Stop the other server, or give this one its own GITCHA_CASSANDRA_INSTANCE (dpkg-reconfigure inputloop-gitcha). A lease left by a dead process lapses after 90 s.' },
  'manual-secret-key': { class: 'manual', title: 'restore the right secret.key', how: 'Put back the secret.key that belongs to this database (it is backed up apart from it). Never generate a new one over a database: the accounts in it would be lost.' },
  'manual-port': { class: 'manual', title: 'free the port', how: 'ss -ltnp | grep 4873 says who holds it. Stop that, or set GITCHA_PORT and the proxy\'s upstream to another port.' },
  'manual-lock': { class: 'manual', title: 'one server per data directory', how: 'Find the other gitcha-server (ps aux | grep gitcha-server) and stop it; the unit is the one that should run.' },
  'manual-setting': { class: 'manual', title: 'fix the setting', how: 'The journal line names the setting and what it expects; it is in /etc/inputloop/gitcha/gitcha.env or debconf.env (dpkg-reconfigure inputloop-gitcha). Then systemctl restart gitcha.' },
  'manual-install': { class: 'manual', title: 'install Gitcha', how: 'apt install ./inputloop-gitcha_*.deb, or from the apt repository; DEPLOY.md.' },
  'manual-nginx': { class: 'manual', title: 'mend the proxy', how: 'nginx -t says what is wrong. The upstream must be http://127.0.0.1:4873 (proxy_pass), the server_name the public host, and the certificate files present: /usr/share/doc/inputloop-gitcha/nginx-gitcha.conf.example. Then systemctl reload nginx.' },
  'manual-proxy': { class: 'manual', title: 'put a TLS proxy in front', how: 'Install nginx (or Caddy) with one of the examples in /usr/share/doc/inputloop-gitcha/, or on a trusted network run without one (DEPLOY.md, "Running without a reverse proxy").' },
  'manual-disk': { class: 'manual', title: 'make room', how: 'journalctl --vacuum-size=200M; apt clean; old Cassandra snapshots (nodetool clearsnapshot); old site deploys are kept by GITCHA_KEEP_DEPLOYS.' },
};

/** The remedy a finding names, with its class, or a stand-in for an unknown name. */
export function remedyOf(name) {
  return REMEDIES[name] ?? { class: 'manual', title: name, how: `(no remedy named ${name} is known to this medic)` };
}

/**
 * apply(name, ctx, {allow}): run a remedy if its class is within `allow` ('safe' runs safe ones; 'confirm' runs
 * safe and confirm ones). Returns {name, class, ran, ok, out, err}; a remedy outside the allowance is reported as
 * parked (ran: false), never run. `ctx` holds run (a runner) and io (the probes' io, for files).
 */
export async function apply(name, ctx, { allow = 'safe' } = {}) {
  const r = remedyOf(name);
  const rank = { safe: 0, confirm: 1, manual: 2 };
  const result = { name, class: r.class, title: r.title, ran: false, ok: false, out: '', err: '' };
  if (!r.run || rank[r.class] > rank[allow] ) {
    result.parked = r.class === 'manual' ? 'for hands only' : `needs a person's yes: sudo gitcha-medic --yes ${name}`;
    return result;
  }
  try {
    const got = await r.run(ctx);
    Object.assign(result, { ran: true, ok: got.code === 0, out: (got.out ?? '').trim(), err: (got.err ?? '').trim() });
  } catch (err) {
    Object.assign(result, { ran: true, ok: false, err: String(err?.message ?? err) });
  }
  return result;
}
