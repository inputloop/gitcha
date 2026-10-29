// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Packs and unpacks Gitcha package tarballs with no outside libraries. A tarball is a tar archive
// (the "ustar" format: 512-byte blocks, each file has a header block and then its data) squeezed with gzip.
// Archives hold regular files only, all under "package/". Unpacking refuses absolute paths, "..",
// symlinks and anything that would land outside the target folder. The CLI uses it for packages,
// and the server also uses unpackFiles for CI artifacts.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const MAX_FILES = 10_000;

// Build one 512-byte tar header for a regular file (mode 644, owner 0). A name longer than 100 bytes is
// split at a "/" into the 155-byte prefix field and the 100-byte name field.
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
  // Two zero blocks mark the end of the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  // A fixed mtime (file time) and sorted entries give reproducible tarballs: the same files give the same bytes.
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

// Read a text field from a header. The text ends at the first zero byte.
function str(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul === -1 ? s.length : nul).toString('utf8');
}

// Clean up a path and return it, or null when it is not safe: absolute, starting with "..",
// holding a zero byte, or starting with a Windows drive letter such as "C:".
export function safeRelative(p) {
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (!norm || norm.startsWith('/') || norm.startsWith('../') || norm === '..' || norm.includes('\0') || /^[a-zA-Z]:/.test(norm)) {
    return null;
  }
  return norm;
}

/**
 * Read a number field from a tar header. It is octal digits (padded with blanks or zero bytes) or
 * GNU base-256 (raw bytes), and never negative. Anything else is an error. An unreadable header must
 * never read as "the archive ends here", because other tar readers would keep going past it.
 */
