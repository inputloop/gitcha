// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The "cassandra" backend of the store (GITCHA_STORE=cassandra): the database lives in an Apache Cassandra
// keyspace instead of db.json. The server still holds it all in memory and still saves after every change;
// only where the save goes is different.
//
// The rows. Every top-level collection (users, sessions, packages...) is split one level down: a header row
// says what the collection is, and each entry is its own row. One table, one partition per Gitcha instance:
//   gitcha_db (instance, coll, item, body, seq)   PRIMARY KEY ((instance), coll, item)
//   (coll, '')       {"t":"o"} for a collection of entries, or {"t":"v","v":...} for any other value
//   (coll, '.KEY')   the JSON of entry KEY (the dot keeps an entry named '' apart from the header)
//   ('!lease', '')   who owns this instance now; ('!meta', 'key') the secret key's check value
// A save sends only the rows that changed since the last one, as one batch in one partition. Cassandra
// applies such a batch whole or not at all, so a crash never leaves half a change. `seq` keeps the order
// entries were added in (Cassandra itself returns them sorted by key): an entry keeps its number when it
// changes and a new one gets the next, as a JavaScript object orders its keys, so lists come back after
// a restart in the order db.json would have kept.
//
// One owner. Like db.lock, a lease row lets one server at a time own an instance: a second server on the
// same instance would erase what the first one wrote. The lease lives 60 seconds and is renewed while the
// server runs. Every save is a lightweight transaction (a compare-and-set) on the lease, so a server that
// lost its lease can never write again: its save is refused, not merged.
//
// Synchronous on purpose. The rest of the server calls store.tx() and expects the change to be saved when
// it returns, exactly as with db.json. The Cassandra driver is asynchronous, so it runs in a worker thread
// (store-cassandra-worker.js) and this thread waits for its answer with Atomics.wait, the way it waits for
// fsync with db.json. Reads never touch Cassandra after start: they are served from memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { StartupError } from './config.js';

const WORKER = new URL('./store-cassandra-worker.js', import.meta.url);
export const LEASE_TTL_S = 60;
// How long a start waits for a lease held by a server on another machine to run out (it may have crashed).
const LEASE_WAIT_MS = (LEASE_TTL_S + 30) * 1000;
const HEADER_OBJECT = '{"t":"o"}';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowKey = (coll, item) => `${coll}\u0000${item}`;

/** The database as rows: a Map from rowKey(coll, item) to the row's JSON body. */
export function toRows(data) {
  const rows = new Map();
  for (const [coll, value] of Object.entries(data)) {
    if (value === undefined) continue; // JSON.stringify leaves these out of db.json too
    if (!isPlain(value)) { rows.set(rowKey(coll, ''), JSON.stringify({ t: 'v', v: value })); continue; }
    rows.set(rowKey(coll, ''), HEADER_OBJECT);
    for (const [k, v] of Object.entries(value)) {
      const body = JSON.stringify(v);
      if (body !== undefined) rows.set(rowKey(coll, `.${k}`), body);
    }
  }
  return rows;
}

/** Rows back into the database. An entry whose header is missing still lands in an object collection. */
export function fromRows(rows) {
  const data = {};
  for (const [key, body] of rows) {
    const [coll, item] = key.split('\u0000');
    if (item !== '') continue;
    const head = JSON.parse(body);
    data[coll] = head.t === 'o' ? {} : head.v;
  }
  for (const [key, body] of rows) {
    const [coll, item] = key.split('\u0000');
    if (item === '') continue;
    if (!isPlain(data[coll])) data[coll] = {};
    data[coll][item.slice(1)] = JSON.parse(body);
  }
  return data;
}

/** What the key check row holds: proof of which secret key wrote this instance, that reveals nothing about it. */
export function keyCheck(secretKey) {
  return crypto.createHmac('sha256', Buffer.from(String(secretKey), 'base64')).update('gitcha cassandra key check v1').digest('hex');
}

/** An error the worker sent back, as an Error on this side (a StartupError when it should stop the start). */
function asError(reply) {
  const err = reply.startup ? new StartupError(reply.error) : new Error(reply.error);
  if (reply.code) err.code = reply.code;
  return err;
}

export class CassandraBackend {
  /** `settings` is config.store.cassandra. `dataDir` is where an older db.json may wait to be imported. */
  constructor({ dataDir, settings, secretKey }) {
    this.dataDir = dataDir;
    this.settings = settings;
    this.secretKey = secretKey;
    this.saved = new Map(); // the rows as Cassandra holds them, after the last save that was answered
    this.seqOf = new Map(); // each saved row's place in the order of insertion
    this.lastSeq = 0;
    this.uncertain = false; // a save whose outcome is unknown (a timeout): read Cassandra again before trusting `saved`
    this.fenced = null; // why this server may no longer write (its lease was lost)
    this.seq = 0;
  }

  /** Start the worker, connect, take the lease and read everything. Imports db.json into an empty instance. */
  load() {
    this.start();
    const owner = JSON.stringify({ host: os.hostname(), pid: process.pid, nonce: crypto.randomBytes(8).toString('hex'), since: new Date().toISOString() });
    const wait = this.settings.leaseWaitMs ?? LEASE_WAIT_MS; // tests shorten it
    const { rows } = this.call('open', { owner, keyCheck: keyCheck(this.secretKey), leaseTtl: LEASE_TTL_S, leaseWaitMs: wait }, wait + this.settings.timeoutMs * 4);
    this.opened = true;
    this.take(rows);
    if (this.saved.size === 0) return this.importFile();
    return fromRows(this.saved);
  }

