// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com>
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A package's README links and older versions: relative links open the file in the registry's file view,
// tables and quotes render, every version has its own page, files and download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, createUser, api, deviceLogin } from './helpers.js';
import { packFiles, unpackFiles } from '../../extension/lib/tar.js';
import { markdown, relativeTarget } from '../src/views.js';

let srv, token, cookie;
const README = (v) => `# disconnect ${v}

> Matter is discrete. Correlation carries no signal
> between parts.

## Files

| File | What it is |
|---|---|
| [disconnect-${v}.zip](disconnect-${v}.zip) | Everything below |
| [eclipse/pass.md](eclipse/pass.md) | Eclipse pass |
| [page](disconnected.html) | The hypothesis \\| explained |

See [Files](#files).
`;
const tarball = (v, extra = []) => packFiles([
  { path: 'gitcha.json', data: JSON.stringify({ name: 'disconnect', version: v, description: 'd', license: 'CC-BY-SA-4.0' }) },
  { path: 'README.md', data: README(v) },
  { path: `disconnect-${v}.zip`, data: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]) },
  { path: 'disconnected.html', data: '<script>alert(1)</script>' },
  { path: 'eclipse/pass.md', data: '# Pass\n\nBack to the [README](../README.md).\n' },
  ...extra,
]);
const publish = (tgz) => api(srv.url, 'PUT', '/api/v1/packages', { token, body: { tarball: tgz.toString('base64'), integrity: `sha256-${crypto.createHash('sha256').update(tgz).digest('hex')}` } });
const get = async (p) => {
  const r = await fetch(srv.url + p, { redirect: 'manual', headers: { Cookie: cookie } });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};

before(async () => {
  srv = await startServer();
  const u = createUser(srv, 'alice', 'first long pass!');
  token = await deviceLogin(srv, u);
  cookie = `gitcha_sid=${srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 'b', ip: '127.0.0.1' }).token}`;
  assert.equal((await publish(tarball('1.0.0'))).status, 201);
  assert.equal((await publish(tarball('1.0.1', [{ path: 'only-new.txt', data: 'new\n' }]))).status, 201);
});
after(() => srv.close());

test('PKG-FILES-1: Markdown tables, quotes and relative links; unsafe links are only words', () => {
  const html = markdown(README('1.0.1'), { link: (p) => `/f?path=${encodeURIComponent(p)}` }).__html;
  assert.match(html, /<blockquote><p>Matter is discrete\. Correlation carries no signal\sbetween parts\.<\/p><\/blockquote>/);
  assert.match(html, /<table class="table compact md-table"><thead><tr><th>File<\/th><th>What it is<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><a href="\/f\?path=disconnect-1\.0\.1\.zip">disconnect-1\.0\.1\.zip<\/a><\/td>/);
  assert.match(html, /<a href="\/f\?path=eclipse%2Fpass\.md">/);
  assert.match(html, /The hypothesis \| explained/, 'an escaped pipe stays in its cell');
  assert.match(html, /<h3 id="md-files">Files<\/h3>/);
  assert.match(html, /<a href="#md-files">Files<\/a>/);
  const bad = markdown('[a](javascript:alert(1)) [b](//evil.example/x) [c](/etc/passwd) [d](../../up) [e](data:text/html,x)', { link: () => '/x' }).__html;
  assert.doesNotMatch(bad, /href/, bad);
  assert.doesNotMatch(markdown('[a](docs/x.md)').__html, /href/, 'no link maker: relative links are words');
  assert.equal(relativeTarget('eclipse', '../README.md'), 'README.md');
  assert.equal(relativeTarget('', './a%20b/c.md#part'), 'a b/c.md');
  assert.equal(relativeTarget('', '../x'), null);
});

test('PKG-FILES-2: the package page links the README files into this version, and lists every version with a page and a download', async () => {
  const page = (await get('/packages/disconnect')).body.toString();
  assert.match(page, /href="\/packages\/disconnect\/v\/1\.0\.1\/files\?path=disconnect-1\.0\.1\.zip"/);
  assert.match(page, /href="\/packages\/disconnect\/v\/1\.0\.0"><strong>1\.0\.0<\/strong>/, 'an older version links to its page');
  assert.match(page, /href="\/packages\/disconnect\/v\/1\.0\.0\/download"/);
  assert.match(page, /Browse files/);

  const old = await get('/packages/disconnect/v/1.0.0');
  assert.equal(old.status, 200);
  const oldHtml = old.body.toString();
  assert.match(oldHtml, /You are looking at version 1\.0\.0/);
  assert.match(oldHtml, /gitcha install disconnect@1\.0\.0/);
  assert.match(oldHtml, /<h2 id="md-disconnect-100">disconnect 1\.0\.0<\/h2>/, 'its own README, not the newest');
  assert.match(oldHtml, /v\/1\.0\.0\/files\?path=disconnect-1\.0\.0\.zip/);
  assert.equal((await get('/packages/disconnect/v/9.9.9')).status, 404);
});

