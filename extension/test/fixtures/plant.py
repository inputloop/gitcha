# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# A second tar writer, in another language, for the differential test (test/tar-differential.test.js).
# Usage: python3 -I plant.py OUTDIR
# It writes hand-made hostile archives (raw bytes, no tarfile module) that the JavaScript reader must
# either refuse or read exactly as GNU tar does. Derived from the W2 review planter (2026-10-28).
import gzip, json, os, sys

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

def hdr(name, size=0, typeflag=b'0', linkname=b'', mode=b'0000644\0', prefix=b'', size_raw=None,
        magic=b'ustar\0', ver=b'00', checksum=True, mtime=0):
    if isinstance(name, str): name = name.encode()
    if isinstance(prefix, str): prefix = prefix.encode()
    if isinstance(linkname, str): linkname = linkname.encode()
    h = bytearray(512)
    h[0:len(name)] = name[:100]
    h[100:108] = mode
    h[108:116] = b'0000000\0'
    h[116:124] = b'0000000\0'
    h[124:136] = size_raw if size_raw is not None else (b'%011o\0' % size)
    h[136:148] = b'%011o\0' % mtime
    h[148:156] = b'        '
    h[156:157] = typeflag
    h[157:157 + len(linkname)] = linkname[:100]
    h[257:263] = magic
    h[263:265] = ver
    h[345:345 + len(prefix)] = prefix[:155]
    if checksum:
        h[148:156] = b'%06o\0 ' % sum(h)
    return bytes(h)

def pad(b):
    return b + b'\0' * ((512 - len(b) % 512) % 512)

def entry(name, data=b'', **kw):
    if isinstance(data, str): data = data.encode()
    return hdr(name, len(data), **kw) + pad(data)

def pax(key, value):
    body = ' %s=%s\n' % (key, value)
    n = len(body)
    while len(str(n)) + len(body) != n: n = len(str(n)) + len(body)
    return ('%d%s' % (n, body)).encode()

END = b'\0' * 1024
VICTIM = '/nonexistent/victim'

def manifest(name='plant', version='1.0.0', **extra):
    d = {'name': name, 'version': version, 'description': 'planted', 'license': 'MIT'}
    d.update(extra)
    return json.dumps(d)

def good(name='plant', version='1.0.0', **extra):
    return entry('package/gitcha.json', manifest(name, version, **extra)) + entry('package/README.md', '# %s\n' % name)

def write(fname, raw):
    with open(os.path.join(OUT, fname), 'wb') as f:
        f.write(gzip.compress(raw, 9, mtime=0))

