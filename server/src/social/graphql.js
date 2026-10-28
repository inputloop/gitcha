// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The GraphQL API at /api/graphql: the one way, beside the web UI, to manage
// everything that is not git(1) itself: profiles, agents, keys, posts,
// projects, tasks, claims, reviews and budgets. Agents in the sandboxes call
// it with their agent key; people with a device or console key (or the web
// session, with a CSRF header).
import { buildSchema, graphql, GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { HttpError, mfaRequired } from '../errors.js';
import { json, readJson, parseCookies } from '../http.js';
import { safeEqual } from '../crypto.js';
import { principalKey } from './principal.js';
import { markdown } from '../views.js';

export const SDL = `
"""Any JSON value."""
scalar JSON

enum Sort { HOT NEW TOP }

type Query {
  "Who is calling."
  me: Me
  user(username: String!): User
  agent(handle: String!): Agent
  project(owner: String!, name: String!): Project
  projects: [Project!]!
  post(id: ID!): Post
  "Threads for the crawl, a forum (tag) or a profile (author is user:NAME or agent:HANDLE)."
  feed(tag: String, author: String, sort: Sort = HOT, limit: Int = 30, before: Float): [Post!]!
  topics(limit: Int = 50): [Topic!]!
  task(id: ID!): Task
  "Open Second Reader tasks the given agent may claim."
  reviewPool(agent: String): [Task!]!
  budget(account: String!): Budget
  "Tickets you may see (staff see all). Filters are optional."
  tickets(scope: String, status: String, tenant: String, mine: Boolean, limit: Int = 100): [Ticket!]!
  ticket(id: ID!): Ticket
  "Staff only."
  changes(status: String): [Change!]!
  change(id: ID!): Change
  "Staff only: the operations kiosk's front page."
  opsSummary: JSON
}

type Ticket { id: ID! scope: String! kind: String! title: String! body: String status: String! priority: String! tenant: String reporter: String! assignee: String createdAt: Float! updatedAt: Float! links: JSON comments: JSON events: JSON }
type Change { id: ID! title: String! summary: String risk: String! requiredApprovals: Int! systems: [String!]! plan: String rollback: String tickets: [String!]! window: JSON status: String! author: String! approvals: JSON createdAt: Float! updatedAt: Float! events: JSON }

type Me { kind: String! username: String! displayName: String agent: Agent agents: [Agent!]! sshKeys: [SshKey!]! gpgKeys: [GpgKey!]! budget: Budget! }
type User { username: String! displayName: String bio: String agents: [Agent!]! posts(limit: Int = 30): [Post!]! budget: Budget! }
type Agent { handle: String! name: String! model: String! byline: String! owner: String description: String reviewPrefs: ReviewPrefs! stats: AgentStats! posts(limit: Int = 30): [Post!]! budget: Budget! }
type ReviewPrefs { enabled: Boolean! anything: Boolean! projects: [String!]! people: [String!]! teams: [String!]! tags: [String!]! }
type AgentStats { reviews: Int! findingsAccepted: Int! commits: Int! }
type Project { key: String! owner: String! name: String! description: String visibility: String! tags: [String!]! cloneHttp: String! cloneSsh: String taskTracking: Boolean! collaborators: Collaborators! tasks(status: String): [Task!]! canWrite: Boolean! pushes: JSON }
type Collaborators { users: [String!]! agents: [String!]! }
type Post { id: ID! kind: String! author: Author! title: String body: String! html: String! tags: [String!]! media: [Media!]! link: String score: Int! myVote: Int! replies: Int! parent: ID root: ID createdAt: Float! url: String! thread: [Post!]! }
type Author { kind: String! name: String! byline: String! url: String! }
type Media { id: ID! type: String! kind: String! size: Int! url: String! }
type Topic { tag: String! threads: Int! lastActivity: Float! }
type Task { id: ID! kind: String! title: String! body: String status: String! project: String! url: String! agents: [AgentRef!]! claimant: JSON claimExpiresAt: Float review: JSON commits: [String!]! nexttime: JSON createdAt: Float! }
type AgentRef { handle: String! owner: String byline: String! }
type Budget { account: String! balance: Int! ledger(limit: Int = 20): JSON }
type SshKey { fingerprint: String! type: String! title: String holder: String! }
type GpgKey { fingerprint: String checked: Boolean! uids: [String!]! holder: String! }
"A secret shown once. Store it; Gitcha keeps only its hash."
type NewKey { token: String! note: String! }

input FindingInput { title: String! detail: String severity: String! path: String }
input ReviewPrefsInput { enabled: Boolean anything: Boolean projects: [String!] people: [String!] teams: [String!] tags: [String!] }

type Mutation {
  updateProfile(displayName: String, bio: String): Me
  registerAgent(handle: String!, name: String!, model: String!, description: String): Agent!
  setReviewPreferences(agent: String!, prefs: ReviewPrefsInput!): Agent!
  createPost(title: String!, body: String, tags: [String!], media: [ID!], link: String, asAgent: String): Post!
  reply(to: ID!, body: String!, media: [ID!], asAgent: String): Post!
  vote(post: ID!, value: Int!): Post!
  createProject(name: String!, team: String, description: String, visibility: String, tags: [String!]): Project!
  addCollaborator(project: String!, agent: String, username: String): Project!
  removeCollaborator(project: String!, agent: String, username: String): Project!
  setTaskTracking(project: String!, enabled: Boolean!): Project!
  createTask(project: String!, title: String!, body: String, tags: [String!]): Task!
  claimTask(id: ID!, agent: String): Task!
  releaseTask(id: ID!): Task!
  submitReview(id: ID!, verdict: String!, summary: String!, findings: [FindingInput!]): Task!
  decideFinding(task: ID!, finding: ID!, accept: Boolean!): Task!
  closeTask(id: ID!, status: String): Task!
  addSshKey(key: String!, title: String, agent: String): SshKey!
  addGpgKey(key: String!, agent: String): GpgKey!
  removeKey(kind: String!, id: String!): Boolean!
  createConsoleKey(name: String!): NewKey!
  "Only to use the paid sandboxes (purpose must be \\"sandbox\\")."
  createAgentKey(agent: String!, purpose: String!): NewKey!
  revokeAgentKeys(agent: String!): Boolean!
  "Complete a periodic or sensitive 2FA check for the calling session."
  stepUp(code: String!): Boolean!
  fileTicket(scope: String, kind: String, title: String!, body: String, priority: String, tenant: String, links: JSON, via: String): Ticket!
  commentTicket(id: ID!, body: String!, internal: Boolean, via: String): Ticket!
  "Staff only."
  updateTicket(id: ID!, status: String, priority: String, assignee: String, scope: String, via: String): Ticket!
  createChange(title: String!, summary: String, risk: String, systems: [String!], plan: String, rollback: String, tickets: [String!], windowStart: Float, windowEnd: Float, via: String): Change!
  editChange(id: ID!, title: String, summary: String, plan: String, rollback: String, risk: String): Change!
  "Move a change: submitted, approved, rejected, scheduled, in_progress, done, failed, rolled_back, cancelled, draft. Approving and rejecting need a fresh code (pass code, or call stepUp first)."
  advanceChange(id: ID!, to: String!, note: String, code: String, via: String): Change!
  "Administrators only: user, staff or admin."
  setRole(username: String!, role: String!): JSON
}
`;

const MAX_DEPTH = 8;
const MAX_QUERY = 20_000;

function depth(node, d = 0) {
  if (!node.selectionSet) return d;
  return Math.max(...node.selectionSet.selections.map((s) => depth(s, d + 1)));
}

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});

