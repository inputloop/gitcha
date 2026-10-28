import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { packFiles, unpackFiles, extractTo } from '../lib/tar.js';
import { collectFiles } from '../lib/pack.js';
import { parseSpec } from '../lib/installer.js';
import { compareVersions, latestVersion, validateManifest } from '../lib/manifest.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-ext-'));

test('pack/unpack round-trips, including long paths, and is reproducible', () => {
  const long = `${'deep/'.repeat(25)}file.txt`;
  const files = [{ path: 'gitcha.json', data: '{}' }, { path: long, data: 'x'.repeat(1000) }, { path: 'empty', data: '' }];
  const a = packFiles(files);
  assert.deepEqual(a, packFiles([...files].reverse()), 'deterministic');
  const back = unpackFiles(a);
  assert.deepEqual(back.map((f) => f.path).sort(), files.map((f) => f.path).sort());
  assert.equal(back.find((f) => f.path === long).data.length, 1000);
});

test('unpack refuses path traversal and links', () => {
  const entry = (name, type = '0') => {
    const b = Buffer.alloc(1536);
    b.write(name, 0); b.write('0000644\0', 100); b.write('00000000000\0', 124); b.write(type, 156); b.write('ustar\0', 257);
    return zlib.gzipSync(b);
  };
  assert.throws(() => unpackFiles(entry('package/../../x')), /unsafe path/);
  assert.throws(() => unpackFiles(entry('/etc/passwd')), /outside package/);
  assert.throws(() => unpackFiles(entry('package/link', '2')), /links are not allowed/);
  assert.throws(() => extractTo([{ path: '../escape', data: Buffer.from('') }], tmp()), /refusing/);
});

test('collectFiles honours "files", .gitchaignore and never ships secrets', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gitcha.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'private');
  fs.writeFileSync(path.join(dir, '.gitchaignore'), 'notes.txt\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export {}');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '');
  const { files } = collectFiles(dir);
  assert.deepEqual(files.map((f) => f.path).sort(), ['.gitchaignore', 'README.md', 'gitcha.json', 'src/index.js']);
});

test('manifest helpers', () => {
  assert.deepEqual(validateManifest({ name: 'ok-name', version: '1.2.3' }), []);
  assert.equal(validateManifest({ name: 'Bad Name', version: 'one' }).length, 2);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0-beta', '2.0.0') < 0);
  assert.equal(latestVersion([{ version: '1.0.0' }, { version: '2.0.0-rc.1' }, { version: '1.5.0', yanked: true }]), '1.0.0');
  assert.deepEqual(parseSpec('left-pad@1.0.0'), { name: 'left-pad', version: '1.0.0' });
  assert.deepEqual(parseSpec('left-pad'), { name: 'left-pad', version: 'latest' });
});
