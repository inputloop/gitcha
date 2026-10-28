// The social and project web pages, driven like a browser: a session cookie,
// a CSRF cookie and form posts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser } from './helpers.js';

let srv, cookieA, cookieB;
const CSRF = 'test-csrf-token-0123456789abcdef';

function browser(cookie) {
  const headers = { Cookie: `${cookie}; gitcha_csrf=${CSRF}` };
  return {
    get: async (p) => { const r = await fetch(srv.url + p, { headers, redirect: 'manual' }); return { status: r.status, text: await r.text(), location: r.headers.get('location') }; },
    post: async (p, fields) => {
      const r = await fetch(srv.url + p, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }), redirect: 'manual' });
      return { status: r.status, text: await r.text(), location: r.headers.get('location') };
    },
  };
}

before(async () => {
  srv = await startServer({ env: { GITCHA_HOSTING_DOMAINS: 'pages.test' } });
  const a = createUser(srv, 'alice', 'first long pass!');
  const b = createUser(srv, 'bob', 'second long pass');
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
