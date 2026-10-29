// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The worker thread that talks to Cassandra for store-cassandra.js. The main thread posts one request at a
// time ({ id, op, args }) and waits; this thread does it with the asynchronous driver, posts the answer and
// wakes the main thread through the shared flag. Between requests it renews the lease on its own timer.
import os from 'node:os';
import fs from 'node:fs';
import { workerData, parentPort } from 'node:worker_threads';

const { port, flag, settings } = workerData;
// Each batch stays well under Cassandra's largest mutation (half of commitlog_segment_size, 16 MiB by default).
const BATCH_BYTES = 4 * 1024 * 1024;
const LEASE = ['!lease', ''];
const KEY = ['!meta', 'key'];

let driver;
let client;
let table;
let owner = null; // our lease body, once we hold the lease
let leaseTtl = 60;
let renewTimer = null;
let lost = null;
// One operation at a time: two lightweight transactions of ours on the same partition would only contend.
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

/** An error for the main thread. `startup` ones stop the server's start with a one-line message. */
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/** Parse "SimpleStrategy:1" or "NetworkTopologyStrategy:dc1=3,dc2=3" into CQL replication options. */
function replication(spec) {
  const [cls, rest = ''] = spec.split(':');
  if (cls === 'SimpleStrategy') return `{'class': 'SimpleStrategy', 'replication_factor': ${Number(rest) || 1}}`;
  const dcs = rest.split(',').filter(Boolean).map((p) => p.split('=')).map(([dc, n]) => `'${dc}': ${Number(n)}`);
  return `{'class': 'NetworkTopologyStrategy', ${dcs.join(', ')}}`;
}

async function connect() {
  try {
    driver = (await import(settings.driverModule ?? 'cassandra-driver')).default;
  } catch (err) {
    throw fail(`GITCHA_STORE=cassandra, but this Gitcha was built without Cassandra support (${err.code ?? err.message}). Install the server's optional dependency cassandra-driver, or set GITCHA_STORE=file.`, { startup: true });
  }
  // The driver names its levels in camelCase (LOCAL_QUORUM is consistencies.localQuorum).
  const level = (name) => {
    const n = driver.types.consistencies[name.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase())];
    if (n === undefined) throw fail(`this Cassandra driver has no consistency level ${name}`, { startup: true });
    return n;
  };
  const opts = {
    contactPoints: settings.contactPoints,
    localDataCenter: settings.datacenter,
    queryOptions: { consistency: level(settings.consistency), serialConsistency: level(settings.serialConsistency), prepare: true },
    socketOptions: { readTimeout: settings.timeoutMs },
  };
  if (settings.username) opts.credentials = { username: settings.username, password: settings.password ?? '' };
  if (settings.tls) opts.sslOptions = { rejectUnauthorized: true, ...(settings.caFile ? { ca: [fs.readFileSync(settings.caFile)] } : {}) };
  client = new driver.Client(opts);
  try {
    await client.connect();
  } catch (err) {
    throw fail(`cannot reach Cassandra at ${settings.contactPoints.join(', ')} (data center ${settings.datacenter}): ${err.message}`, { startup: true });
  }
  const ks = settings.keyspace;
  if (settings.createKeyspace) await client.execute(`CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = ${replication(settings.replication)}`);
  table = `${ks}.gitcha_db`;
  await client.execute(`CREATE TABLE IF NOT EXISTS ${table} (instance text, coll text, item text, body text, seq bigint, PRIMARY KEY ((instance), coll, item))`);
}

const get = async ([coll, item]) => (await client.execute(`SELECT body FROM ${table} WHERE instance = ? AND coll = ? AND item = ?`, [settings.instance, coll, item])).first()?.body ?? null;

/** Is process `pid` on this machine still running? EPERM means it exists but belongs to another user. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Take the lease. A lease left by a server on this machine whose process is gone is taken over at once;
 * one held from another machine is waited out (it lapses 60 s after that server stopped renewing it).
 */
