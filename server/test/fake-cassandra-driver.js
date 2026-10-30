// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A stand-in for the cassandra-driver package, enough for store-cassandra-worker.js: it understands the
// handful of statements the worker sends. Its rows live in the JSON file named by GITCHA_FAKE_CASSANDRA, so
// they outlive one worker thread (a restart) just as a real cluster's do. A test can set `failNext` in that
// file to make the next batch fail without applying it ('error'), or apply it and then fail ('lost-answer'),
// and `failReads` to make that many reads of all the rows fail.
import fs from 'node:fs';

const file = () => process.env.GITCHA_FAKE_CASSANDRA;
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { rows: {}, batches: [], clients: [] }; } };
const save = (s) => fs.writeFileSync(file(), JSON.stringify(s));
const k = (instance, coll, item) => JSON.stringify([instance, coll, item]);
const live = (s, key) => { const r = s.rows[key]; return r && (!r.until || r.until > Date.now()) ? r : null; };
const result = (applied, row) => ({ wasApplied: () => applied, first: () => row ?? null });

/** Apply one statement to state `s`. Returns the result a real cluster would give. */
function run(s, query, p) {
  if (/^CREATE /.test(query)) return result(true);
  if (/^INSERT .* IF NOT EXISTS USING TTL \?$/.test(query)) {
    const [instance, coll, item, body, ttl] = p;
    const have = live(s, k(instance, coll, item));
    if (have) return result(false, { body: have.body });
    s.rows[k(instance, coll, item)] = { body, until: Date.now() + ttl * 1000 };
    return result(true);
  }
  if (/^INSERT /.test(query)) { const [instance, coll, item, body, seq] = p; s.rows[k(instance, coll, item)] = { body, seq }; return result(true); }
  if (/^UPDATE .* IF body = \?$/.test(query)) {
    const [ttl, body, instance, coll, item, expect] = p;
    const have = live(s, k(instance, coll, item));
    if (have?.body !== expect) return result(false, have ? { body: have.body } : null);
    s.rows[k(instance, coll, item)] = { body, until: Date.now() + ttl * 1000 };
    return result(true);
  }
  if (/^DELETE .* IF body = \?$/.test(query)) {
    const [instance, coll, item, expect] = p;
    if (live(s, k(instance, coll, item))?.body !== expect) return result(false);
    delete s.rows[k(instance, coll, item)];
    return result(true);
  }
  if (/^DELETE /.test(query)) { delete s.rows[k(...p)]; return result(true); }
  if (/^SELECT body /.test(query)) { const r = live(s, k(...p)); return result(true, r ? { body: r.body } : null); }
  throw new Error(`fake cassandra: unknown statement ${query}`);
}

class Client {
  constructor(options) { this.options = options; }
  async connect() {
    const s = load();
    if (s.down) throw new Error('All host(s) tried for query failed (fake)');
    s.clients.push({ consistency: this.options.queryOptions.consistency, serial: this.options.queryOptions.serialConsistency, dc: this.options.localDataCenter });
    save(s);
  }
  async execute(query, params = []) { const s = load(); const r = run(s, query, params); save(s); return r; }
  async batch(queries) {
    const s = load();
    const why = s.failNext;
    delete s.failNext;
    if (why === 'error') { save(s); throw new Error(`fake cassandra: batch failed (${why})`); }
    const [fence, ...rest] = queries;
    const ok = run(s, fence.query, fence.params);
    if (!ok.wasApplied()) { save(s); return ok; }
    for (const q of rest) run(s, q.query, q.params);
    s.batches.push(rest.length);
    save(s);
    // 'lost-answer': the batch landed, but its answer never came back (a timeout, as far as the server knows).
    if (why === 'lost-answer') throw new Error('fake cassandra: write timeout (the batch did land)');
    return ok;
  }
  async *stream(query, [instance]) {
    const s = load();
    if (s.failReads) { s.failReads--; save(s); throw new Error('fake cassandra: read failed'); }
    for (const key of Object.keys(s.rows).sort()) {
      const [inst, coll, item] = JSON.parse(key);
      if (inst === instance && live(s, key)) yield { coll, item, body: s.rows[key].body, seq: s.rows[key].seq ?? null };
    }
  }
  async shutdown() {}
}

// The real driver's names and numbers (camelCase only).
const consistencies = { any: 0, one: 1, two: 2, three: 3, quorum: 4, all: 5, localQuorum: 6, eachQuorum: 7, serial: 8, localSerial: 9, localOne: 10 };

export default { Client, types: { consistencies } };
