// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// What the store promises about the data directory: one process owns it (STORE-1), a blob is whole or absent
// (STORE-4), a failed write leaves memory as the disk is (STORE-5), and a write reaches the disk before it is
// acknowledged (STORE-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { spawnServer } from './spawn.js';
import { Store } from '../src/store.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const team = (name) => ({ name, owner: 'u1', members: {}, createdAt: 1 });

test('STORE-1: a second server on a live data directory is refused, and a crashed one\'s lock is taken over', async () => {
  const dir = tmpDir();
  const first = await spawnServer({ dataDir: dir });
  try {
    assert.ok(first.started, first.err());
    const second = await spawnServer({ dataDir: dir });
    try {
      assert.equal(second.started, false, 'the second server must not start');
      assert.equal(await second.exited, 1);
      assert.match(second.err().trim(), new RegExp(`^gitcha: cannot start: another process \\(pid ${first.child.pid}\\) is already using`));
      assert.equal(second.err().trim().split('\n').length, 1);
    } finally { await second.stop(); }
    assert.ok(first.alive(), 'the first server is untouched');
    // SIGKILL leaves the lock behind; the next start sees that its owner is gone and takes over.
    await first.stop();
    assert.ok(fs.existsSync(path.join(dir, 'db.lock')), 'a killed server leaves its lock');
    const third = await spawnServer({ dataDir: dir });
    try {
      assert.ok(third.started, third.err());
    } finally { await third.stop(); }
  } finally { await first.stop(); }
});

test('STORE-1: a clean stop releases the lock', async () => {
  const dir = tmpDir();
  const srv = await spawnServer({ dataDir: dir });
  try {
    assert.ok(srv.started, srv.err());
    assert.ok(fs.existsSync(path.join(dir, 'db.lock')));
    srv.child.kill('SIGTERM');
    await srv.exited;
    assert.equal(fs.existsSync(path.join(dir, 'db.lock')), false);
  } finally { await srv.stop(); }
});

test('STORE-4: a blob is whole or absent; a damaged one is not served and is replaced by the next write', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  try {
    const good = crypto.randomBytes(5000);
    const id = sha(good);
    store.writeBlob(id, good);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), [id], 'no temporary file is left behind');
    assert.deepEqual(store.readBlob(id), good);
    // A write cut short by SIGKILL used to leave this under the real name; the retried publish was told it existed.
    fs.writeFileSync(path.join(dir, 'blobs', id), good.subarray(0, 2000));
  } finally { store.close?.(); }
  const again = new Store(dir); // a restart: nothing is trusted until it has been hashed
  try {
    const id = fs.readdirSync(path.join(dir, 'blobs'))[0];
    assert.throws(() => again.readBlob(id), (e) => e.status === 500 && e.code === 'blob_damaged', 'a truncated blob is refused, not served with the full digest in the header');
  } finally { again.close?.(); }
});

test('STORE-4: writing the same bytes again repairs a damaged blob', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  try {
    const good = crypto.randomBytes(3000);
    const id = sha(good);
    fs.writeFileSync(path.join(dir, 'blobs', id), good.subarray(0, 100)); // damaged before anything has vouched for it
    store.writeBlob(id, good);
    assert.deepEqual(store.readBlob(id), good);
  } finally { store.close?.(); }
});

test('STORE-5: a failed write puts memory back as the disk is, in place, and nothing ghostly is persisted later', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  try {
    store.tx((d) => { d.teams.real = team('real'); });
    const alias = store.data; // services keep this reference (compute/jobs.js does)
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    try {
      assert.throws(() => store.tx((d) => { d.teams.ghost = team('ghost'); }), /ENOSPC/);
    } finally { fs.renameSync = rename; }
    assert.equal(store.team('ghost'), null, 'the team that was never saved is not served');
    assert.ok(store.team('real'));
    assert.equal(store.data, alias, 'the same top-level object, refilled');
    assert.equal(alias.teams.ghost, undefined);
    store.tx((d) => { d.teams.later = team('later'); }); // the next write must not carry the ghost to disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk.teams).sort(), ['later', 'real']);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'the failed write left no temporary file');
  } finally { store.close?.(); }
});

test('STORE-6: a write is synced to disk (file and directory) before the call returns', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const synced = [];
  const real = fs.fsyncSync;
  fs.fsyncSync = (fd) => { synced.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file'); return real(fd); };
  try {
    store.tx((d) => { d.teams.a = team('a'); });
  } finally { fs.fsyncSync = real; store.close?.(); }
  assert.deepEqual(synced, ['file', 'dir']);
});

test('STORE-6: temporary files left by a crash are swept at start; a corrupt db.json is named and left alone', () => {
  const dir = tmpDir();
  const first = new Store(dir);
  first.tx((d) => { d.teams.a = team('a'); });
  first.close?.();
  fs.writeFileSync(path.join(dir, 'db.json.4242.tmp'), '{"half');
  fs.writeFileSync(path.join(dir, 'blobs', `${'a'.repeat(64)}.1.tmp`), 'part');
  const second = new Store(dir);
  second.close?.();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), []);
  // Now a damaged database.
  const bad = '{"users": {"u1": {"id"';
  fs.writeFileSync(path.join(dir, 'db.json'), bad);
  assert.throws(() => new Store(dir), (e) => e.name === 'StartupError' && e.message.includes(path.join(dir, 'db.json')) && /not valid JSON/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), bad, 'the file is not overwritten');
  assert.equal(fs.existsSync(path.join(dir, 'db.lock')), false, 'a start that fails lets go of the lock');
});

test('STORE-6: the real entry point names a corrupt db.json in one line', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'db.json'), '{"users": {');
  fs.writeFileSync(path.join(dir, 'secret.key'), crypto.randomBytes(32).toString('base64') + '\n');
  const srv = await spawnServer({ dataDir: dir });
  try {
    assert.equal(srv.started, false);
    assert.equal(await srv.exited, 1);
    const lines = srv.err().trim().split('\n');
    assert.equal(lines.length, 1, srv.err());
    assert.match(lines[0], /^gitcha: cannot start: .*db\.json is not valid JSON/);
  } finally { await srv.stop(); }
});
