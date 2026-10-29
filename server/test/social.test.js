// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Agents, keys, git hosting, Second Reader reviews, budgets, the social feed
// and the GraphQL API, end to end (real git over HTTP, a real GPG key).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { startServer, createUser, deviceLogin } from './helpers.js';
import { parseSshKey } from '../src/social/keys.js';
import { parseByline } from '../src/social/agents.js';

let srv, alice, bob, carol, ta, tb, tc, nexttimeCalls, refuseComplete = false;

async function gql(token, query, variables, headers = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  return { status: res.status, ...body };
}
const ok = (r) => { assert.equal(r.errors, undefined, JSON.stringify(r.errors)); return r.data; };
const code = (r) => r.errors?.[0]?.extensions?.code;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitcha-soc-'));
// Async on purpose: the server runs in this process, so a blocking git would deadlock it.
async function git(cwd, args, env = {}) {
  try {
    return (await run('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })).stdout;
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err.stderr || err.message}`);
  }
}
async function commit(dir, file, message, { name = 'Someone', email = 'someone@example.com', sign, gnupg } = {}) {
  fs.writeFileSync(path.join(dir, file), `${file} ${Date.now()} ${Math.random()}\n`);
  await git(dir, ['add', file]);
  await git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, ...(sign ? ['-c', 'gpg.format=openpgp', '-c', `user.signingkey=${sign}`, 'commit', '-S'] : ['-c', 'commit.gpgsign=false', 'commit']), '-q', '-m', message], gnupg ? { GNUPGHOME: gnupg } : {});
}

before(async () => {
  nexttimeCalls = [];
  const fetchImpl = async (url, init = {}) => {
    nexttimeCalls.push({ url, init });
    if (refuseComplete && url.endsWith('/complete')) return { ok: false, status: 400, json: async () => ({ error: 'Accept at least one volunteer before completing the request' }) };
    return { ok: true, status: 200, json: async () => ({ id: 4242 }) };
  };
  srv = await startServer({
    env: { GITCHA_HOSTING_DOMAINS: 'pages.test' },
    overrides: { nexttime: { url: 'https://cloud.example', user: 'gitcha-bot', appPassword: 'app-pass', categoryId: 7, hoursBudget: 1 } },
    appOpts: { fetchImpl },
  });
  alice = createUser(srv, 'alice', 'first long pass!');
  bob = createUser(srv, 'bob', 'second long pass');
  carol = createUser(srv, 'carol', 'third long pass!');
  [ta, tb, tc] = [await deviceLogin(srv, alice), await deviceLogin(srv, bob), await deviceLogin(srv, carol)];
});
after(() => srv.close());

test('bylines: the house form, read from the last line of a message', () => {
  assert.deepEqual(parseByline('fix: things\n\nMentat (for Corwin, claude-opus-5-5)\n'), { name: 'Mentat', forName: 'Corwin', model: 'claude-opus-5-5' });
  assert.deepEqual(parseByline('x\n\nAlfred (for Bryant)'), { name: 'Alfred', forName: 'Bryant', model: null });
  assert.deepEqual(parseByline('x\nAlfred (for Bryant; claude-opus-5-5)'), { name: 'Alfred', forName: 'Bryant', model: 'claude-opus-5-5' });
  assert.equal(parseByline('Co-Authored-By: someone'), null);
});

test('agents: register, byline, shared namespace, review preferences', async () => {
  ok(await gql(ta, 'mutation { updateProfile(displayName: "Alice") { displayName } }'));
  const r = ok(await gql(ta, 'mutation($h:String!){ registerAgent(handle:$h, name:"Ada", model:"claude-opus-5-5") { handle byline owner } }', { h: 'ada' }));
  assert.equal(r.registerAgent.byline, 'Ada (for Alice, claude-opus-5-5)');
  ok(await gql(tb, 'mutation { registerAgent(handle:"bix", name:"Bix", model:"claude-sonnet-5-5") { handle } }'));
  ok(await gql(tc, 'mutation { registerAgent(handle:"cora", name:"Cora", model:"claude-haiku-5-5") { handle } }'));
  ok(await gql(ta, 'mutation { registerAgent(handle:"ada2", name:"Ada Two", model:"claude-opus-5-5") { handle } }'));
  assert.equal(code(await gql(ta, 'mutation { registerAgent(handle:"bob", name:"X", model:"m") { handle } }')), 'handle_taken');
  assert.equal(code(await gql(ta, 'mutation { registerAgent(handle:"zed", name:"Zed", model:"Not A Model") { handle } }')), 'bad_model');
  const prefs = ok(await gql(tc, 'mutation { setReviewPreferences(agent:"cora", prefs:{anything:true}) { reviewPrefs { enabled anything } } }'));
  assert.deepEqual(prefs.setReviewPreferences.reviewPrefs, { enabled: true, anything: true });
  assert.equal(code(await gql(ta, 'mutation { setReviewPreferences(agent:"cora", prefs:{anything:true}) { handle } }')), 'not_your_agent');
});

test('keys: console keys need a fresh code; SSH keys are parsed; agent keys only for paid sandboxes', async () => {
  srv.clock.advance(11 * 60_000);
  assert.equal(code(await gql(ta, 'mutation { createConsoleKey(name:"laptop") { token } }')), 'mfa_required');
  await fetch(`${srv.url}/api/v1/auth/step-up`, { method: 'POST', headers: { Authorization: `Bearer ${ta}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: alice.nextCode() }) });
  const ck = ok(await gql(ta, 'mutation { createConsoleKey(name:"laptop") { token } }')).createConsoleKey.token;
  assert.equal(ok(await gql(ck, '{ me { username kind } }')).me.username, 'alice');

  // ssh-ed25519: build the OpenSSH line from a fresh Node key pair.
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const str = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const line = `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')} alice@laptop`;
  const k = ok(await gql(ta, 'mutation($k:String!){ addSshKey(key:$k, agent:"ada") { fingerprint holder } }', { k: line })).addSshKey;
  assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(k.holder, 'agent:ada');
  assert.equal(code(await gql(ta, 'mutation($k:String!){ addSshKey(key:$k) { fingerprint } }', { k: line })), 'key_in_use');
  assert.throws(() => parseSshKey('ssh-ed25519 AAAAC3NzaC1yc2EAAAADAQABAAAAgQ'), /does not match|OpenSSH/);
  const authLine = srv.keys.authorizedKeys(k.fingerprint, '/usr/bin/gitcha-git-shell');
  assert.match(authLine, /^command="\/usr\/bin\/gitcha-git-shell SHA256:[^"]+",no-port-forwarding,.*no-pty.* ssh-ed25519 /);

  assert.equal(code(await gql(ta, 'mutation { createAgentKey(agent:"ada", purpose:"commits") { token } }')), 'agent_keys_are_for_sandboxes');
  assert.equal(code(await gql(ta, 'mutation { createAgentKey(agent:"ada", purpose:"sandbox") { token } }')), 'sandbox_not_paid');
});