async function acquire(body, waitMs) {
  const deadline = Date.now() + waitMs;
  let said = false;
  for (;;) {
    const rs = await client.execute(`INSERT INTO ${table} (instance, coll, item, body) VALUES (?, ?, ?, ?) IF NOT EXISTS USING TTL ?`, [settings.instance, ...LEASE, body, leaseTtl]);
    if (rs.wasApplied()) return;
    const theirs = rs.first().body;
    let held = {};
    try { held = JSON.parse(theirs); } catch { /* not ours to read: wait it out */ }
    // Our own pid is an earlier store in this same process (a test restarting the app), as with db.lock.
    if (held.host === os.hostname() && Number.isInteger(held.pid) && (held.pid === process.pid || !pidAlive(held.pid))) {
      const take = await client.execute(`UPDATE ${table} USING TTL ? SET body = ? WHERE instance = ? AND coll = ? AND item = ? IF body = ?`, [leaseTtl, body, settings.instance, ...LEASE, theirs]);
      if (take.wasApplied()) return;
      continue;
    }
    if (Date.now() >= deadline) {
      throw fail(`another Gitcha server (${held.host ?? '?'}, pid ${held.pid ?? '?'}, since ${held.since ?? '?'}) owns instance "${settings.instance}" in keyspace ${settings.keyspace}. Run one Gitcha server per instance: stop that one, or give this one its own GITCHA_CASSANDRA_INSTANCE.`, { startup: true });
    }
    if (!said) { console.error(`gitcha: instance "${settings.instance}" is held by ${held.host ?? '?'} (pid ${held.pid ?? '?'}); waiting up to ${Math.round(waitMs / 1000)} s for it to lapse`); said = true; }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The statement that renews our lease, and fails the batch it is in if the lease is no longer ours. */
const fence = () => ({ query: `UPDATE ${table} USING TTL ? SET body = ? WHERE instance = ? AND coll = ? AND item = ? IF body = ?`, params: [leaseTtl, owner, settings.instance, ...LEASE, owner] });

function loseLease(why) {
  lost = why;
  clearInterval(renewTimer);
  parentPort.postMessage({ lost: why });
}

async function renew() {
  if (!owner || lost) return;
  try {
    const rs = await client.execute(fence().query, fence().params);
    if (!rs.wasApplied()) loseLease(`the lease on Cassandra instance "${settings.instance}" was taken by ${rs.first()?.body ?? 'nobody (it lapsed)'}; this server will refuse every change until it is restarted`);
  } catch (err) {
    console.error(`gitcha: renewing the Cassandra lease failed (${err.message}); retrying`);
  }
}

// seq is a bigint: the driver reads it as a Long and wants one back.
const toLong = (n) => (driver.types.Long ? driver.types.Long.fromNumber(n) : n);
const fromLong = (v) => (v === null || v === undefined ? null : typeof v === 'number' ? v : v.toNumber());

/** Every data row of this instance, as [rowKey, body, seq]. */
async function readAll() {
  const rows = [];
  const stream = client.stream(`SELECT coll, item, body, seq FROM ${table} WHERE instance = ?`, [settings.instance], { prepare: true, fetchSize: 1000, autoPage: true });
  for await (const r of stream) if (!r.coll.startsWith('!')) rows.push([`${r.coll}\u0000${r.item}`, r.body, fromLong(r.seq)]);
  return rows;
}

const OPS = {
  async open({ owner: body, keyCheck, leaseTtl: ttl, leaseWaitMs }) {
    leaseTtl = ttl;
    await connect();
    await acquire(body, leaseWaitMs);
    owner = body;
    renewTimer = setInterval(() => serial(renew), (leaseTtl * 1000) / 4);
    const check = await get(KEY);
    if (check === null) {
      await client.execute(`INSERT INTO ${table} (instance, coll, item, body) VALUES (?, ?, ?, ?)`, [settings.instance, ...KEY, keyCheck]);
    } else if (check !== keyCheck) {
      throw fail(`Cassandra instance "${settings.instance}" in keyspace ${settings.keyspace} was written with a different secret key, so no account in it could be opened. Restore the secret.key (or GITCHA_SECRET_KEY) that belongs to it. If this server just made a new secret.key, delete that file first.`, { startup: true });
    }
    return { rows: await readAll() };
  },

  async load() { return { rows: await readAll() }; },

  /** Write the changed rows: batches of one partition, each fenced by the lease, so each lands whole or not at all. */
  async commit({ upserts, deletes }) {
    if (lost) throw fail(lost, { code: 'refused' });
    const statements = [
      ...deletes.map(([coll, item]) => ({ query: `DELETE FROM ${table} WHERE instance = ? AND coll = ? AND item = ?`, params: [settings.instance, coll, item], size: 64 })),
      ...upserts.map(([coll, item, body, seq]) => ({ query: `INSERT INTO ${table} (instance, coll, item, body, seq) VALUES (?, ?, ?, ?, ?)`, params: [settings.instance, coll, item, body, toLong(seq)], size: body.length + coll.length + item.length + 8 })),
    ];
    const batches = [[]];
    let bytes = 0;
    for (const s of statements) {
      if (bytes + s.size > BATCH_BYTES && batches.at(-1).length) { batches.push([]); bytes = 0; }
      batches.at(-1).push(s);
      bytes += s.size;
    }
    for (const batch of batches) {
      const rs = await client.batch([fence(), ...batch.map(({ query, params }) => ({ query, params }))], { prepare: true, logged: true });
      if (!rs.wasApplied()) {
        loseLease(`the lease on Cassandra instance "${settings.instance}" is no longer this server's; a save was refused`);
        throw fail(lost, { code: 'refused' });
      }
    }
    return {};
  },

  async close() {
    clearInterval(renewTimer);
    if (owner && !lost) await client.execute(`DELETE FROM ${table} WHERE instance = ? AND coll = ? AND item = ? IF body = ?`, [settings.instance, ...LEASE, owner]).catch(() => {});
    owner = null;
    await client?.shutdown().catch(() => {});
    return {};
  },
};

port.on('message', ({ id, op, args }) => {
  serial(() => OPS[op](args)).then(
    (result) => port.postMessage({ id, result }),
    (err) => port.postMessage({ id, error: err.message, startup: Boolean(err.startup), code: err.code }),
  ).finally(() => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); });
});