function numeric(h, start, len, what, { base256 = true } = {}) {
  const f = h.subarray(start, start + len);
  if (f[0] & 0x80) {
    if (!base256 || f[0] !== 0x80) throw new Error(`tar header: ${what} is negative or not a readable number`);
    let v = 0n;
    for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(f[i]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`tar header: ${what} is too large`);
    return Number(v);
  }
  const s = f.toString('latin1').replace(/^ +/, '').replace(/[ \0]+$/, '');
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar header: ${what} is not a number`);
  return parseInt(s, 8);
}

/**
 * Check the header checksum. It is the sum of the header's bytes, with the checksum field counted as blanks.
 * We accept both the unsigned and the signed sum, because some old tar programs summed signed bytes.
 */
function checkChecksum(h) {
  const want = numeric(h, 148, 8, 'checksum', { base256: false });
  let unsigned = 0, signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 32 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (want !== unsigned && want !== signed) throw new Error('tar header: checksum does not match');
}

/**
 * Read pax records. Pax is a tar add-on that stores extra fields as "<len> <key>=<value>\n" lines.
 * A record whose length does not add up is an error.
 */
function paxRecords(data) {
  const out = new Map();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const lenText = sp === -1 ? '' : data.subarray(i, sp).toString('latin1');
    const len = /^[1-9]\d{0,8}$/.test(lenText) ? Number(lenText) : 0;
    if (!len || i + len > data.length || data[i + len - 1] !== 0x0a) throw new Error('tar header: malformed pax record');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq < 1) throw new Error('tar header: malformed pax record');
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/** Names that a package may not carry. A nested .git folder can run commands for whoever runs git inside it. */
export const PACKAGE_FORBIDDEN = ['.git', 'node_modules'];

/**
 * Unpack a gzipped tarball into `[{ path, data }]` in memory.
 * By default every entry must sit under package/ (Gitcha's own format). With { root: '' } any safe
 * relative path is accepted, as ordinary tar writes it (./ prefixes, GNU long names, pax headers).
 * CI artifacts use that mode.
 * `maxBytes` caps what the archive may expand to (the gunzip output, which holds every header, file and
 * padding byte). This stops a "zip bomb" (a tiny file that expands to a huge one).
 * `strict` (for packages) also refuses names that differ only in upper or lower case, and the names in
 * PACKAGE_FORBIDDEN.
 * Anything this reader cannot read exactly is an error. That way, what it accepts is what GNU tar and
 * other readers see too.
 */
export function unpackFiles(tgz, { maxBytes = 200 * 1024 * 1024, root = 'package/', strict = false } = {}) {
  let tar;
  try {
    tar = zlib.gunzipSync(tgz, { maxOutputLength: maxBytes });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`tarball expands to more than ${maxBytes} bytes`);
    throw err;
  }
  const files = [];
  const seen = new Set();
  let off = 0;
  let headers = 0;
  let pending = null; // a GNU long name or pax path, for the entry that follows
  while (off < tar.length) {
    if (off + BLOCK > tar.length) throw new Error('tar header: archive ends inside a header');
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      // End of archive: nothing but zeros may follow, or another reader might read on.
      if (tar.subarray(off).some((b) => b !== 0)) throw new Error('tar header: data after the end-of-archive marker');
      break;
    }
    if (++headers > MAX_FILES * 2) throw new Error('too many entries in tarball');
    checkChecksum(h);
    const name = str(h, 0, 100);
    const type = String.fromCharCode(h[156] || 48);
    const size = numeric(h, 124, 12, 'size');
    off += BLOCK;
    if (size > tar.length - off) throw new Error('tar header: entry is longer than the archive');
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    // Type "L" (GNU long name) and "x" (pax) headers give the real name of the next entry.
    if (type === 'L' || type === 'x') {
      if (pending !== null) throw new Error('tar header: two long names for one entry');
      if (type === 'L') pending = data.toString('utf8').replace(/\0+$/, '');
      else {
        const rec = paxRecords(data);
        // GNU tar lets these change the next header. This reader does not, so it refuses them.
        if (rec.has('size') || rec.has('linkpath')) throw new Error('unsupported pax record (size or linkpath)');
        pending = rec.get('path') ?? null;
      }
      continue;
    }
    // Type "g" is a global pax header. It may not set a path, size or link.
    if (type === 'g') {
      const rec = paxRecords(data);
      if (rec.has('path') || rec.has('size') || rec.has('linkpath')) throw new Error('unsupported global pax record');
      continue;
    }
    const posix = h.toString('latin1', 257, 263) === 'ustar\0'; // GNU format reuses the prefix bytes for other fields
    const prefix = posix ? str(h, 345, 155) : '';
    let full = pending ?? (prefix ? `${prefix}/${name}` : name);
    pending = null;
    // Only regular files ("0" or a zero byte) and folders ("5") are allowed. Links could point outside the target.
    if (type !== '0' && type !== '\0' && type !== '5') {
      throw new Error(`unsupported tar entry type "${type}" for ${full} (links are not allowed)`);
    }
    if (root) {
      if (!full.startsWith(root)) throw new Error(`unexpected entry outside ${root}: ${full}`);
      full = full.slice(root.length);
    } else {
      full = full.replace(/^(\.\/)+/, '');
    }
    if (type === '5') {
      // GNU tar skips no data after a folder entry. So a size here would hide entries from this reader.
      if (size) throw new Error(`directory entry with data: ${full}`);
      if (full && full !== '.' && !safeRelative(full)) throw new Error(`unsafe path in tarball: ${full}`);
      continue;
    }
    // Other readers treat a name ending in "/" as a folder, whatever its type says.
    // A name must already be in its plain form, because other readers handle "a//b", "a/./b", "a/../b"
    // and backslashes differently.
    const rel = full.endsWith('/') || full.includes('\\') ? null : safeRelative(full);
    if (!rel || rel === '.' || rel !== full) throw new Error(`unsafe path in tarball: ${full}`);
    const segments = rel.split('/').map((s) => s.toLowerCase());
    if (strict && segments.some((s) => PACKAGE_FORBIDDEN.includes(s))) throw new Error(`${rel}: ${PACKAGE_FORBIDDEN.join(' and ')} are never part of a package`);
    const key = strict ? rel.toLowerCase() : rel;
    if (seen.has(key)) throw new Error(`duplicate entry in tarball: ${rel}`);
    seen.add(key);
    files.push({ path: rel, data: Buffer.from(data) });
    if (files.length > MAX_FILES) throw new Error('too many files in tarball');
  }
  if (pending !== null) throw new Error('tar header: a long name with no entry after it');
  // A file cannot also be a folder (a/b next to a). It would not extract, and other readers disagree on the order.
  for (const key of seen) {
    for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) {
      if (seen.has(key.slice(0, i))) throw new Error(`entry ${key.slice(0, i)} is both a file and a directory`);
    }
  }
  return files;
}

/** Write unpacked files inside `dest`. It refuses any path that would land outside it. */
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