let gnupg, fpr;
test('git over HTTP: push, agent attribution, verified signatures, Second Reader task, NextTime mirror', async () => {
  ok(await gql(ta, 'mutation { createProject(name:"demo", tags:["parsers"], description:"A demo") { key cloneHttp } }'));
  ok(await gql(ta, 'mutation { setTaskTracking(project:"alice/demo", enabled:true) { taskTracking } }'));
  ok(await gql(ta, 'mutation { addCollaborator(project:"alice/demo", agent:"bix") { collaborators { agents } } }'));

  // A real signing key for Ada.
  gnupg = tmp();
  fs.chmodSync(gnupg, 0o700);
  execFileSync('gpg', ['--homedir', gnupg, '--batch', '--passphrase', '', '--quick-gen-key', 'Ada <ada@agents.example>', 'ed25519', 'sign', 'never'], { stdio: 'ignore' });
  fpr = execFileSync('gpg', ['--homedir', gnupg, '--with-colons', '--list-keys'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('fpr:')).split(':')[9];
  const armored = execFileSync('gpg', ['--homedir', gnupg, '--armor', '--export', fpr], { encoding: 'utf8' });
  const g = ok(await gql(ta, 'mutation($k:String!){ addGpgKey(key:$k, agent:"ada") { fingerprint checked uids } }', { k: armored })).addGpgKey;
  assert.equal(g.fingerprint, fpr);
  assert.deepEqual(g.uids, ['Ada <ada@agents.example>']);

  const port = new URL(srv.url).port;
  const remote = `http://x:${ta}@127.0.0.1:${port}/git/alice/demo.git`;
  const dir = tmp();
  await git(dir, ['init', '-q', '-b', 'main']);
  await commit(dir, 'a.txt', 'feat: parser\n\nAda (for Alice, claude-opus-5-5)', { sign: fpr, gnupg });
  await git(dir, ['push', '-q', remote, 'main']);
  let p = ok(await gql(ta, '{ project(owner:"alice", name:"demo") { pushes } }')).project;
  assert.equal(p.pushes[0].commits[0].agent, 'ada');
  assert.equal(p.pushes[0].commits[0].verified, true, 'signature checked against the registered key');
  assert.equal(p.pushes[0].commits[0].signer, 'agent:ada');

  // A byline naming someone else's agent earns that agent nothing.
  await commit(dir, 'spoof.txt', 'chore: spoof\n\nBix (for bob, claude-sonnet-5-5)');
  await git(dir, ['push', '-q', remote, 'main']);
  p = ok(await gql(ta, '{ project(owner:"alice", name:"demo") { pushes } }')).project;
  assert.equal(p.pushes[0].commits[0].agent, null, 'alice cannot credit bob\'s agent');

  // Without a token: no push.
  await assert.rejects(git(dir, ['push', '-q', `http://127.0.0.1:${port}/git/alice/demo.git`, 'main']), /Authentication failed|401|could not read/);

  // Bix (bob's agent, a collaborator) pushes to the same branch with bob's token: two agents worked together.
  await commit(dir, 'b.txt', 'fix: edge case\n\nBix (for bob, claude-sonnet-5-5)');
  // Bix pushes as itself: its handle as the username, its owner's key as the password.
  await assert.rejects(git(dir, ['push', '-q', `http://x:${tb}@127.0.0.1:${port}/git/alice/demo.git`, 'main']), /403/, 'bob himself may not push');
  await git(dir, ['push', '-q', `http://bix:${tb}@127.0.0.1:${port}/git/alice/demo.git`, 'main']);
  const tasks = ok(await gql(ta, '{ project(owner:"alice", name:"demo") { tasks { id kind title agents { handle owner byline } status } } }')).project.tasks;
  const sr = tasks.find((t) => t.kind === 'second_reader');
  assert.ok(sr, 'a Second Reader task was opened');
  assert.deepEqual(sr.agents.map((a) => a.byline), ['Ada (for Alice, claude-opus-5-5)', 'Bix (for bob, claude-sonnet-5-5)']);
  assert.match(sr.title, /^Second Reader: Ada \(for Alice, claude-opus-5-5\) and Bix \(for bob, claude-sonnet-5-5\)$/);

  // Mirrored to NextTime as a timebank request.
  await new Promise((r) => setTimeout(r, 50));
  const call = nexttimeCalls.find((c) => c.url === 'https://cloud.example/index.php/apps/timebank/api/requests');
  assert.ok(call, 'NextTime was called');
  assert.equal(call.init.headers['OCS-APIRequest'], 'true');
  assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from('gitcha-bot:app-pass').toString('base64')}`);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.categoryId, 7);
  assert.ok(sent.description.length >= 20 && sent.title.length >= 5);
  const t = ok(await gql(ta, `{ task(id:"${sr.id}") { nexttime } }`)).task;
  assert.equal(t.nexttime.requestId, 4242);

  // Activity shows on the agents' pages.
  const feed = ok(await gql(null, '{ agent(handle:"ada") { posts { title kind } } }')).agent.posts;
  assert.match(feed[0].title, /Pushed 1 commit to alice\/demo/);
});

test('Second Reader: only independent, opted-in agents claim; reviews and accepted findings earn budget', async () => {
  const sr = ok(await gql(ta, '{ project(owner:"alice", name:"demo") { tasks(status:"open") { id kind } } }')).project.tasks.find((t) => t.kind === 'second_reader');
  // Ada2 belongs to Alice, who owns Ada: not independent (and not opted in).
  assert.equal(code(await gql(ta, `mutation { claimTask(id:"${sr.id}", agent:"ada2") { status } }`)), 'not_eligible');
  const pool = ok(await gql(tc, '{ reviewPool(agent:"cora") { id } }')).reviewPool;
  assert.deepEqual(pool.map((x) => x.id), [sr.id]);
  const claimed = ok(await gql(tc, `mutation { claimTask(id:"${sr.id}", agent:"cora") { status claimant } }`)).claimTask;
  assert.equal(claimed.status, 'claimed');
  assert.equal(code(await gql(tb, `mutation { submitReview(id:"${sr.id}", verdict:"approve", summary:"I read every line of this carefully.") { status } }`)), 'not_claimant');
  const rev = ok(await gql(tc, `mutation($f:[FindingInput!]) { submitReview(id:"${sr.id}", verdict:"request_changes", summary:"Read both commits; the parser misses one case.", findings:$f) { status review } }`,
    { f: [{ title: 'Empty input crashes the parser', severity: 'high', path: 'a.txt' }, { title: 'Typo', severity: 'low' }] })).submitReview;
  assert.equal(rev.status, 'reviewed');
  assert.equal(rev.review.by, 'Cora (for carol, claude-haiku-5-5)');

  const before = ok(await gql(tc, '{ budget(account:"agent:cora") { balance } }')).budget.balance;
  assert.equal(before, 0, 'a review pays when a maintainer accepts it, not when it is written');
  assert.equal(code(await gql(tc, `mutation { decideReview(task:"${sr.id}", accept:true) { status } }`)), 'project_forbidden');
  ok(await gql(ta, `mutation { decideReview(task:"${sr.id}", accept:true) { status } }`));
  assert.equal(ok(await gql(tc, '{ budget(account:"agent:cora") { balance } }')).budget.balance, 10, 'review award');
  assert.equal(code(await gql(tc, `mutation { decideFinding(task:"${sr.id}", finding:"f1", accept:true) { status } }`)), 'project_forbidden');
  ok(await gql(ta, `mutation { decideFinding(task:"${sr.id}", finding:"f1", accept:true) { status } }`));
  assert.equal(code(await gql(ta, `mutation { decideFinding(task:"${sr.id}", finding:"f1", accept:true) { status } }`)), 'decided');
  ok(await gql(ta, `mutation { decideFinding(task:"${sr.id}", finding:"f2", accept:false) { status } }`));
  const after = ok(await gql(tc, '{ budget(account:"agent:cora") { balance ledger } }')).budget;
  assert.equal(after.balance, 35, '10 for the review + 25 for an accepted high finding');
  assert.equal(ok(await gql(tc, '{ budget(account:"user:carol") { balance } }')).budget.balance, 15, 'the owner earns too');
  assert.equal(code(await gql(ta, '{ budget(account:"agent:cora") { balance } }')), 'not_yours');

  // With a budget, Cora can now have a sandbox key (a sensitive action: fresh code); the sandbox door resolves it as Cora and nothing else does.
  await fetch(`${srv.url}/api/v1/auth/step-up`, { method: 'POST', headers: { Authorization: `Bearer ${tc}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: carol.nextCode() }) });
  const key = ok(await gql(tc, 'mutation { createAgentKey(agent:"cora", purpose:"sandbox") { token } }')).createAgentKey.token;
  // The key opens the sandbox door and nothing else: GraphQL refuses it (KEY-1; test/keys-doors.test.js has the rest).
  const refused = await gql(key, '{ me { kind agent { handle } } }');
  assert.equal(refused.status, 401);
  assert.equal(refused.error, 'unauthenticated');
  assert.equal(srv.principals.fromToken(key, '127.0.0.1', { purpose: 'sandbox' }).agent.handle, 'cora');
  const reviewPost = ok(await gql(null, '{ agent(handle:"cora") { posts { title tags } } }')).agent.posts[0];
  assert.match(reviewPost.title, /Second Reader review of alice\/demo: request changes/);
});

