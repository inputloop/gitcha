// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The social and project web pages, driven like a browser: a session cookie,
// a CSRF cookie and form posts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser } from './helpers.js';

let srv, cookieA, cookieB, userB;
function browser(cookie) {
  // The server binds the CSRF token to the session cookie, so ask it for one the way a browser does: load a form.
  let token;
  const csrf = async () => {
    if (!token) {
      const r = await fetch(srv.url + '/register', { headers: { Cookie: cookie }, redirect: 'manual' });
      token = /gitcha_csrf=([^;]+)/.exec(r.headers.getSetCookie().join('\n'))[1];
    }
    return token;
  };
  const headers = async () => ({ Cookie: `${cookie}; gitcha_csrf=${await csrf()}` });
  return {
    get: async (p) => { const r = await fetch(srv.url + p, { headers: await headers(), redirect: 'manual' }); return { status: r.status, text: await r.text(), location: r.headers.get('location') }; },
    post: async (p, fields) => {
      const r = await fetch(srv.url + p, { method: 'POST', headers: { ...(await headers()), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(), ...fields }), redirect: 'manual' });
      return { status: r.status, text: await r.text(), location: r.headers.get('location') };
    },
  };
}

before(async () => {
  srv = await startServer({ env: { GITCHA_HOSTING_DOMAINS: 'pages.test' } });
  const a = createUser(srv, 'alice', 'first long pass!');
  const b = createUser(srv, 'bob', 'second long pass');
  userB = b;
  cookieA = `gitcha_sid=${srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 't', ip: '127.0.0.1' }).token}`;
  cookieB = `gitcha_sid=${srv.auth.createSession(srv.store.userByName('bob'), { kind: 'web', name: 't', ip: '127.0.0.1' }).token}`;
  void a; void b;
});
after(() => srv.close());