test('PKG-FILES-3: a version\'s files: folders, one file shown or downloaded, Markdown rendered, HTML only as text', async () => {
  const root = (await get('/packages/disconnect/v/1.0.0/files')).body.toString();
  assert.ok(root.includes('eclipse/') && root.includes('README.md') && !root.includes('only-new.txt'));
  assert.ok(root.indexOf('eclipse/') < root.indexOf('README.md'), 'folders first');
  const pass = (await get('/packages/disconnect/v/1.0.0/files?path=eclipse/pass.md')).body.toString();
  assert.match(pass, /<h2 id="md-pass">Pass<\/h2>/);
  assert.match(pass, /href="\/packages\/disconnect\/v\/1\.0\.0\/files\?path=README\.md"/, 'a link back up resolves from the file\'s folder');
  const html = (await get('/packages/disconnect/v/1.0.0/files?path=disconnected.html')).body.toString();
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>alert'));
  const zip = (await get('/packages/disconnect/v/1.0.0/files?path=disconnect-1.0.0.zip')).body.toString();
  assert.match(zip, /not text/);
  assert.equal((await get('/packages/disconnect/v/1.0.0/files?path=../x')).status, 400);
  assert.equal((await get('/packages/disconnect/v/1.0.0/files?path=nope')).status, 404);

  const raw = await get('/packages/disconnect/v/1.0.0/raw?path=disconnected.html');
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(raw.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  const z = await get('/packages/disconnect/v/1.0.0/raw?path=disconnect-1.0.0.zip');
  assert.match(z.headers.get('content-disposition'), /^attachment; filename="disconnect-1\.0\.0\.zip"/);

  const before = srv.store.pkg('disconnect').downloads;
  const tgz = await get('/packages/disconnect/v/1.0.0/download');
  assert.equal(tgz.status, 200);
  assert.match(tgz.headers.get('content-disposition'), /filename="disconnect-1\.0\.0\.tgz"/);
  assert.equal(unpackFiles(tgz.body).length, 5);
  assert.equal(srv.store.pkg('disconnect').downloads, before + 1);
});

test('PKG-FILES-4: without public reads, the version pages need a sign-in, like the package page', async () => {
  const r = await fetch(`${srv.url}/packages/disconnect/v/1.0.0/files`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/login/);
  assert.equal((await fetch(`${srv.url}/packages/disconnect/v/1.0.0/download`, { redirect: 'manual' })).status, 303);
});

test('PKG-FILES-5: README HTML: the allowed tags render, everything else is dropped, and tags stay balanced', () => {
  const o = { link: (p) => `/L?p=${encodeURIComponent(p)}`, image: (p) => `/I?p=${encodeURIComponent(p)}`, html: true };
  const md = (t) => markdown(t, o).__html;
  assert.equal(md('<p align="center">\n  <img src="server/public/logo.svg" width="88" alt="Gitcha logo">\n</p>'),
    '<p align="center">\n  <img src="/I?p=server%2Fpublic%2Flogo.svg" alt="Gitcha logo" width="88" loading="lazy">\n</p>');
  assert.match(md('<table><tr>\n<td width="70%"><img src="docs/a.png" alt="A"><br><sub>On a computer</sub></td>\n</tr></table>'),
    /^<table><tr>\n<td width="70%"><img src="\/I\?p=docs%2Fa\.png" alt="A" loading="lazy"><br><sub>On a computer<\/sub><\/td>\n<\/tr><\/table>$/);
  // Images on other sites are never fetched: their alt text stands in.
  assert.match(md('<a href="LICENSE"><img alt="License: GPL" src="https://img.shields.io/badge/x"></a>'), /<a href="\/L\?p=LICENSE"><span class="md-img-alt"[^>]*>License: GPL<\/span><\/a>/);
  assert.match(md('[![CI](https://img.shields.io/x.svg)](https://ci.example)'), /<a href="https:\/\/ci\.example" rel="nofollow noopener"><span class="md-img-alt"[^>]*>CI<\/span><\/a>/);
  for (const evil of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<p onclick="x" style="color:red">t</p>',
    '<svg onload=alert(1)>', '<iframe src="https://evil"></iframe>', '<a href="data:text/html,x">x</a>', '<img src="javascript:alert(1)">', '<form action=/logout><button>x</button></form>']) {
    const out = md(evil);
    assert.doesNotMatch(out, /<script|onerror|onclick|onload|style=|javascript:|<iframe|<svg|data:|<form|<button/i, `${evil} => ${out}`);
  }
  // A README cannot close the page around it: unmatched closing tags are dropped, open ones are closed.
  assert.doesNotMatch(md('</div></article></div>\n\nx'), /<\/div>|<\/article>/);
  assert.equal(md('<div align="center">\n\nnever closed'), '<div align="center"><p>never closed</p></div>');
  assert.equal(md('<details open><summary>More</summary>\n\ninside\n\n</details>'), '<details open><summary>More</summary><p>inside</p></details>');
  assert.match(md('`<b>code</b>`'), /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/, 'code spans stay text');
  assert.equal(markdown('Welcome <b>in</b>!').__html, '<p>Welcome &lt;b&gt;in&lt;/b&gt;!</p>', 'without html: true (posts), every tag is text');
});

test('PKG-FILES-6: a package\'s own pictures are served as pictures for its README', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>';
  assert.equal((await publish(tarball('1.1.0', [{ path: 'logo.svg', data: svg }, { path: 'pic.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]))).status, 201);
  const s = await get('/packages/disconnect/v/1.1.0/raw?path=logo.svg');
  assert.equal(s.headers.get('content-type'), 'image/svg+xml');
  assert.match(s.headers.get('content-disposition'), /^inline/);
  assert.equal(s.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'an SVG opened by itself cannot run its script');
  assert.equal((await get('/packages/disconnect/v/1.1.0/raw?path=pic.png')).headers.get('content-type'), 'image/png');
  assert.match((await get('/packages/disconnect/v/1.1.0/raw?path=pic.png&download=1')).headers.get('content-disposition'), /^attachment/);
});
