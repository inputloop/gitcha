// End-to-end: real server, the gitcha CLI and the Claude extension (MCP server)
// as subprocesses, sharing one credentials directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, createUser, tmpDir } from '../../server/test/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'gitcha.js');
const MCP = path.join(here, '..', 'bin', 'gitcha-mcp.js');
const HOUR = 3600_000;

let srv, user, env, project;

function run(args, input = '') {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: project });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(input);
  });
}

function mcp() {
  const p = spawn(process.execPath, [MCP], { env, cwd: project });
  let buf = '';
  const pending = new Map();
  let id = 0;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, isError: Boolean(r.result.isError) };
  };
  return { request, tool, close: () => p.kill() };
}

before(async () => {
  srv = await startServer();
  user = createUser(srv, 'alice', 'correct horse battery');
  env = { ...process.env, GITCHA_CONFIG_DIR: tmpDir(), GITCHA_SERVER: srv.url, NO_COLOR: '1' };
  delete env.NODE_USE_ENV_PROXY;
  project = tmpDir();
});
after(() => srv.close());

test('before first login everything is refused with setup instructions', async () => {
  const r = await run(['search']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not signed in/);
  const m = mcp();
  try {
    const init = await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'gitcha');
    const list = await m.request('tools/list', {});
    assert.ok(list.result.tools.some((t) => t.name === 'gitcha_verify_2fa'));
    const s = await m.tool('gitcha_search');
    assert.equal(s.isError, true);
    assert.match(s.text, /not set up yet/);
    assert.match(s.text, /Do not ask the user for their password/);
  } finally { m.close(); }
});

test('gitcha login: password + authenticator code, token saved with 0600 and no password', async () => {
  const bad = await run(['login'], `alice\ncorrect horse battery\n000000\n`);
  assert.equal(bad.code, 1);
  const r = await run(['login', '--device', 'test laptop'], `alice\ncorrect horse battery\n${user.nextCode()}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Signed in as alice/);
  const file = path.join(env.GITCHA_CONFIG_DIR, 'credentials.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('correct horse battery'), 'password is never written to disk');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('CLI publish and install with integrity + lockfile', async () => {
  const pkg = path.join(project, 'hello');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'gitcha.json'), JSON.stringify({ name: 'hello', version: '1.0.0', description: 'Says hello', license: 'MIT' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export const hello = () => "hi";\n');
  const pub = await run(['publish', 'hello']);
  assert.equal(pub.code, 0, pub.stderr);
  assert.match(pub.stdout, /Published hello@1\.0\.0/);

  const inst = await run(['install', 'hello']);
  assert.equal(inst.code, 0, inst.stderr);
  assert.equal(fs.readFileSync(path.join(project, 'gitcha_modules', 'hello', 'index.js'), 'utf8'), 'export const hello = () => "hi";\n');
  const lock = JSON.parse(fs.readFileSync(path.join(project, 'gitcha-lock.json'), 'utf8'));
  assert.match(lock.packages.hello.integrity, /^sha256-/);
});

test('intermittent check: CLI without a TTY explains how to verify; verify fixes it', async () => {
  srv.clock.advance(13 * HOUR);
  const r = await run(['search']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /gitcha verify/);
  const st = await run(['status']);
  assert.match(st.stdout, /check due/);
  const v = await run(['verify', user.nextCode()]);
  assert.equal(v.code, 0, v.stderr);
  assert.equal((await run(['search', 'hello'])).code, 0);
});

test('Claude extension: search/install, 2FA check via gitcha_verify_2fa, security toggles', async () => {
  const m = mcp();
  try {
    await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const st = await m.tool('gitcha_status');
    assert.match(st.text, /Signed in to .* as alice/);
    const s = await m.tool('gitcha_search', { query: 'hello' });
    assert.match(s.text, /hello@1\.0\.0/);
    const dir = tmpDir();
    const inst = await m.tool('gitcha_install', { name: 'hello', directory: dir });
    assert.match(inst.text, /Integrity verified: sha256-/);
    assert.ok(fs.existsSync(path.join(dir, 'gitcha_modules', 'hello', 'gitcha.json')));

    srv.clock.advance(13 * HOUR);
    const due = await m.tool('gitcha_search');
    assert.equal(due.isError, true);
    assert.match(due.text, /Two-factor check required/);
    assert.match(due.text, /Never guess/);
    const wrong = await m.tool('gitcha_verify_2fa', { code: '000000' });
    assert.equal(wrong.isError, true);
    const ok = await m.tool('gitcha_verify_2fa', { code: user.nextCode() });
    assert.match(ok.text, /Two-factor verified/);
    assert.equal((await m.tool('gitcha_search')).isError, false);

    const off = await m.tool('gitcha_security_settings', { new_network: false });
    assert.match(off.text, /new_network: OFF/);
    const view = await m.tool('gitcha_security_settings');
    assert.match(view.text, /interval .*: ON/);
  } finally { m.close(); }
});

test('CLI security toggles and logout', async () => {
  const sec = await run(['security']);
  assert.match(sec.stdout, /off\s+New network check/);
  const lo = await run(['logout']);
  assert.equal(lo.code, 0);
  assert.equal((await run(['search'])).code, 1);
});