  /**
   * An instance with no rows yet, and a db.json beside it from a server that used the file backend: copy it
   * across once, then rename the file so nobody edits a copy that no longer counts.
   */
  importFile() {
    const file = path.join(this.dataDir, 'db.json');
    if (!fs.existsSync(file)) return {};
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new StartupError(`${file} is waiting to be imported into Cassandra but is not valid JSON (${err.message}). Restore it from a backup, or move it away to start empty.`);
    }
    if (!isPlain(data)) throw new StartupError(`${file} does not hold a Gitcha database; move it away to start with an empty Cassandra instance.`);
    this.save(data);
    const done = `${file}.imported-to-cassandra`;
    fs.renameSync(file, done);
    const { keyspace, instance } = this.settings;
    console.log(`gitcha: imported ${file} into Cassandra (keyspace ${keyspace}, instance ${instance}); the old file is now ${done}`);
    return data;
  }

  /** Rows as the worker read them ([key, body, seq]), in their order of insertion, become what is saved. */
  take(rows) {
    rows.sort((a, b) => (a[2] ?? Infinity) - (b[2] ?? Infinity) || (a[0] < b[0] ? -1 : 1));
    this.saved = new Map(rows.map(([key, body]) => [key, body]));
    this.seqOf = new Map(rows.map(([key, , seq]) => [key, seq ?? 0]));
    this.lastSeq = rows.reduce((n, r) => Math.max(n, r[2] ?? 0), this.lastSeq);
    this.uncertain = false;
  }

  /** Send only the rows that changed. Throws if Cassandra refused or did not answer; then nothing is assumed saved. */
  save(data) {
    // After a save that may or may not have landed, diff against what Cassandra really holds (or fail here).
    if (this.uncertain) this.take(this.call('load', {}).rows);
    const rows = toRows(data);
    const upserts = [];
    const deletes = [];
    const added = new Map();
    for (const [key, body] of rows) {
      if (this.saved.get(key) === body) continue;
      let seq = this.seqOf.get(key);
      if (seq === undefined) added.set(key, (seq = ++this.lastSeq));
      upserts.push([...key.split('\u0000'), body, seq]);
    }
    for (const key of this.saved.keys()) if (!rows.has(key)) deletes.push(key.split('\u0000'));
    if (!upserts.length && !deletes.length) return;
    try {
      this.call('commit', { upserts, deletes });
    } catch (err) {
      // A refused batch changed nothing. A timeout may or may not have landed: find out before the next diff.
      if (err.code !== 'refused') this.uncertain = true;
      throw err;
    }
    this.saved = rows;
    for (const [key, seq] of added) this.seqOf.set(key, seq);
    for (const [coll, item] of deletes) this.seqOf.delete(rowKey(coll, item));
  }

  /**
   * What restore() goes back to: the last rows Cassandra confirmed, read again if the last save is in doubt.
   * If Cassandra cannot be read either, the last confirmed rows, and the next save reads it first.
   */
  reload() {
    if (this.uncertain) {
      try { this.take(this.call('load', {}).rows); } catch { /* still in doubt: save() tries again */ }
    }
    return fromRows(this.saved);
  }

  /** Give the lease back and stop the worker. */
  close() {
    if (!this.worker) return;
    try { if (this.opened && !this.fenced) this.call('close', {}); } finally {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // ---- the worker and the synchronous call -----------------------------------------------------------

  start() {
    const { port1, port2 } = new MessageChannel();
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    this.port = port1;
    this.worker = new Worker(WORKER, { workerData: { port: port2, flag: this.flag, settings: this.settings }, transferList: [port2] });
    // The worker tells this thread, between requests, when a renewal found the lease taken by another server.
    this.worker.on('message', (m) => {
      if (m?.lost) {
        this.fenced = m.lost;
        console.error(`gitcha: ${m.lost}`);
      }
    });
    this.worker.on('error', (err) => { this.fenced ??= `the Cassandra worker stopped: ${err.message}`; console.error(`gitcha: ${this.fenced}`); });
    this.worker.unref();
  }

  /**
   * Ask the worker to do `op` and wait (blocking this thread) for its answer. Answers carry the request's id,
   * so a late answer to an earlier request that timed out is recognised and dropped.
   */
  call(op, args, timeoutMs = this.settings.timeoutMs) {
    if (this.fenced && op !== 'load') throw Object.assign(new Error(`Gitcha may not write to Cassandra any more: ${this.fenced}`), { code: 'refused' });
    if (!this.worker) throw new Error('the Cassandra backend is closed');
    const id = ++this.seq;
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ id, op, args });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let m;
      while ((m = receiveMessageOnPort(this.port))) {
        if (m.message.id !== id) continue;
        if (m.message.error) throw asError(m.message);
        return m.message.result;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const err = new Error(`Cassandra did not answer "${op}" within ${Math.round(timeoutMs / 1000)} s (contact points ${this.settings.contactPoints.join(', ')})`);
        throw op === 'open' ? new StartupError(err.message) : err;
      }
      Atomics.wait(this.flag, 0, 0, left);
      Atomics.store(this.flag, 0, 0);
    }
  }
}