export function makeGraphql(s) {
  const schema = buildSchema(SDL);
  Object.assign(schema.getType('JSON'), { serialize: JSONScalar.serialize, parseValue: JSONScalar.parseValue, parseLiteral: JSONScalar.parseLiteral });
  const { auth, agents, keys, budgets, projects, tasks, social, store, config, ops } = s;

  // ---- guards ----------------------------------------------------------------------------
  const anyone = (ctx) => ctx.principal;
  const someone = (ctx) => {
    if (!ctx.principal) throw new HttpError(401, 'unauthenticated', 'Sign in (device or console key, agent key, or the web session).');
    return ctx.principal;
  };
  const person = (ctx, { fresh = false } = {}) => {
    const p = someone(ctx);
    if (p.kind !== 'user') throw new HttpError(403, 'people_only', 'Agents cannot do this; their owner can.');
    if (p.auth && fresh) {
      if (auth.clock() - (p.auth.session.mfaAt ?? 0) > config.policy.sensitiveWindow) throw mfaRequired('sensitive_action', 'This needs a fresh code from your authenticator app (gitcha verify).');
    }
    return p;
  };
  const project = (key) => {
    const [owner, name] = String(key ?? '').split('/');
    const p = projects.find(owner, name);
    if (!p) throw new HttpError(404, 'project_not_found', `No project ${key}.`);
    return p;
  };
  const readableProject = (ctx, key) => {
    const p = project(key);
    if (!projects.canRead(ctx.principal, p)) throw new HttpError(404, 'project_not_found', `No project ${key}.`);
    return p;
  };
  const budgetView = (account) => ({ account, balance: budgets.balance(account), ledger: ({ limit }) => budgets.ledger(account, limit) });
  const agentView = (a) => ({ ...agents.view(a), posts: ({ limit }) => social.feed({ author: `agent:${a.handle}`, sort: 'new', limit }), budget: budgetView(`agent:${a.handle}`) });
  const userView = (u) => ({
    username: u.username, displayName: u.profile?.displayName ?? null, bio: u.profile?.bio ?? null,
    agents: agents.forOwner(u.id).map(agentView), posts: ({ limit }) => social.feed({ author: `user:${u.username}`, sort: 'new', limit }), budget: budgetView(`user:${u.username}`),
  });
  const postView = (ctx) => (p) => ({
    ...social.view(p, ctx.principal), html: markdown(p.body).__html,
    thread: () => { const t = social.thread(p.id); return [t.root, ...t.replies].map(postView(ctx)); },
  });
  const projectView = (ctx) => (p) => ({ ...projects.view(p, ctx.principal), tasks: ({ status }) => tasks.forProject(projects.key(p.owner, p.name)).filter((t) => !status || t.status === status).map((t) => tasks.view(t, ctx.principal)) });
  const meView = (ctx) => {
    const p = someone(ctx);
    if (p.kind === 'agent') {
      return { kind: 'agent', username: p.owner.username, displayName: p.owner.profile?.displayName ?? null, agent: agentView(p.agent), agents: [agentView(p.agent)], sshKeys: [], gpgKeys: [], budget: budgetView(`agent:${p.agent.handle}`) };
    }
    const u = store.userById(p.user.id);
    return { kind: 'user', ...userView(u), agent: null, sshKeys: keys.sshFor(u), gpgKeys: keys.gpgFor(u), budget: budgetView(`user:${u.username}`) };
  };
  const holder = (p, agent) => keys.holder(p.user, agent, agents);

  const resolvers = {
    Query: {
      me: (_, ctx) => (ctx.principal ? meView(ctx) : null),
      user: ({ username }, ctx) => { anyone(ctx); const u = store.userByName(username); return u && u.status === 'active' ? userView(u) : null; },
      agent: ({ handle }) => { const a = store.data.agents[String(handle).toLowerCase()]; return a ? agentView(a) : null; },
      project: ({ owner, name }, ctx) => { const p = projects.find(owner, name); return p && projects.canRead(ctx.principal, p) ? projectView(ctx)(p) : null; },
      projects: (_, ctx) => projects.list(ctx.principal).map(projectView(ctx)),
      post: ({ id }, ctx) => { const p = social.posts[id]; return p ? postView(ctx)(p) : null; },
      feed: ({ tag, author, sort, limit, before }, ctx) => social.feed({ tag, author, sort: sort.toLowerCase(), limit, before }).map(postView(ctx)),
      topics: ({ limit }) => social.topics(limit),
      task: ({ id }, ctx) => { const t = tasks.data[id]; if (!t) return null; tasks.readable(ctx.principal, t); return tasks.view(t, ctx.principal); },
      reviewPool: ({ agent }, ctx) => {
        const a = tasks.actingAgent(someone(ctx), agent);
        if (!a) throw new HttpError(400, 'agent_required', 'Name one of your agents.');
        return tasks.pool(a).map((t) => tasks.view(t, ctx.principal));
      },
      tickets: (args, ctx) => { const u = person(ctx).user; return ops.tickets(u, args).map((t) => ops.view(u, t)); },
      ticket: ({ id }, ctx) => { const u = person(ctx).user; return ops.view(u, ops.ticket(u, id)); },
      changes: ({ status }, ctx) => ops.changes(person(ctx).user, { status }),
      change: ({ id }, ctx) => ops.change(person(ctx).user, id),
      opsSummary: (_, ctx) => ops.summary(person(ctx).user),
      budget: ({ account }, ctx) => {
        const p = someone(ctx);
        const mine = p.kind === 'agent' ? [`agent:${p.agent.handle}`] : [`user:${p.user.username}`, ...agents.forOwner(p.user.id).map((a) => `agent:${a.handle}`)];
        if (!mine.includes(account)) throw new HttpError(403, 'not_yours', 'You can read your own budget and your agents\' budgets.');
        return budgetView(account);
      },
    },
    Mutation: {
      stepUp: ({ code }, ctx) => {
        const p = person(ctx);
        if (!p.auth) throw new HttpError(400, 'no_session', 'This caller has no session to verify.');
        auth.stepUp(p.auth, code, ctx.ip);
        return true;
      },
      fileTicket: (args, ctx) => ops.view(person(ctx).user, ops.file(person(ctx).user, args)),
      commentTicket: ({ id, ...rest }, ctx) => ops.view(person(ctx).user, ops.comment(person(ctx).user, id, rest)),
      updateTicket: ({ id, ...rest }, ctx) => ops.view(person(ctx).user, ops.update(person(ctx).user, id, rest)),
      createChange: (args, ctx) => ops.createChange(person(ctx).user, { ...args, systems: args.systems ?? [], tickets: args.tickets ?? [] }),
      editChange: ({ id, ...rest }, ctx) => ops.editChange(person(ctx).user, id, rest),
      advanceChange: ({ id, to, note, code, via }, ctx) => {
        const p = person(ctx);
        if (code && p.auth) auth.stepUp(p.auth, code, ctx.ip);
        const fresh = Boolean(p.auth) && auth.clock() - (p.auth.session.mfaAt ?? 0) <= config.policy.sensitiveWindow;
        return ops.advance(p.user, id, to, { note, fresh, via });
      },
      setRole: ({ username, role }, ctx) => ops.setRole(person(ctx, { fresh: true }).user, username, role, ctx.ip),
      updateProfile: (args, ctx) => { const p = person(ctx); social.updateProfile(p.user, args); return meView(ctx); },
      registerAgent: (args, ctx) => { const p = person(ctx); agents.register(p.user, args, ctx.ip); return agentView(agents.get(args.handle)); },
      setReviewPreferences: ({ agent, prefs }, ctx) => { const p = person(ctx); agents.setReviewPrefs(p.user, agent, prefs, ctx.ip); return agentView(agents.get(agent)); },
      createPost: (args, ctx) => postView(ctx)(social.create(someone(ctx), args)),
      reply: ({ to, body, media, asAgent }, ctx) => postView(ctx)(social.create(someone(ctx), { parent: to, body, media: media ?? [], asAgent })),
      vote: ({ post, value }, ctx) => postView(ctx)(social.vote(someone(ctx), post, value)),
      createProject: (args, ctx) => projectView(ctx)(projects.create(person(ctx).user, args, ctx.ip)),
      addCollaborator: ({ project: k, agent, username }, ctx) => projectView(ctx)(projects.setCollaborator(person(ctx, { fresh: true }).user, project(k), { agent, username }, ctx.ip)),
      removeCollaborator: ({ project: k, agent, username }, ctx) => projectView(ctx)(projects.setCollaborator(person(ctx, { fresh: true }).user, project(k), { agent, username, remove: true }, ctx.ip)),
      setTaskTracking: ({ project: k, enabled }, ctx) => projectView(ctx)(projects.setTaskTracking(person(ctx).user, project(k), enabled, ctx.ip)),
      createTask: ({ project: k, ...rest }, ctx) => tasks.view(tasks.create(someone(ctx), readableProject(ctx, k), { ...rest, tags: rest.tags ?? [] }), ctx.principal),
      claimTask: ({ id, agent }, ctx) => tasks.view(tasks.claim(someone(ctx), id, { agent }), ctx.principal),
      releaseTask: ({ id }, ctx) => tasks.view(tasks.release(someone(ctx), id), ctx.principal),
      submitReview: ({ id, ...review }, ctx) => tasks.view(tasks.submitReview(someone(ctx), id, review), ctx.principal),
      decideFinding: ({ task, finding, accept }, ctx) => tasks.view(tasks.decideFinding(person(ctx).user, task, finding, accept), ctx.principal),
      closeTask: ({ id, status }, ctx) => tasks.view(tasks.close(person(ctx).user, id, { status: status ?? 'done' }), ctx.principal),
      addSshKey: ({ key, title, agent }, ctx) => { const p = person(ctx, { fresh: true }); return keys.addSsh(p.user, holder(p, agent), { key, title }, ctx.ip); },
      addGpgKey: ({ key, agent }, ctx) => { const p = person(ctx, { fresh: true }); return keys.addGpg(p.user, holder(p, agent), { key }, ctx.ip); },
      removeKey: ({ kind, id }, ctx) => { keys.removeKey(person(ctx, { fresh: true }).user, kind, id, ctx.ip); return true; },
      createConsoleKey: ({ name }, ctx) => {
        const k = keys.createConsoleKey(person(ctx, { fresh: true }).user, { name }, ctx.ip);
        return { token: k.token, note: `${k.name}: it follows the same two-factor checks as a signed-in device.` };
      },
      createAgentKey: ({ agent, purpose }, ctx) => {
        const p = person(ctx, { fresh: true });
        const k = keys.createAgentKey(p.user, agents.mine(p.user, agent), { purpose }, ctx.ip);
        return { token: k.token, note: `Sandbox key for ${k.agent}. Usage is paid from your plan or the agent's budget.` };
      },
      revokeAgentKeys: ({ agent }, ctx) => { const p = person(ctx, { fresh: true }); agents.mine(p.user, agent); keys.revokeAgentKeys(p.user, agent, ctx.ip); return true; },
    },
  };
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    for (const [name, fn] of Object.entries(fields)) type.getFields()[name].resolve = (_root, args, ctx) => fn(args, ctx);
  }

  /** Resolve the caller: bearer token (person or agent key) or the web session (needs the CSRF header). */
  function principalFor(ctx, isMutation) {
    const h = ctx.req.headers.authorization ?? '';
    if (h.startsWith('Bearer ')) {
      const p = s.principals.fromToken(h.slice(7).trim(), ctx.ip);
      if (!p) throw new HttpError(401, 'unauthenticated', 'That token is not valid.');
      return p;
    }
    const cookies = parseCookies(ctx.req.headers.cookie);
    if (!cookies.gitcha_sid) return null;
    if (isMutation && !(cookies.gitcha_csrf && safeEqual(ctx.req.headers['x-gitcha-csrf'] ?? '', cookies.gitcha_csrf))) {
      throw new HttpError(403, 'csrf', 'Send the X-Gitcha-CSRF header with the web session.');
    }
    const a = auth.authenticate(cookies.gitcha_sid, ctx.ip);
    return a ? { kind: 'user', user: a.user, auth: a } : null;
  }

  async function handle(ctx) {
    const body = ctx.req.method === 'GET'
      ? { query: ctx.url.searchParams.get('query'), variables: JSON.parse(ctx.url.searchParams.get('variables') || 'null'), operationName: ctx.url.searchParams.get('operationName') }
      : await readJson(ctx.req, 256 * 1024);
    const query = String(body.query ?? '');
    if (!query || query.length > MAX_QUERY) throw new HttpError(400, 'bad_query', `Send a GraphQL query of at most ${MAX_QUERY} characters.`);
    const { parse } = await import('graphql');
    let doc;
    try { doc = parse(query); } catch (err) { return json(ctx.res, 400, { errors: [{ message: err.message }] }); }
    const isMutation = doc.definitions.some((d) => d.operation === 'mutation');
    if (isMutation && ctx.req.method === 'GET') throw new HttpError(405, 'use_post', 'Mutations must be sent with POST.');
    if (doc.definitions.some((d) => d.selectionSet && depth(d) > MAX_DEPTH)) throw new HttpError(400, 'too_deep', `Queries may nest at most ${MAX_DEPTH} levels.`);
    const principal = principalFor(ctx, isMutation);
    // People must have passed their periodic 2FA check, as everywhere else.
    if (principal?.kind === 'user' && principal.auth) auth.requireMfa(principal.auth);
    const result = await graphql({ schema, source: query, variableValues: body.variables ?? undefined, operationName: body.operationName ?? undefined, contextValue: { principal, ip: ctx.ip } });
    if (result.errors) {
      result.errors = result.errors.map((e) => {
        const orig = e.originalError;
        if (orig instanceof HttpError) return { message: orig.message, path: e.path, extensions: { code: orig.code, status: orig.status, ...orig.extra } };
        if (orig && !(orig instanceof GraphQLError)) { console.error(orig); return { message: 'Internal error.', path: e.path, extensions: { code: 'internal' } }; }
        return { message: e.message, locations: e.locations, path: e.path };
      });
    }
    json(ctx.res, 200, result);
  }

  return { schema, handle, principalKey };
}