test('register agents, post to the crawl, reply, vote, and read profiles', async () => {
  const A = browser(cookieA), B = browser(cookieB), anon = browser('x=1');
  assert.equal((await A.post('/agents', { handle: 'ada', name: 'Ada', model: 'claude-opus-5-5' })).status, 303);
  const agentsPage = await A.get('/agents');
  assert.match(agentsPage.text, /Ada \(for alice, claude-opus-5-5\)/);
  const bad = await A.post('/agents', { handle: 'x', name: 'X', model: 'm' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /3-32 lowercase/);

  const made = await A.post('/posts', { title: 'Hello, crawl', body: 'Trying the #intro forum with @ada.', tags: 'intro', asAgent: 'ada' });
  assert.equal(made.status, 303);
  const thread = await anon.get(made.location);
  assert.equal(thread.status, 200, 'threads are readable without an account');
  assert.match(thread.text, /Hello, crawl/);
  assert.match(thread.text, /<a href="\/t\/intro">#intro<\/a>/);
  assert.match(thread.text, /<a href="\/@ada">@ada<\/a>/);
  assert.doesNotMatch(thread.text, /action="\/p\/[^"]+\/vote"/, 'no vote buttons for visitors');

  const id = made.location.split('/').pop();
  assert.equal((await B.post(`/p/${id}/reply`, { body: 'Welcome <b>in</b>!' })).status, 303);
  assert.equal((await B.post(`/p/${id}/vote`, { value: '1' })).status, 303);
  const after = await A.get(`/p/${id}`);
  assert.match(after.text, /Welcome &lt;b&gt;in&lt;\/b&gt;!/, 'replies are escaped');
  assert.match(after.text, /<b>1<\/b>/, 'the score shows');

  const forum = await anon.get('/t/intro');
  assert.match(forum.text, /Hello, crawl/);
  const crawl = await anon.get('/crawl?sort=new');
  assert.match(crawl.text, /Sign up free/);
  assert.equal((await anon.get('/@ada')).location, '/a/ada');
  const agentPage = await anon.get('/a/ada');
  assert.match(agentPage.text, /Ada \(for alice, claude-opus-5-5\)/);
  assert.match(agentPage.text, /run by <a href="\/u\/alice">alice<\/a>/);
  assert.match((await anon.get('/u/alice')).text, /Ada \(for alice/);
});

test('projects, tasks and keys pages; keys need a fresh code', async () => {
  const A = browser(cookieA);
  const p = await A.post('/projects', { name: 'web-demo', description: 'From the web', visibility: 'public', tags: 'web' });
  assert.equal(p.location, '/projects/alice/web-demo');
  const page = await A.get('/projects/alice/web-demo');
  assert.match(page.text, /git clone http:\/\/localhost:\d+\/git\/alice\/web-demo\.git|git clone http:\/\/127\.0\.0\.1/);
  assert.equal((await A.post('/projects/alice/web-demo/tracking', { enabled: 'on' })).status, 303);
  assert.equal((await A.post('/projects/alice/web-demo/tasks', { title: 'Write the docs' })).status, 303);
  const withTask = await A.get('/projects/alice/web-demo');
  const taskId = /href="\/tasks\/(t_[a-f0-9]+)"/.exec(withTask.text)[1];
  assert.match((await A.get(`/tasks/${taskId}`)).text, /Write the docs/);
  assert.equal((await A.post(`/tasks/${taskId}/claim`, {})).status, 303, 'a maintainer claims a plain task for themself');

  assert.equal((await A.get('/keys')).status, 200);
  srv.clock.advance(11 * 60_000);
  const stale = await A.post('/keys/console', { name: 'laptop' });
  assert.equal(stale.status, 303);
  assert.match(stale.location, /^\/verify\?reason=sensitive_action/);
});

test('support tickets and the ring page', async () => {
  const A = browser(cookieA), B = browser(cookieB);
  const t = await A.post('/support', { kind: 'bug', title: 'The upload button is grey', body: 'Since this morning.' });
  assert.equal(t.status, 303);
  const page = await A.get(t.location);
  assert.match(page.text, /The upload button is grey/);
  assert.equal((await B.get(t.location)).status, 404, 'other people cannot read it');
  assert.equal((await A.post(t.location, { body: 'Still grey.' })).status, 303);
  assert.match((await A.get('/support')).text, /T-0001/);
  const ring = await browser('x=1').get('/ring');
  assert.equal(ring.status, 200);
  assert.match(ring.text, /The Gitcha ring/);
});

test('the sign-up form checks the password and email confirmations', async () => {
  const anon = browser('x=1');
  const base = { username: 'erin', password: 'a quiet harbour light', confirm: 'a quiet harbour light' };
  const pw = await anon.post('/register', { ...base, confirm: 'something else' });
  assert.equal(pw.status, 400);
  assert.match(pw.text, /The passwords do not match/);
  const em = await anon.post('/register', { ...base, email: 'erin@example.org', email_confirm: 'erin@example.net' });
  assert.equal(em.status, 400);
  assert.match(em.text, /The email addresses do not match/);
  assert.match(em.text, /value="erin@example\.org"/, 'the email is kept for another try; the passwords are not');
  assert.doesNotMatch(em.text, /a quiet harbour light/);
  const good = await anon.post('/register', { ...base, email: 'erin@example.org', email_confirm: 'erin@example.org' });
  assert.equal(good.status, 303);
  assert.equal(good.location, '/setup-2fa');
  assert.equal(srv.auth.emailOf(srv.store.userByName('erin')), 'erin@example.org');
});

test('the account page answers, and its forms work: email, check toggles, recovery codes', async () => {
  const tok = srv.auth.createSession(srv.store.userByName('bob'), { kind: 'web', name: 'acct', ip: '127.0.0.1' }).token;
  const B = browser(`gitcha_sid=${tok}`);
  const page = await B.get('/account');
  assert.equal(page.status, 200);
  assert.match(page.text, /Account security/);
  assert.match(page.text, /No email on file/);
  const bad = await B.post('/account/email', { email: 'bob@example.org', email_confirm: 'bob@example.com' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /The email addresses do not match/);
  const ok = await B.post('/account/email', { email: 'bob@example.org', email_confirm: 'bob@example.org' });
  assert.equal(ok.location, '/account?msg=email_saved');
  assert.match((await B.get('/account?msg=email_saved')).text, /On file: <strong>bob@example\.org<\/strong>/);
  assert.equal((await B.post('/account/checks', { interval: 'on', sensitive: 'on' })).status, 401, 'the form needs its own code');
  assert.equal((await B.post('/account/checks', { interval: 'on', sensitive: 'on', code: userB.nextCode() })).location, '/account?msg=checks_saved');
  assert.equal(srv.auth.checkSettings(srv.store.userByName('bob')).new_network, false);
  assert.match((await B.post('/account/recovery-codes', {})).text, /recovery codes/i);
});

test('K4: sandbox keys are listed on the agents page and revoked one at a time', async () => {
  const alice = srv.store.userByName('alice');
  const A = browser(`gitcha_sid=${srv.auth.createSession(alice, { kind: 'web', name: 'keys', ip: '127.0.0.1' }).token}`);
  srv.budgets.entry('agent:ada', 3, 'seed');
  const one = srv.keys.createAgentKey(alice, srv.agents.get('ada'), { purpose: 'sandbox' }, '127.0.0.1');
  const two = srv.keys.createAgentKey(alice, srv.agents.get('ada'), { purpose: 'sandbox' }, '127.0.0.1');
  const page = (await A.get('/agents')).text;
  assert.match(page, new RegExp(`/agents/ada/sandbox-key/${one.id}/revoke`));
  assert.match(page, new RegExp(`/agents/ada/sandbox-key/${two.id}/revoke`));
  assert.doesNotMatch(page, /gak_/, 'the page never shows a secret again');
  assert.equal((await A.post(`/agents/ada/sandbox-key/${one.id}/revoke`, {})).status, 303);
  assert.equal(srv.principals.fromToken(one.token, '127.0.0.1', { purpose: 'sandbox' }), null);
  assert.equal(srv.principals.fromToken(two.token, '127.0.0.1', { purpose: 'sandbox' })?.agent.handle, 'ada');
  assert.doesNotMatch((await A.get('/agents')).text, new RegExp(`sandbox-key/${one.id}/revoke`));
  const B = browser(`gitcha_sid=${srv.auth.createSession(srv.store.userByName('bob'), { kind: 'web', name: 'keys', ip: '127.0.0.1' }).token}`);
  assert.equal((await B.post(`/agents/ada/sandbox-key/${two.id}/revoke`, {})).status, 403, 'not bob\'s agent');
});

test('KEY-2: the console key form stamps the key with the code time of the session that asked', async () => {
  const made = srv.auth.createSession(srv.store.userByName('alice'), { kind: 'web', name: 'form', ip: '127.0.0.1' });
  const typed = made.session.mfaAt;
  srv.clock.advance(5 * 60_000);
  const A = browser(`gitcha_sid=${made.token}`);
  assert.equal((await A.post('/keys/console', { name: 'web-minted' })).status, 200);
  const child = Object.values(srv.store.data.sessions).find((x) => x.name === 'console: web-minted');
  assert.equal(child.mfaAt, typed, 'five minutes older than "now": no new window');
});
