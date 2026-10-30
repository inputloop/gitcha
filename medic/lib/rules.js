// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The rules: from facts to findings, with no AI and no guessing. Each finding names what is wrong in plain words,
// why the medic thinks so (the fact it rests on), and the remedy that fits, by name (lib/remedies.js says what a
// remedy does and whether it is safe to run unasked, needs a person's yes, or is for hands only).
//
// A finding's level: bad (Gitcha is not serving, or will not), warn (it serves, but something will bite), info
// (worth knowing), ok (a thing that is as it should be, kept for the report).

const f = (id, level, what, why, remedy, extra = {}) => ({ id, level, what, why, ...(remedy ? { remedy } : {}), ...extra });
const active = (u) => u?.known && u.active === 'active';

/** diagnose(facts): the findings, most pressing first, in the order a person should read them. */
export function diagnose(facts) {
  const out = [];
  const g = facts.gitcha ?? {};
  const c = facts.cassandra ?? {};
  const p = facts.proxy ?? {};
  const s = facts.system ?? {};
  const set = g.settings ?? {};
  const gitchaUp = g.health?.ok === true;

  // ---- the database, first: when it is down, every Gitcha symptom follows from it -----------------------------
  if (c.wanted && c.local) {
    if (!c.installed && !c.unit?.known) {
      out.push(f('cassandra-not-installed', 'bad',
        'Gitcha is set to keep its database in Cassandra on this machine, but no Cassandra is installed here.',
        `GITCHA_STORE=cassandra with contact point ${set.contactPoints?.map((x) => x.host).join(', ')}; dpkg knows no cassandra package.`,
        'setup-cassandra'));
    } else if (c.savedClusterName !== undefined) {
      const empty = (c.data?.userKeyspaces ?? []).length === 0;
      out.push(f('cassandra-cluster-name', 'bad',
        `Cassandra refuses to start: its data on disk was written under the cluster name "${c.savedClusterName}", and cassandra.yaml now says "${c.configuredClusterName}". Cassandra will not change a node's cluster name in place.`,
        `Its log says: Saved cluster name ${c.savedClusterName} != configured name ${c.configuredClusterName}.` + (empty
          ? ` The data directory holds only Cassandra's own keyspaces (${(c.data?.keyspaces ?? []).join(', ') || 'none'}), so nothing of Gitcha's is in it yet.`
          : ` The data directory holds keyspaces of ours: ${c.data.userKeyspaces.join(', ')}. Those must be kept.`),
        empty ? 'reset-empty-cassandra' : 'rename-cassandra-cluster'));
    } else if (c.memoryTrouble) {
      out.push(f('cassandra-memory', 'bad',
        'Cassandra cannot get the memory its Java heap asks for, so it stops at start-up.',
        `Its log speaks of insufficient memory; this machine has ${s.memMB ?? '?'} MB in all${s.memAvailableMB ? `, ${s.memAvailableMB} MB free` : ''}.`,
        'cap-cassandra-heap'));
    } else if (c.listenTrouble) {
      out.push(f('cassandra-listen', 'bad',
        `Cassandra cannot bind its address (listen_address ${c.yaml?.listenAddress ?? '?'}, rpc_address ${c.yaml?.rpcAddress ?? '?'}).`,
        'Its log says it could not bind or assign the address; the address in cassandra.yaml is not one this machine has, or another process holds the port.',
        'manual-cassandra-address'));
    } else if (c.unit?.known && !active(c.unit) && c.unit.active !== 'activating') {
      out.push(f('cassandra-stopped', 'bad',
        `Cassandra is installed but not running (systemd says ${c.unit.active}/${c.unit.sub}${c.unit.result && c.unit.result !== 'success' ? `, result ${c.unit.result}` : ''}).`,
        c.unit.enabled === 'enabled' ? 'The unit is enabled, so it is meant to run.' : `The unit is ${c.unit.enabled || 'not enabled'}.`,
        'start-cassandra'));
    } else if (c.unit?.active === 'activating' || (active(c.unit) && !c.anyPortOpen)) {
      out.push(f('cassandra-starting', 'warn',
        'Cassandra is running but does not answer on its client port yet; its first start takes a minute or two, longer on a small machine.',
        `systemd says ${c.unit.active}/${c.unit.sub}; port ${Object.keys(c.ports ?? {}).join(', ')} is closed.`,
        'wait'));
    } else if (active(c.unit) && c.anyPortOpen) {
      out.push(f('cassandra-up', 'ok', 'Cassandra is running and answers on its client port.', `systemd: active/${c.unit.sub}; ports: ${Object.entries(c.ports).filter(([, v]) => v).map(([k]) => k).join(', ')}.`));
    }
    if (c.yaml && !['127.0.0.1', 'localhost'].includes(c.yaml.rpcAddress ?? '127.0.0.1') && set.contactPoints?.every((x) => ['127.0.0.1', 'localhost'].includes(x.host))) {
      out.push(f('cassandra-rpc-address', 'warn',
        `Cassandra answers clients on ${c.yaml.rpcAddress}, but Gitcha is told to connect to 127.0.0.1.`,
        'cassandra.yaml rpc_address and GITCHA_CASSANDRA_CONTACT_POINTS disagree; one of them has to change when this node joins a cluster.',
        'manual-cassandra-address'));
    }
    if (c.yaml && c.yaml.nativeTransportPort !== 9042 && set.contactPoints?.some((x) => x.port === 9042)) {
      out.push(f('cassandra-port', 'warn', `Cassandra's client port is ${c.yaml.nativeTransportPort}, but Gitcha connects to 9042.`, 'native_transport_port in cassandra.yaml and GITCHA_CASSANDRA_CONTACT_POINTS disagree.', 'manual-cassandra-address'));
    }
    if (s.memMB !== undefined && s.memMB < 3500) {
      out.push(f('memory-small', 'warn', `This machine has ${s.memMB} MB of memory; Cassandra wants about 4 GB beside Gitcha.`, 'From /proc/meminfo. A small heap (cassandra-env.sh MAX_HEAP_SIZE) keeps a small machine usable; the default heap takes a quarter to half of the memory.', 'cap-cassandra-heap'));
    }
  } else if (c.wanted && !c.anyPortOpen) {
    out.push(f('cassandra-unreachable', 'bad',
      `None of Gitcha's Cassandra nodes answers: ${Object.keys(c.ports ?? {}).join(', ')}.`,
      'They are on other machines, so the medic cannot start them from here. Check them there (systemctl status cassandra), the network between, and the firewall on 9042.',
      'manual-remote-cassandra'));
  }

  // ---- Gitcha itself ------------------------------------------------------------------------------------------
  const why = g.lastCannotStart;
  if (gitchaUp) {
    out.push(f('gitcha-up', 'ok', `Gitcha v${g.health.version} is running and answers its health URL.`, `systemd: ${g.unit?.active ?? '?'}/${g.unit?.sub ?? '?'}, ${g.unit?.restarts ?? 0} restart(s).`));
    if (g.lostLease) out.push(f('gitcha-lost-lease', 'bad', 'Gitcha lost its Cassandra lease and refuses every change until it is restarted.', 'Its journal says the lease was lost (another server took the instance, or Cassandra was away too long).', 'restart-gitcha'));
  } else if (g.portOpen && !g.health.ok) {
    out.push(f('gitcha-port-taken', 'bad', `Something answers on ${set.host}:${set.port}, but it is not Gitcha.`, `Health check: ${g.health.status ? `HTTP ${g.health.status}` : g.health.error ?? 'no JSON'}; ${g.portHolder || 'ss did not say who holds the port'}.`, 'manual-port'));
  } else if (!g.unit?.known) {
    out.push(f('gitcha-not-installed', 'bad', 'There is no gitcha.service on this machine.', 'systemd does not know the unit; the inputloop-gitcha package is not installed, or systemd is not running.', 'manual-install'));
  } else if (/cannot reach Cassandra/.test(why) && (c.anyPortOpen || !c.wanted)) {
    out.push(f('gitcha-waiting-for-cassandra', c.anyPortOpen ? 'warn' : 'bad',
      c.anyPortOpen ? 'Gitcha failed to start while Cassandra was down; Cassandra answers now, so a restart will bring Gitcha up (systemd retries every 5 s by itself).' : 'Gitcha cannot start because it cannot reach Cassandra.',
      `Journal: cannot start: ${why}`, c.anyPortOpen ? 'restart-gitcha' : undefined));
  } else if (/cannot reach Cassandra/.test(why)) {
    // The cause is the Cassandra finding above; say so, so the reader does not count two faults.
    out.push(f('gitcha-down-cassandra', 'bad', 'Gitcha is down because its database is down (see the Cassandra finding above). It keeps trying every 5 s and comes up by itself once Cassandra answers.', `Journal: cannot start: ${why}`));
  } else if (/owns instance/.test(why)) {
    out.push(f('gitcha-lease-held', 'bad', 'Another Gitcha server owns this instance in Cassandra, so this one will not start.', `Journal: cannot start: ${why}`, 'manual-lease'));
  } else if (/different secret key/.test(why)) {
    out.push(f('gitcha-secret-key', 'bad', 'The database was written with a different secret.key than the one in the data directory. Gitcha will not open it, and nothing automatic should.', `Journal: cannot start: ${why}`, 'manual-secret-key'));
  } else if (/EADDRINUSE|could not listen/.test(why)) {
    out.push(f('gitcha-port-in-use', 'bad', `Gitcha cannot open ${set.host}:${set.port}; something else holds it.`, `Journal: cannot start: ${why}`, 'manual-port'));
  } else if (/already using/.test(why)) {
    out.push(f('gitcha-data-dir-locked', 'bad', 'Another process is using /var/lib/gitcha (a hand-started gitcha-server beside the unit?).', `Journal: cannot start: ${why}`, 'manual-lock'));
  } else if (why) {
    out.push(f('gitcha-setting', 'bad', 'Gitcha refuses to start over a setting.', `Journal: cannot start: ${why}`, 'manual-setting'));
  } else if (g.unit.active === 'activating') {
    out.push(f('gitcha-starting', 'warn', 'Gitcha is starting (systemd waits for it to answer its health URL).', `systemd: activating/${g.unit.sub}.`, 'wait'));
  } else if (g.unit.active !== 'active') {
    out.push(f('gitcha-stopped', g.unit.enabled === 'enabled' ? 'bad' : 'info',
      g.unit.enabled === 'enabled' ? `Gitcha is enabled but not running (systemd says ${g.unit.active}/${g.unit.sub}).` : 'Gitcha is installed and not running, and not enabled: nobody has asked for it yet.',
      g.unit.enabled === 'enabled' ? 'The unit is enabled, so it is meant to run; its journal shows no "cannot start" line.' : 'systemctl enable --now gitcha starts it, once its database is up.',
      g.unit.enabled === 'enabled' ? 'start-gitcha' : undefined));
  } else {
    out.push(f('gitcha-silent', 'bad', 'Gitcha runs, but its health URL does not answer.', `systemd: active/${g.unit.sub}; port ${set.host}:${set.port} ${g.portOpen ? 'open' : 'closed'}.`, 'restart-gitcha'));
  }

  // ---- the proxy ----------------------------------------------------------------------------------------------
  if (p.nginx?.installed) {
    if (p.nginx.configOk === false) out.push(f('nginx-config', 'bad', 'nginx refuses its own configuration, so it cannot reload or restart.', `nginx -t: ${p.nginx.configSays}`, 'manual-nginx'));
    else if (!active(p.nginx.unit)) out.push(f('nginx-stopped', 'bad', `nginx is installed but not running (${p.nginx.unit?.active ?? '?'}/${p.nginx.unit?.sub ?? '?'}).`, 'Nothing answers on 443 for Gitcha until it does.', 'start-nginx'));
    // A proxy_pass in a file named for Gitcha, or aimed at its port, that does not reach where Gitcha listens.
    const here = `${['0.0.0.0', '::', ''].includes(set.host) ? '127.0.0.1' : set.host}:${set.port}`;
    const wrong = (p.nginx.upstreams ?? []).filter((u) => (/gitcha/i.test(u.file) || /4873|gitcha/.test(u.to)) && !u.to.includes(here));
    if (wrong.length) out.push(f('nginx-upstream', 'warn', `nginx sends Gitcha's traffic to ${wrong.map((u) => u.to).join(', ')}, but Gitcha listens on ${set.host}:${set.port}.`, `proxy_pass in ${wrong.map((u) => u.file).join(', ')}.`, 'manual-nginx'));
    if (gitchaUp && p.publicHealth && !p.publicHealth.skipped && !p.publicHealth.ok) {
      out.push(f('proxy-502', 'bad', `Gitcha answers on this machine, but through the proxy ${set.publicUrl} answers ${p.publicHealth.status ? `HTTP ${p.publicHealth.status}` : 'nothing'}.`, `curl --resolve to 127.0.0.1: ${p.publicHealth.error || `HTTP ${p.publicHealth.status}`}. The proxy's upstream, certificate or server_name is off.`, 'manual-nginx'));
    } else if (gitchaUp && p.publicHealth?.ok) {
      out.push(f('proxy-up', 'ok', `${set.publicUrl} answers through the proxy on this machine.`, 'curl --resolve to 127.0.0.1 got HTTP 200 from /api/v1/health.'));
    }
  } else if (!p.caddy?.installed && gitchaUp && /^https:/.test(set.publicUrl)) {
    out.push(f('no-proxy', 'warn', `No nginx or Caddy is installed here, yet the public URL is ${set.publicUrl}.`, 'Gitcha listens on loopback only; without a TLS proxy on this machine nobody reaches it.', 'manual-proxy'));
  }

  // ---- the Omni gateway, when its package is here ---------------------------------------------------------------
  const o = facts.omni;
  if (o?.installed) {
    if (!o.membersFile) {
      out.push(f('omni-no-members', 'info', 'The Omni gateway is installed but has no members file yet, so it has nothing to serve.', 'No /etc/inputloop/omni/members.json; the example is beside the package docs.', 'manual-omni'));
    } else if (o.unit?.known && o.unit.active !== 'active' && o.unit.active !== 'activating') {
      out.push(f('omni-gateway-stopped', o.unit.enabled === 'enabled' ? 'bad' : 'info',
        o.unit.enabled === 'enabled' ? `The Omni gateway is enabled but not running (${o.unit.active}/${o.unit.sub}).` : 'The Omni gateway is installed with a members file, and not enabled.',
        o.unit.enabled === 'enabled' ? 'Cloud sessions cannot reach the memory seat or Tavern through it until it runs.' : 'systemctl enable --now omni-gateway starts it, once omni-gateway --check is clean.',
        o.unit.enabled === 'enabled' ? 'start-omni-gateway' : undefined));
    } else if (o.unit?.active === 'active' && !o.health?.ok) {
      out.push(f('omni-gateway-silent', 'bad', 'The Omni gateway runs but /health on 127.0.0.1:8769 does not answer.', `port ${o.portOpen ? 'open' : 'closed'}; ${o.health?.error ?? `HTTP ${o.health?.status ?? '?'}`}. OMNI_LISTEN in gateway.env may name another address.`, 'restart-omni-gateway'));
    } else if (o.health?.ok) {
      out.push(f('omni-gateway-up', 'ok', `The Omni gateway answers, with members ${o.health.members.join(', ') || '(none)'}.`, 'GET /health on 127.0.0.1:8769 said ok.'));
      if (o.memberFaults?.length) out.push(f('omni-member-faults', 'warn', 'One or more Omni members failed recently (their program exited or did not answer).', `Journal: ${o.memberFaults.join(' | ')}`, 'manual-omni'));
    }
  }

  // ---- the machine --------------------------------------------------------------------------------------------
  for (const d of s.disks ?? []) {
    if (d.usedPct >= 95 || d.availMB < 512) out.push(f(`disk-${d.path}`, 'bad', `The disk under ${d.path} is ${d.usedPct}% full (${d.availMB} MB left).`, 'Cassandra stops writing and Gitcha cannot save when it runs out.', 'manual-disk'));
    else if (d.usedPct >= 85) out.push(f(`disk-${d.path}`, 'warn', `The disk under ${d.path} is ${d.usedPct}% full (${d.availMB} MB left).`, 'Worth clearing before it is a fault.', 'manual-disk'));
  }
  for (const e of facts.errors ?? []) out.push(f('probe-failed', 'info', `A probe could not run: ${e}`, 'The other findings stand; this one is a gap in what the medic could see.'));

  const rank = { bad: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** One line that says how things stand, for syslog and a chat room. */
export function headline(findings, facts) {
  const bad = findings.filter((x) => x.level === 'bad');
  const warn = findings.filter((x) => x.level === 'warn');
  const up = findings.some((x) => x.id === 'gitcha-up');
  if (!bad.length && !warn.length) return `${facts.host}: Gitcha is up and nothing needs doing.`;
  if (!bad.length) return `${facts.host}: Gitcha is up; ${warn.length} thing(s) to look at: ${warn.map((x) => x.id).join(', ')}.`;
  return `${facts.host}: ${up ? 'Gitcha is up but' : 'Gitcha is DOWN:'} ${bad.map((x) => x.id).join(', ')}${warn.length ? `; also ${warn.map((x) => x.id).join(', ')}` : ''}.`;
}

/** A short stable string for "has anything changed since the last run?" (ids and levels, not wording). */
export function digest(findings) {
  return findings.filter((x) => x.level !== 'ok').map((x) => `${x.level}:${x.id}`).sort().join(' ') || 'ok';
}