# links and paths
write('t01-symlink.tgz', good('t01') + entry('package/link', b'', typeflag=b'2', linkname='/etc/passwd') + END)
write('t02-hardlink.tgz', good('t02') + entry('package/hl', b'', typeflag=b'1', linkname='package/gitcha.json') + END)
write('t03a-absolute-name.tgz', good('t03a') + entry('/etc/evil', b'x') + END)
write('t04a-dotdot-leading.tgz', good('t04a') + entry('package/../evil', b'x') + END)
write('t04b-dotdot-deep.tgz', good('t04b') + entry('package/a/../../evil', b'x') + END)
write('t04d-prefix-dotdot.tgz', good('t04d') + entry('x', b'x', prefix='package/..') + END)
write('t04e-backslash-dotdot.tgz', good('t04e') + entry('package/..\\evil', b'x') + END)
# GNU long name and pax
write('t05-gnu-longlink.tgz', good('t05') + entry('././@LongLink', b'package/../../../../tmp/evil\0', typeflag=b'L', magic=b'ustar ', ver=b' \0') + entry('package/short', b'x') + END)
write('t05b-gnu-longlink-ok.tgz', good('t05b') + entry('././@LongLink', ('package/' + 'd' * 120 + '/file.txt').encode() + b'\0', typeflag=b'L', magic=b'ustar ', ver=b' \0') + entry('package/short', b'x') + END)
write('t06a-pax-path-bad-record.tgz', good('t06a') + entry('PaxHeader/x', b'27 path=../../../tmp/evil\n\0'[:27], typeflag=b'x') + entry('package/short', b'x') + END)
write('t06b-pax-global-comment.tgz', good('t06b') + entry('pax_global_header', pax('comment', 'hello'), typeflag=b'g') + END)
write('t06c-pax-path-ok.tgz', good('t06c') + entry('PaxHeader/x', pax('path', 'package/long/' + 'p' * 30), typeflag=b'x') + entry('package/short', b'x') + END)
write('t06d-pax-size-override.tgz', good('t06d') + entry('PaxHeader/x', pax('size', '0'), typeflag=b'x') + entry('package/big', b'hello') + entry('package/after', b'x') + END)
write('t06e-pax-global-path.tgz', good('t06e') + entry('pax_global_header', pax('path', 'package/everything'), typeflag=b'g') + END)
# name, prefix and size fields
write('t07a-name100-prefix.tgz', good('t07a') + entry('n' * 100, b'x', prefix='package/dir') + END)
write('t07b-prefix-only-package.tgz', good('t07b') + entry('../../x', b'x', prefix='package') + END)
write('t07c-gnu-magic-prefix-bytes.tgz', good('t07c') + entry('x', b'x', prefix='package', magic=b'ustar ', ver=b' \0') + END)
write('t08-base256-size.tgz', good('t08') + hdr('package/b256', size_raw=b'\x80\0\0\0\0\0\0\0\0\0\0\x05') + pad(b'hello') + entry('package/after.txt', b'AFTER') + END)
write('t08b-base256-negative.tgz', good('t08b') + hdr('package/neg', size_raw=b'\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff') + END)
write('t09a-octal-overflow.tgz', good('t09a') + hdr('package/big', size_raw=b'77777777777\0') + pad(b'short') + END)
write('t09b-size-garbage.tgz', good('t09b') + hdr('package/g', size_raw=b'12345678901\0') + pad(b'short') + END)
write('t09c-size-blank.tgz', good('t09c') + hdr('package/blank', size_raw=b'           \0') + END)
write('t10-size-exceeds-body.tgz', good('t10') + hdr('package/trunc.txt', size=4096) + b'only ten b')
# duplicates and odd names
write('t11-duplicate-manifest.tgz', entry('package/gitcha.json', manifest('t11', '1.0.0')) + entry('package/README.md', '# real\n') + entry('package/gitcha.json', manifest('t11-second', '9.9.9')) + END)
write('t11b-case-twins.tgz', good('t11b') + entry('package/Readme.txt', 'one') + entry('package/README.TXT', 'two') + END)
write('t12-nul-in-name.tgz', good('t12') + entry(b'package/ok\0/../../../evil', b'x') + END)
write('t13-dot-name.tgz', good('t13') + entry('package/.', b'', typeflag=b'0') + END)
write('t13b-empty-after-package.tgz', good('t13b') + entry('package/', b'', typeflag=b'0') + END)
write('t14a-drive-backslash.tgz', good('t14a') + entry('package/C:\\x', b'x') + END)
write('t15-dotgit.tgz', good('t15') + entry('package/.git/config', '[core]\n\tfsmonitor = touch /nonexistent/ran\n') + entry('package/.git/HEAD', 'ref: refs/heads/main\n') + END)
write('t15c-node-modules.tgz', good('t15c') + entry('package/node_modules/.bin/x', '#!/bin/sh\n') + END)
write('t16-modes.tgz', good('t16') + entry('package/suid.sh', '#!/bin/sh\n', mode=b'0004755\0') + END)
# differentials with GNU tar
write('t17-lone-zero-block.tgz', good('t17') + (b'\0' * 512) + entry('package/ln', b'', typeflag=b'2', linkname=VICTIM) + END)
write('t17b-bad-size-then-symlink.tgz', good('t17b') + hdr('package/junk', size_raw=b'zzzzzzzzzzz\0') + entry('package/ln', b'', typeflag=b'2', linkname=VICTIM) + entry('package/ln/pwn.txt', b'x') + END)
write('t18a-negative-size-dir-loop.tgz', good('t18a') + hdr('package/d/', typeflag=b'5', size_raw=b'-0000001000\0') + END)
write('t18b-negative-size-file.tgz', good('t18b') + hdr('package/f', typeflag=b'0', size_raw=b'-0000000001\0') + entry('package/after', b'x') + END)
write('t18c-negative-size-file-loop.tgz', good('t18c') + hdr('package/f', typeflag=b'0', size_raw=b'-0000001000\0') + END)
write('t19-bad-checksum.tgz', entry('package/gitcha.json', manifest('t19', '1.0.0'), checksum=False) + END)
write('t20-v7-trailing-slash-dir.tgz', good('t20') + entry('package/dir/', b'', typeflag=b'\0') + entry('package/dir/file.txt', b'x') + END)
write('t22-unterminated.tgz', good('t22'))
write('t23-plain-good.tgz', good('t23') + entry('package/src/index.js', 'export default 1\n') + END)
write('t23b-with-directory-entries.tgz', hdr('package/', typeflag=b'5', mode=b'0000755\0') + good('t23b') + hdr('package/src/', typeflag=b'5', mode=b'0000755\0') + entry('package/src/index.js', 'export default 1\n') + END)
write('t26-dir-with-size.tgz', good('t26') + hdr('package/hide/', typeflag=b'5', size=1024) + entry('package/ln', b'', typeflag=b'2', linkname=VICTIM) + END)
write('t27-data-after-end.tgz', good('t27') + END + entry('package/late', b'x') + END)
write('t27b-blocking-factor-zeros.tgz', good('t23') + b'\0' * 9216)
print('planted', len(os.listdir(OUT)), 'archives in', OUT)
