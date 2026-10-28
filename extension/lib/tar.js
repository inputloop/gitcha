// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Minimal, dependency-free ustar + gzip packer/unpacker for Gitcha packages.
// Archives contain regular files only, rooted at "package/". Extraction refuses
// absolute paths, "..", symlinks and anything outside the target directory.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const MAX_FILES = 10_000;

function header(name, size, mtime) {
  const h = Buffer.alloc(BLOCK);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** Pack `[{ path, data }]` into a gzipped tarball. */
export function packFiles(files, { mtime = 0 } = {}) {
  const parts = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    parts.push(header(`package/${f.path}`, data.length, mtime), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  // Fixed mtime + sorted entries => reproducible tarballs.
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function str(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul === -1 ? s.length : nul).toString('utf8');
}

export function safeRelative(p) {
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (!norm || norm.startsWith('/') || norm.startsWith('../') || norm === '..' || norm.includes('\0') || /^[a-zA-Z]:/.test(norm)) {
    return null;
  }
  return norm;
}

/**
 * Unpack a gzipped tarball into `[{ path, data }]`.
 * By default entries must sit under package/ (Gitcha's own format). With
 * { root: '' } any safe relative path is accepted, as written by ordinary tar
 * (./ prefixes, GNU long names, pax headers); used for CI artifacts.
 */
export function unpackFiles(tgz, { maxBytes = 200 * 1024 * 1024, root = 'package/' } = {}) {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: maxBytes });
  const files = [];
  let off = 0;
  let longName = null;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = str(h, 0, 100);
    const prefix = str(h, 345, 155);
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += BLOCK;
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g') continue;
    let full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === '0' || type === '\0') {
      if (root) {
        if (!full.startsWith(root)) throw new Error(`unexpected entry outside ${root}: ${full}`);
        full = full.slice(root.length);
      } else {
        full = full.replace(/^(\.\/)+/, '');
      }
      const rel = safeRelative(full);
      if (!rel) throw new Error(`unsafe path in tarball: ${full}`);
      files.push({ path: rel, data: Buffer.from(data) });
      if (files.length > MAX_FILES) throw new Error('too many files in tarball');
    } else if (type !== '5') {
      throw new Error(`unsupported tar entry type "${type}" for ${full} (links are not allowed)`);
    }
  }
  return files;
}

/** Write unpacked files beneath `dest`, refusing anything that escapes it. */
export function extractTo(files, dest) {
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  for (const f of files) {
    const target = path.resolve(root, f.path);
    if (!target.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}: ${f.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
}
