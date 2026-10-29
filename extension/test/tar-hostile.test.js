// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Hostile tarballs against the shared reader (PKG-F1, F3, F4, F5, F7, F14). Each runs in a child process
// with a timeout: a reader that loops fails the test instead of freezing the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { END, base, entry, header, gz } from './tarbuild.js';
import { packFiles, unpackFiles } from '../lib/tar.js';

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-unpack.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-hostile-'));
let n = 0;

function probe(tgz, options) {
  const file = path.join(dir, `t${++n}.tgz`);
  fs.writeFileSync(file, tgz);
  const r = spawnSync(process.execPath, [PROBE, file, ...(options ? [JSON.stringify(options)] : [])], { timeout: 8000, encoding: 'utf8' });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, error: 'TIMEOUT: the reader never finished' };
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const refused = (tgz, pattern, options) => {
  const r = probe(tgz, options);
  assert.equal(r.ok, false, `accepted: ${JSON.stringify(r.files)}`);
  assert.match(r.error, pattern);
};

test('PKG-F1: a negative size on a directory entry is an error, not an endless loop', () => {
  refused(gz(base(), header('package/d/', { type: '5', sizeRaw: '-0000001000\0' }), END), /size is not a number/);
});

test('PKG-F3: a size field that does not parse is an error, so nothing after it can hide', () => {
  const symlinkAfter = entry('package/ln', '', { type: '2' });
  refused(gz(base(), header('package/junk', { sizeRaw: 'zzzzzzzzzzz\0' }), symlinkAfter, END), /size is not a number/);
  refused(gz(base(), header('package/g', { sizeRaw: '12345678901\0' }), Buffer.alloc(512), END), /size is not a number/);
  refused(gz(base(), header('package/big', { sizeRaw: '77777777777\0' }), Buffer.alloc(512), END), /longer than the archive/);
  refused(gz(base(), header('package/neg', { sizeRaw: '\xff'.repeat(12) }), END), /size is negative/);
  refused(gz(base(), header('package/blank', { sizeRaw: ' '.repeat(11) + '\0' }), END), /size is not a number/);
});

test('PKG-F3: a base-256 size is read the way GNU tar reads it, so the entry after it is seen', () => {
  const b256 = header('package/b256', { sizeRaw: `\x80${'\0'.repeat(10)}\x05` });
  const r = probe(gz(base(), b256, Buffer.concat([Buffer.from('hello'), Buffer.alloc(507)]), entry('package/after.txt', 'AFTER'), END));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.files.map((f) => f[0]).sort(), ['README.md', 'after.txt', 'b256', 'gitcha.json']);
});

test('PKG-F3: the header checksum is verified', () => {
  refused(gz(entry('package/gitcha.json', '{}', { checksum: false }), END), /checksum/);
  const good = Buffer.from(entry('package/ok.txt', 'x'));
  good[0] ^= 1; // flip a name byte after the checksum was written
  refused(gz(base(), good, END), /checksum/);
});

test('PKG-F3: an entry longer than the archive, and a header cut short, are errors', () => {
  refused(gz(base(), header('package/trunc.txt', { size: 4096 }), Buffer.from('only ten b')), /longer than the archive/);
  refused(gz(base(), Buffer.alloc(100, 1)), /inside a header/);
});

test('PKG-F3: a directory entry may not carry data (GNU tar would read it as the next header)', () => {
  refused(gz(base(), header('package/hide/', { type: '5', size: 1024 }), entry('package/ln', '', { type: '2' }), END), /directory entry with data/);
});

test('PKG-F3: nothing but zeros may follow the end-of-archive marker; padding to a blocking factor is fine', () => {
  refused(gz(base(), END, entry('package/late', 'x'), END), /after the end-of-archive/);
  const r = probe(gz(base(), Buffer.alloc(9216)));
  assert.equal(r.ok, true, r.error);
});

