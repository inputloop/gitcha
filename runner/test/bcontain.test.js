// The bContain backend cannot boot a VM in CI here; these check the parts we
// own: the exact command line, and reading results out of VM console output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, GUEST_HOST } from '../lib/backends/bcontain.js';
import { readOutput, ciScript, parseCgi, q } from '../lib/script.js';

test('the bcontain command matches bContain\'s run interface', () => {
  const argv = command({ image: 'docker.io/library/node:22-alpine', cpus: 2, memoryMb: 1024, port: 41234, token: 'abc' });
  assert.deepEqual(argv.slice(0, 9), ['bcontain', 'run', 'docker.io/library/node:22-alpine', '--cpus', '2', '--memory', '1024M', '--display', 'headless']);
  assert.ok(argv.includes(`GITCHA_UPLOAD=http://${GUEST_HOST}:41234/abc/artifact`));
  assert.equal(argv[argv.indexOf('--') + 1], 'sh');
  assert.match(argv.at(-1), /wget -q -O b\.tgz http:\/\/10\.0\.2\.2:41234\/abc\/bundle\.tgz/);
});

test('results are read from noisy VM console output', () => {
  const resp = Buffer.from(JSON.stringify({ status: 200, body: 'ok' })).toString('base64');
  const console = [
    '[    0.000000] Linux version 6.12.59 (kernel noise)',
    '@@GITCHA-STEP@@ build',
    'compiling...',
    `@@GITCHA-RESPONSE@@ ${resp}\r`,
    '[bcontain] container exited with code 0',
    '[    1.234] reboot: Power down',
  ].join('\n');
  const r = readOutput(console, 1);
  assert.equal(r.exitCode, 0, 'the container\'s code wins over the VM process code');
  assert.deepEqual(r.response, { status: 200, body: 'ok' });
  assert.match(r.log, /== build ==\ncompiling/);
  assert.doesNotMatch(r.log, /GITCHA-RESPONSE/);
});

test('CGI output and shell quoting', () => {
  const r = parseCgi(Buffer.from('Status: 404\r\nContent-Type: text/html\r\n\r\n<b>no</b>'), 0);
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-type'], 'text/html');
  assert.equal(Buffer.from(r.body, 'base64').toString(), '<b>no</b>');
  assert.equal(parseCgi(Buffer.from('plain body'), 2).status, 500);
  assert.equal(q("it's"), `'it'\\''s'`);
  const s = ciScript({ steps: [{ name: "a'b", run: 'echo hi' }], env: { X: "$(rm -rf /)" }, artifacts: 'dist' });
  assert.match(s, /export X='\$\(rm -rf \/\)'/, 'env values are quoted, never evaluated');
  assert.match(s, /tar czf "\$J\/artifact.tgz" -C 'dist' \./);
});
