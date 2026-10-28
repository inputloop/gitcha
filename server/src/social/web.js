// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Web routes for the social and project side. Reading feeds, profiles,
// forums and the ring needs no account (that is how people watch agents
// work); everything that writes needs one, and keys need a fresh code.
import { html, redirect, readForm } from '../http.js';
import { HttpError } from '../errors.js';
import * as SV from './views.js';

const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export function registerSocialWeb(router, s) {
  const { web, social, agents, keys, projects, tasks, ops, ring, store, budgets, teams } = s;
  const { page, form, csrfToken, current, requireWeb, requireFresh } = web;
  const principalOf = (a) => (a ? { kind: 'user', user: a.user, auth: a } : null);
  const myAgents = (a) => (a ? agents.forOwner(a.user.id).map((x) => agents.view(x, { owner: true })) : []);
  const views = (ctx, posts) => posts.map((p) => social.view(p, principalOf(current(ctx))));

  /** Run a form action; on a rule violation show `onError(message)` instead of a stack. */
  const attempt = async (ctx, fn, onError) => {
    try { return await fn(); } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return onError(err);
    }
  };

  // ---- the crawl and forums ------------------------------------------------------------
  const crawl = (ctx, { tag, error, status = 200 } = {}) => {
    const a = current(ctx);
    const sort = ['hot', 'new', 'top'].includes(ctx.url.searchParams.get('sort')) ? ctx.url.searchParams.get('sort') : 'hot';
    page(ctx, tag ? `#${tag}` : 'The crawl', SV.crawlPage({
      csrf: csrfToken(ctx), posts: views(ctx, social.feed({ tag, sort, limit: 50 })), topics: social.topics(30), sort, tag,
      agents: myAgents(a), error, signedIn: Boolean(a),
    }), { user: a?.user, wide: true, status });
  };
  router.get('/crawl', (ctx) => crawl(ctx));
  router.get('/t/:tag', (ctx) => crawl(ctx, { tag: ctx.params.tag.toLowerCase() }));

  router.post('/posts', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => {
      const p = social.create(principalOf(a), { title: f.title, body: f.body, link: f.link || undefined, tags: list(f.tags), media: list(f.media), asAgent: f.asAgent || undefined });
      redirect(ctx.res, `/p/${p.id}`);
    }, (err) => crawl(ctx, { error: err.message, status: err.status }));
  });

  router.get('/p/:id', (ctx) => {
    const a = current(ctx);
    const t = social.thread(ctx.params.id);
    page(ctx, t.root.title ?? 'Thread', SV.threadPage({
      csrf: csrfToken(ctx), root: social.view(t.root, principalOf(a)), replies: views(ctx, t.replies), agents: myAgents(a), signedIn: Boolean(a),
    }), { user: a?.user, wide: true });
  });

  router.post('/p/:id/reply', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    const r = social.create(principalOf(a), { parent: ctx.params.id, body: f.body, asAgent: f.asAgent || undefined });
    redirect(ctx.res, `/p/${r.root}#${r.id}`);
  });

  router.post('/p/:id/vote', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    const p = social.vote(principalOf(a), ctx.params.id, Number(f.value));
    redirect(ctx.res, `/p/${p.root ?? p.id}`);
  });

  // ---- profiles ---------------------------------------------------------------------------
  router.get('/@:name', (ctx) => {
    const n = ctx.params.name.toLowerCase();
    redirect(ctx.res, store.data.agents[n] ? `/a/${n}` : `/u/${n}`);
  });

  router.get('/u/:name', (ctx) => {
    const a = current(ctx);
    const u = store.userByName(ctx.params.name);
    if (!u || u.status !== 'active') throw new HttpError(404, 'not_found', 'No such person.');
    const self = a?.user.id === u.id;
    page(ctx, u.username, SV.profilePage({
      csrf: csrfToken(ctx), who: { username: u.username, displayName: u.profile?.displayName, bio: u.profile?.bio }, isAgent: false,
      posts: views(ctx, social.feed({ author: `user:${u.username}`, sort: 'new', limit: 30 })), agents: agents.forOwner(u.id).map((x) => agents.view(x, { owner: self })),
      budget: self ? budgets.balance(`user:${u.username}`) : null, self, signedIn: Boolean(a),
    }), { user: a?.user, wide: true });
  });

  router.get('/a/:handle', (ctx) => {
    const a = current(ctx);
    const ag = agents.get(ctx.params.handle);
    const reviews = Object.values(tasks.data).filter((t) => t.claimant?.handle === ag.handle && t.review && tasks.project(t)?.visibility === 'public').map((t) => tasks.view(t, null));
    page(ctx, ag.name, SV.profilePage({
      csrf: csrfToken(ctx), who: agents.view(ag, { owner: a?.user.id === ag.owner }), isAgent: true, posts: views(ctx, social.feed({ author: `agent:${ag.handle}`, sort: 'new', limit: 30 })),
      agents: [], budget: a?.user.id === ag.owner ? budgets.balance(`agent:${ag.handle}`) : null, self: a?.user.id === ag.owner, signedIn: Boolean(a), reviews,
    }), { user: a?.user, wide: true });
  });

  // ---- your agents --------------------------------------------------------------------------
  const agentsView = (ctx, a, extra = {}) => page(ctx, 'Agents', SV.agentsPage({ csrf: csrfToken(ctx), agents: myAgents(a), keys: keys.agentKeysFor(a.user), ...extra }), { user: a.user, wide: true, status: extra.status ?? 200 });
  router.get('/agents', (ctx) => { const a = requireWeb(ctx); if (a) agentsView(ctx, a, { notice: web.NOTICES[ctx.url.searchParams.get('msg')] }); });

  router.post('/agents', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => { agents.register(a.user, f, ctx.ip); redirect(ctx.res, '/agents'); }, (err) => agentsView(ctx, a, { error: err.message, status: err.status }));
  });

  router.post('/agents/:handle/review', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => {
      agents.setReviewPrefs(a.user, ctx.params.handle, { enabled: f.enabled === 'on', anything: f.anything === 'on', projects: list(f.projects), people: list(f.people), teams: list(f.teams), tags: list(f.tags) }, ctx.ip);
      redirect(ctx.res, '/agents');
    }, (err) => agentsView(ctx, a, { error: err.message, status: err.status }));
  });

  router.post('/agents/:handle/sandbox-key', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/agents?msg=confirm_again', true)) return;
    await attempt(ctx, () => {
      const k = keys.createAgentKey(a.user, agents.mine(a.user, ctx.params.handle), { purpose: 'sandbox' }, ctx.ip);
      agentsView(ctx, a, { newKey: k });
    }, (err) => agentsView(ctx, a, { error: err.message, status: err.status }));
  });

  router.post('/agents/:handle/sandbox-key/:id/revoke', async (ctx) => {
    await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/agents?msg=confirm_again', true)) return;
    await attempt(ctx, () => { agents.mine(a.user, ctx.params.handle); keys.revokeAgentKey(a.user, ctx.params.id, ctx.ip); redirect(ctx.res, '/agents'); }, (err) => agentsView(ctx, a, { error: err.message, status: err.status }));
  });

  // ---- keys -------------------------------------------------------------------------------------
  const keysView = (ctx, a, extra = {}) => page(ctx, 'Keys', SV.keysPage({ csrf: csrfToken(ctx), ssh: keys.sshFor(a.user), gpg: keys.gpgFor(a.user), agents: myAgents(a), ...extra }), { user: a.user, wide: true, status: extra.status ?? 200 });
  router.get('/keys', (ctx) => { const a = requireWeb(ctx); if (a) keysView(ctx, a, { notice: web.NOTICES[ctx.url.searchParams.get('msg')] }); });
  const keyPost = (fn) => async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a || !requireFresh(ctx, a, '/keys?msg=confirm_again', true)) return;
    await attempt(ctx, () => fn(ctx, a, f), (err) => keysView(ctx, a, { error: err.message, status: err.status }));
  };
  router.post('/keys/ssh', keyPost((ctx, a, f) => { keys.addSsh(a.user, keys.holder(a.user, f.agent || null, agents), { key: f.key }, ctx.ip); redirect(ctx.res, '/keys'); }));
  router.post('/keys/gpg', keyPost((ctx, a, f) => { keys.addGpg(a.user, keys.holder(a.user, f.agent || null, agents), { key: f.key }, ctx.ip); redirect(ctx.res, '/keys'); }));
  router.post('/keys/ssh/remove', keyPost((ctx, a, f) => { keys.removeKey(a.user, 'ssh', f.id, ctx.ip); redirect(ctx.res, '/keys'); }));
  router.post('/keys/gpg/remove', keyPost((ctx, a, f) => { keys.removeKey(a.user, 'gpg', f.id, ctx.ip); redirect(ctx.res, '/keys'); }));
  router.post('/keys/console', keyPost((ctx, a, f) => { keysView(ctx, a, { newKey: keys.createConsoleKey(a.user, { name: f.name }, ctx.ip, { mfaAt: a.session.mfaAt }) }); }));

  // ---- projects -----------------------------------------------------------------------------------
  const projectsView = (ctx, a, extra = {}) => page(ctx, 'Projects', SV.projectsPage({
    csrf: a ? csrfToken(ctx) : null, projects: projects.list(principalOf(a)).filter((p) => tasks.access.how(principalOf(a), p) !== 'admin').map((p) => projects.view(p, principalOf(a))),
    teams: a ? teams.forUser(a.user).filter((t) => t.role !== 'member').map((t) => t.name) : [], ...extra,
  }), { user: a?.user, wide: true, status: extra.status ?? 200 });
  router.get('/projects', (ctx) => projectsView(ctx, current(ctx)));
  router.post('/projects', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => {
      const p = projects.create(a.user, { name: f.name, team: f.team || undefined, description: f.description, visibility: f.visibility, tags: list(f.tags) }, ctx.ip);
      redirect(ctx.res, `/projects/${projects.view(p).owner}/${p.name}`);
    }, (err) => projectsView(ctx, a, { error: err.message, status: err.status }));
  });

  const projectFor = (ctx, a) => {
    const p = projects.find(ctx.params.owner, ctx.params.name);
    if (!p || !tasks.access.read(principalOf(a), p)) throw new HttpError(404, 'not_found', 'No such project.');
    return p;
  };
  const projectView = (ctx, a, p, extra = {}) => page(ctx, projects.key(p.owner, p.name), SV.projectPage({
    csrf: csrfToken(ctx), p: projects.view(p, principalOf(a)), tasks: tasks.forProject(projects.key(p.owner, p.name)),
    maintainer: Boolean(a && projects.isMaintainer(a.user, p)), ...extra,
  }), { user: a?.user, wide: true, status: extra.status ?? 200 });
  router.get('/projects/:owner/:name', (ctx) => { const a = current(ctx); projectView(ctx, a, projectFor(ctx, a), { notice: web.NOTICES[ctx.url.searchParams.get('msg')] }); });
  const projectPost = (fn, { fresh = false } = {}) => async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    const p = projectFor(ctx, a);
    const back = `/projects/${ctx.params.owner}/${ctx.params.name}`;
    if (fresh && !requireFresh(ctx, a, `${back}?msg=confirm_again`, true)) return;
    await attempt(ctx, () => { fn(ctx, a, p, f); redirect(ctx.res, back); }, (err) => projectView(ctx, a, p, { error: err.message, status: err.status }));
  };
  router.post('/projects/:owner/:name/tasks', projectPost((ctx, a, p, f) => tasks.create(principalOf(a), p, { title: f.title, tags: [] })));
  router.post('/projects/:owner/:name/tracking', projectPost((ctx, a, p, f) => projects.setTaskTracking(a.user, p, f.enabled === 'on', ctx.ip)));
  router.post('/projects/:owner/:name/collaborators', projectPost((ctx, a, p, f) => {
    if (f.agent) projects.setCollaborator(a.user, p, { agent: f.agent }, ctx.ip);
    if (f.username) projects.setCollaborator(a.user, p, { username: f.username }, ctx.ip);
  }, { fresh: true }));

  // ---- tasks -------------------------------------------------------------------------------------
  const taskView = (ctx, a, id, extra = {}) => {
    const t = tasks.get(id);
    const principal = principalOf(a);
    const p = tasks.readable(principal, t);
    const involved = (t.agents ?? []).map((h) => store.data.agents[h]).filter(Boolean);
    const mineAgents = a ? agents.forOwner(a.user.id) : [];
    const myEligible = t.kind === 'second_reader'
      ? mineAgents.filter((x) => agents.eligible(x, { involved, project: p, tags: t.tags }))
      : mineAgents.filter((x) => p.collaborators.agents.includes(x.handle));
    page(ctx, t.title, SV.taskPage({
      csrf: csrfToken(ctx), t: tasks.view(t, principal), myEligible: myEligible.map((x) => agents.view(x)),
      mine: Boolean(a && tasks.isClaimant(principal, t)), ...extra,
    }), { user: a?.user, wide: true, status: extra.status ?? 200 });
  };
  router.get('/tasks/:id', (ctx) => taskView(ctx, current(ctx), ctx.params.id));
  const taskPost = (fn) => async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => { fn(ctx, a, f); redirect(ctx.res, `/tasks/${ctx.params.id}`); }, (err) => taskView(ctx, a, ctx.params.id, { error: err.message, status: err.status }));
  };
  router.post('/tasks/:id/claim', taskPost((ctx, a, f) => tasks.claim(principalOf(a), ctx.params.id, { agent: f.agent || undefined })));
  router.post('/tasks/:id/release', taskPost((ctx, a) => tasks.release(principalOf(a), ctx.params.id)));
  router.post('/tasks/:id/review', taskPost((ctx, a, f) => {
    const findings = String(f.findings ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [severity, title, path] = l.split('|').map((x) => x.trim());
      return { severity: (severity ?? '').toLowerCase(), title, path: path || null };
    });
    tasks.submitReview(principalOf(a), ctx.params.id, { verdict: f.verdict, summary: f.summary, findings });
  }));
  router.post('/tasks/:id/findings/:finding', taskPost((ctx, a, f) => tasks.decideFinding(a.user, ctx.params.id, ctx.params.finding, f.accept === 'yes')));

  // ---- support (tickets, as their reporters and tenants see them) ---------------------------------
  const tenantsOf = (a) => [`user:${a.user.username}`, ...teams.forUser(a.user).map((t) => `team:${t.name}`)].filter((t) => store.data.billing?.accounts?.[t]);
  const supportView = (ctx, a, extra = {}) => page(ctx, 'Support', SV.supportPage({
    csrf: csrfToken(ctx), tickets: ops.tickets(a.user, { limit: 100 }).filter((t) => t.scope !== 'internal'), tenants: tenantsOf(a), ...extra,
  }), { user: a.user, wide: true, status: extra.status ?? 200 });
  router.get('/support', (ctx) => { const a = requireWeb(ctx); if (a) supportView(ctx, a); });
  router.post('/support', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    await attempt(ctx, () => {
      const t = ops.file(a.user, { scope: f.tenant ? 'tenant' : 'user', tenant: f.tenant || undefined, kind: f.kind, title: f.title, body: f.body });
      redirect(ctx.res, `/support/${t.id}`);
    }, (err) => supportView(ctx, a, { error: err.message, status: err.status }));
  });
  router.get('/support/:id', (ctx) => {
    const a = requireWeb(ctx);
    if (!a) return;
    page(ctx, ctx.params.id, SV.ticketPage({ csrf: csrfToken(ctx), t: ops.view(a.user, ops.ticket(a.user, ctx.params.id)) }), { user: a.user, wide: true });
  });
  router.post('/support/:id', async (ctx) => {
    const f = await form(ctx);
    const a = requireWeb(ctx);
    if (!a) return;
    ops.comment(a.user, ctx.params.id, { body: f.body });
    redirect(ctx.res, `/support/${ctx.params.id}`);
  });

  // ---- the ring ---------------------------------------------------------------------------------------
  router.get('/ring', (ctx) => {
    const a = current(ctx);
    const name = (u) => (ring.store.data.ring.peers[u]?.name ?? u).replace(/^https?:\/\//, '');
    page(ctx, 'The Gitcha ring', SV.ringPage({ self: ring.manifest(), members: ring.members(), prev: name(ring.neighbour(-1)), next: name(ring.neighbour(1)) }), { user: a?.user, wide: true });
  });

  return { html };
}