test('PKG-F3: pax size and linkpath, and a global pax path, would change what GNU tar reads, so they are refused', () => {
  const pax = (key, value, type = 'x') => {
    let body = ` ${key}=${value}\n`;
    let len = body.length;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    return entry('PaxHeader/x', `${len}${body}`, { type });
  };
  refused(gz(base(), pax('size', '0'), entry('package/big', 'hello'), END), /unsupported pax/);
  refused(gz(base(), pax('linkpath', '/etc/passwd'), entry('package/x', 'x'), END), /unsupported pax/);
  refused(gz(base(), pax('path', 'package/all', 'g'), END), /unsupported global pax/);
  const ok = probe(gz(base(), pax('path', `package/${'p'.repeat(120)}`), entry('package/short', 'x'), END));
  assert.equal(ok.ok, true, ok.error);
  assert.ok(ok.files.some((f) => f[0] === 'p'.repeat(120)));
});

test('PKG-F3: the ustar prefix is only read under the POSIX magic; a GNU-format header keeps its bytes for other fields', () => {
  refused(gz(base(), entry('x', 'x', { prefix: 'package', magic: 'ustar ', version: ' \0' }), END), /outside package\//);
  const posix = probe(gz(base(), entry('x', 'x', { prefix: 'package' }), END));
  assert.equal(posix.ok, true, posix.error);
  assert.ok(posix.files.some((f) => f[0] === 'x'));
});

test('PKG-F4: two entries with one name are refused (the registry read the first, an installer wrote the last)', () => {
  refused(gz(base(), entry('package/gitcha.json', '{"name":"second","version":"9.9.9"}'), END), /duplicate entry/);
  refused(gz(base(), entry('package/Readme.txt', 'one'), entry('package/README.TXT', 'two'), END), /duplicate entry/, { strict: true });
  refused(gz(base(), entry('package/a', 'one'), entry('package/a/b', 'two'), END), /both a file and a directory/);
});

test('PKG-F5: entries named "." or "package/" or ending in a slash are refused, whatever their type says', () => {
  refused(gz(base(), entry('package/.', ''), END), /unsafe path/);
  refused(gz(base(), entry('package/', ''), END), /unsafe path/);
  refused(gz(base(), entry('package/dir/', '', { type: '\0' }), END), /unsafe path/);
  const dirs = probe(gz(header('package/', { type: '5' }), base(), header('package/src/', { type: '5' }), entry('package/src/i.js', 'x'), END));
  assert.equal(dirs.ok, true, 'real directory entries from ordinary tar are fine');
});

test('PKG-F7: a package may not carry .git or node_modules', () => {
  refused(gz(base(), entry('package/.git/config', '[core]\n\tfsmonitor = x\n'), END), /never part of a package/, { strict: true });
  refused(gz(base(), entry('package/sub/node_modules/x.js', ''), END), /never part of a package/, { strict: true });
  refused(gz(base(), entry('package/.GIT/config', ''), END), /never part of a package/, { strict: true });
  assert.equal(probe(gz(base(), entry('package/.git/config', ''), END)).ok, true, 'the default reader (CI artifacts, sites) does not impose the package rule');
});

test('PKG-F14: the expanded size is capped at maxBytes (the gunzip output holds every header, file and padding byte)', () => {
  const bomb = zlib.gzipSync(Buffer.concat([base(), entry('package/zeros', Buffer.alloc(8 * 1024 * 1024)), END]), { level: 9 });
  assert.ok(bomb.length < 20_000, `the bomb is small on the wire (${bomb.length} bytes)`);
  refused(bomb, /expands to more than 1048576 bytes/, { maxBytes: 1024 * 1024 });
  assert.equal(probe(bomb, { maxBytes: 16 * 1024 * 1024 }).ok, true);
});

test('what the packer writes still reads back, and a real directory tree round-trips', () => {
  const files = [{ path: 'gitcha.json', data: '{}' }, { path: 'src/a.js', data: 'export {}' }, { path: 'src/b/c.js', data: '1' }];
  const r = probe(packFiles(files), { strict: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.files.map((f) => f[0]).sort(), ['gitcha.json', 'src/a.js', 'src/b/c.js']);
});