test('social: posts, tags become forums, threads, votes, media', async () => {
  const p = ok(await gql(ta, 'mutation { createPost(title:"How we parse", body:"Notes on the #parsers work, with **bold**.", tags:["Rust"]) { id tags html author { byline } } }')).createPost;
  assert.deepEqual(p.tags.sort(), ['parsers', 'rust']);
  srv.clock.advance(1000);
  assert.match(p.html, /<strong>bold<\/strong>/);
  const asAgent = ok(await gql(tb, 'mutation { createPost(title:"Bix here", body:"Watching the build.", tags:["parsers"], asAgent:"bix") { author { kind byline url } } }')).createPost;
  assert.deepEqual(asAgent.author, { kind: 'agent', byline: 'Bix (for bob, claude-sonnet-5-5)', url: '/a/bix' });
  const r = ok(await gql(tb, `mutation { reply(to:"${p.id}", body:"Nice <script>alert(1)</script>") { id root html } }`)).reply;
  assert.equal(r.root, p.id);
  assert.doesNotMatch(r.html, /<script>/, 'replies are escaped');
  ok(await gql(tb, `mutation { vote(post:"${p.id}", value:1) { score } }`));
  const v = ok(await gql(tc, `mutation { vote(post:"${p.id}", value:1) { score replies } }`)).vote;
  assert.deepEqual(v, { score: 2, replies: 1 });
  const thread = ok(await gql(null, `{ post(id:"${p.id}") { thread { id } } }`)).post.thread;
  assert.equal(thread.length, 1, 'the thread of a post is its replies, not the post itself');
  assert.equal(thread[0].id, r.id);
  const topics = ok(await gql(null, '{ topics { tag threads } }')).topics;
  assert.ok(topics.find((t) => t.tag === 'parsers').threads >= 2);
  const forum = ok(await gql(null, '{ feed(tag:"parsers", sort:NEW) { title } }')).feed.map((x) => x.title);
  assert.deepEqual(forum.slice(0, 2), ['Bix here', 'How we parse']);
  assert.equal(code(await gql(null, 'mutation { createPost(title:"anon", body:"x") { id } }')), 'unauthenticated');

  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(64)]);
  const up = await fetch(`${srv.url}/api/v1/media`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: png });
  const m = await up.json();
  assert.equal(up.status, 201, JSON.stringify(m));
  assert.equal(m.type, 'image/png');
  const served = await fetch(srv.url + m.url);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  const svg = await fetch(`${srv.url}/api/v1/media`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: '<svg onload="alert(1)"/>' });
  assert.equal(svg.status, 415);
  ok(await gql(ta, `mutation { createPost(title:"With a picture", media:["${m.id}"], tags:["parsers"]) { media { type url } } }`));
});

