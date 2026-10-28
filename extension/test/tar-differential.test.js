// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Differential test against GNU tar (PKG-F3). Rule: whatever the Gitcha reader accepts, GNU tar must list the
// same regular files, no links or devices, and no complaint. The second writer is fixtures/plant.py (Python,
// raw bytes); a mutation run flips header bytes of a good archive and applies the same rule. Skipped where
// GNU tar or python3 is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packFiles } from '../lib/tar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'probe-unpack.mjs');
const hasGnuTar = /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = !hasGnuTar ? 'GNU tar is not installed' : !hasPython ? 'python3 is not installed' : false;

function gnuList(file) {
  const r = spawnSync('tar', ['-tzvf', file], { encoding: 'utf8' });
  const entries = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const m = /^(.)\S+ \S+\s+\d+ \S+ \S+ (.*)$/.exec(line);
    entries.push({ type: m?.[1] ?? '?', name: m?.[2] ?? line });
  }
  return { status: r.status, stderr: r.stderr.trim(), entries };
}

/** The rule. `ours` is the probe's answer for the file. */
function agrees(name, ours, gnu) {
  if (!ours.ok) return; // refusing is always safe
  const label = `${name}: gitcha accepted it`;
  assert.equal(gnu.status, 0, `${label}, but GNU tar exits ${gnu.status}: ${gnu.stderr}`);
  assert.equal(gnu.stderr, '', `${label}, but GNU tar complains: ${gnu.stderr}`);
  const odd = gnu.entries.filter((e) => e.type !== '-' && e.type !== 'd');
  assert.deepEqual(odd, [], `${label}, but GNU tar lists links or special files`);
  const theirs = gnu.entries.filter((e) => e.type === '-').map((e) => e.name.replace(/^package\//, '')).sort();
  assert.deepEqual(ours.files.map((f) => f[0]).sort(), theirs, `${label} with another file list than GNU tar`);
}

function probeDir(dir, options) {
  const r = spawnSync(process.execPath, [PROBE, dir, ...(options ? [JSON.stringify(options)] : [])], { timeout: 60_000, encoding: 'utf8' });
  assert.equal(r.error, undefined, 'the reader finished in time');
  return JSON.parse(r.stdout);
}

test('every planted archive: accepted means GNU tar reads the same files', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-plant-'));
  assert.equal(spawnSync('python3', ['-I', path.join(here, 'fixtures', 'plant.py'), dir]).status, 0);
  const ours = probeDir(dir);
  const names = Object.keys(ours);
  assert.ok(names.length >= 40, `planted ${names.length} archives`);
  for (const name of names) agrees(name, ours[name], gnuList(path.join(dir, name)));
  // The ones that must read, so that "refuse everything" cannot pass.
  for (const name of ['t23-plain-good.tgz', 't23b-with-directory-entries.tgz', 't08-base256-size.tgz', 't05b-gnu-longlink-ok.tgz', 't06c-pax-path-ok.tgz', 't06b-pax-global-comment.tgz', 't27b-blocking-factor-zeros.tgz', 't22-unterminated.tgz']) {
    assert.equal(ours[name].ok, true, `${name} should be accepted: ${ours[name].error}`);
  }
  // The ones GNU tar sees something in that this reader must not have missed.
  for (const name of ['t01-symlink.tgz', 't02-hardlink.tgz', 't17b-bad-size-then-symlink.tgz', 't18a-negative-size-dir-loop.tgz', 't26-dir-with-size.tgz', 't06d-pax-size-override.tgz', 't07c-gnu-magic-prefix-bytes.tgz', 't11-duplicate-manifest.tgz']) {
    assert.equal(ours[name].ok, false, `${name} should be refused`);
  }
});

test('what the Gitcha packer writes is plain to GNU tar', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-pack-'));
  const files = [{ path: 'gitcha.json', data: '{}' }, { path: `${'deep/'.repeat(25)}file.txt`, data: 'x'.repeat(1000) }, { path: 'src/a.js', data: '' }];
  fs.writeFileSync(path.join(dir, 'packed.tgz'), packFiles(files));
  const ours = probeDir(dir);
  assert.equal(ours['packed.tgz'].ok, true);
  const gnu = gnuList(path.join(dir, 'packed.tgz'));
  agrees('packed.tgz', ours['packed.tgz'], gnu);
  assert.equal(gnu.entries.length, 3);
});

// A small deterministic generator (mulberry32). Seed 17, 9 header fields x 17 rounds: the house numbers, picked
// for coverage of every field in a header, not derived from anything.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('header mutations: accepted means GNU tar reads the same files', { skip }, () => {
  const rand = rng(17);
  const good = zlib.gunzipSync(packFiles([{ path: 'gitcha.json', data: '{"name":"m","version":"1.0.0"}' }, { path: 'README.md', data: '# m\n' }, { path: 'src/index.js', data: 'export {}\n' }]));
  const fields = [[0, 100], [124, 136], [148, 156], [156, 157], [157, 257], [257, 263], [263, 265], [265, 297], [345, 500]];
  const interesting = [0, 0x20, 0x30, 0x31, 0x32, 0x35, 0x4c, 0x78, 0x67, 0x80, 0xff, 0x2f, 0x2e];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-mut-'));
  let count = 0;
  for (const [from, to] of fields) {
    for (let round = 0; round < 17; round++) {
      const tar = Buffer.from(good);
      const block = Math.floor(rand() * 3) * 1024; // header of entry 0, 1 or 2 (each entry is header + one data block)
      const at = block + from + Math.floor(rand() * (to - from));
      tar[at] = rand() < 0.5 ? interesting[Math.floor(rand() * interesting.length)] : Math.floor(rand() * 256);
      if (round % 2) { // keep the checksum right so the field itself is what gets tested
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tar[block + i];
        tar.write(sum.toString(8).padStart(6, '0') + '\0 ', block + 148, 'latin1');
      }
      fs.writeFileSync(path.join(dir, `m${String(count++).padStart(3, '0')}.tgz`), zlib.gzipSync(tar));
    }
  }
  const ours = probeDir(dir);
  let accepted = 0;
  for (const [name, result] of Object.entries(ours)) {
    if (result.ok) accepted++;
    agrees(name, result, gnuList(path.join(dir, name)));
  }
  assert.equal(Object.keys(ours).length, count);
  assert.ok(accepted > 0 && accepted < count, `some mutants read and some do not (${accepted} of ${count})`);
});
