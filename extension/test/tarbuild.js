// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Test helper: hand-made tar bytes, so tests can plant headers the packer would never write.
import zlib from 'node:zlib';

export const END = Buffer.alloc(1024);

export function header(name, { size = 0, sizeRaw, type = '0', prefix = '', magic = 'ustar\0', version = '00', checksum = true, mode = '0000644\0' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (sizeRaw) Buffer.from(sizeRaw, 'latin1').copy(h, 124);
  else h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(magic, 257, 6, 'latin1');
  h.write(version, 263, 2, 'latin1');
  h.write(prefix, 345, 155);
  if (checksum) {
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  }
  return h;
}

export const pad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

export function entry(name, data = '', opts = {}) {
  const body = Buffer.from(data);
  return Buffer.concat([header(name, { size: body.length, ...opts }), pad(body)]);
}

/** The two files every package needs. */
export const base = (name = 'plant') => Buffer.concat([
  entry('package/gitcha.json', JSON.stringify({ name, version: '1.0.0', description: 'planted', license: 'MIT' })),
  entry('package/README.md', `# ${name}\n`),
]);

export const gz = (...parts) => zlib.gzipSync(Buffer.concat(parts));