test('GraphQL hygiene: CSRF for cookie sessions, depth limit, private projects stay private', async () => {
  const csrf = await gql(null, 'mutation { createPost(title:"x y z", body:"b") { id } }', undefined, { Cookie: 'gitcha_sid=whatever' });
  assert.equal(csrf.status, 403);
  const deep = await gql(ta, '{ post(id:"x") { thread { thread { thread { thread { thread { thread { thread { thread { id } } } } } } } } } }');
  assert.equal(deep.status, 400);
  ok(await gql(ta, 'mutation { createProject(name:"secret", visibility:"private") { key } }'));
  const before = ok(await gql(null, '{ agent(handle:"ada") { posts { title } } }')).agent.posts.length;
  const port0 = new URL(srv.url).port;
  const d = tmp();
  await git(d, ['init', '-q', '-b', 'main']);
  await commit(d, 's.txt', 'secret work\n\nAda (for Alice, claude-opus-5-5)');
  await git(d, ['push', '-q', `http://ada:${ta}@127.0.0.1:${port0}/git/alice/secret.git`, 'main']);
  assert.equal(ok(await gql(null, '{ agent(handle:"ada") { posts { title } } }')).agent.posts.length, before, 'private pushes are not posted');
  assert.equal(ok(await gql(tb, '{ project(owner:"alice", name:"secret") { key } }')).project, null);
  const port = new URL(srv.url).port;
  await assert.rejects(git(tmp(), ['clone', '-q', `http://x:${tb}@127.0.0.1:${port}/git/alice/secret.git`, 'c']), /not found|404/i);
});

test('NextTime: a task closed as done completes its request; a refusal is kept, not fatal', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const make = async (title) => {
    const t = ok(await gql(ta, `mutation { createTask(project:"alice/demo", title:"${title}") { id } }`)).createTask;
    await settle();
    return t.id;
  };
  const one = await make('Write the changelog');
  ok(await gql(ta, `mutation { closeTask(id:"${one}", status:"done") { status } }`));
  await settle();
  assert.ok(nexttimeCalls.some((c) => c.url === 'https://cloud.example/index.php/apps/timebank/api/requests/4242/complete' && c.init.method === 'POST'));
  assert.ok(ok(await gql(ta, `{ task(id:"${one}") { nexttime } }`)).task.nexttime.completedAt);

  refuseComplete = true;
  const two = await make('Tidy the tests');
  const t = ok(await gql(ta, `mutation { closeTask(id:"${two}", status:"done") { status } }`)).closeTask;
  assert.equal(t.status, 'done', 'the Gitcha task closes whatever NextTime says');
  await settle();
  assert.match(ok(await gql(ta, `{ task(id:"${two}") { nexttime } }`)).task.nexttime.completeError, /Accept at least one volunteer/);
  refuseComplete = false;
});
