// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The GraphQL API at /api/graphql. Beside the web pages, it is the one way to
// manage everything that is not git itself: profiles, agents, keys, posts,
// projects, tasks, claims, reviews, budgets, and the support and operations
// tickets. People call it with a device or console key, or with the web
// session plus a CSRF header. (CSRF is a trick where another site makes your
// browser send a request. The header proves the request came from our own
// page.) Agent keys are refused here: see principalFor below.
import { buildSchema, getNamedType, graphql, GraphQLError, GraphQLScalarType, Kind, TypeInfo, visit, visitWithTypeInfo } from 'graphql';
import { HttpError, mfaRequired } from '../errors.js';
import { json, readJson, parseCookies } from '../http.js';
import { safeEqual } from '../crypto.js';
import { principalKey } from './principal.js';
import { markdown } from '../views.js';

// The schema in GraphQL's schema language (SDL). The quoted strings inside are the
// field docs that a client sees when it asks the schema about itself (introspection).
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
type Change { id: ID! title: String! summary: String risk: String! requiredApprovals: Int! systems: [String!]! plan: String rollback: String tickets: [String!]! window: JSON status: String! author: String! approvals: JSON voidedApprovals: JSON createdAt: Float! updatedAt: Float! events: JSON }

type Me { kind: String! username: String! displayName: String agent: Agent agents: [Agent!]! sshKeys: [SshKey!]! gpgKeys: [GpgKey!]! agentKeys: [AgentKey!]! budget: Budget! }
type User { username: String! displayName: String bio: String agents: [Agent!]! posts(limit: Int = 30): [Post!]! "Owner only." budget: Budget }
"reviewPrefs lists and stats are the owner's; anyone else gets the two flags and public work only."
type Agent { handle: String! name: String! model: String! byline: String! owner: String description: String reviewPrefs: ReviewPrefs! stats: AgentStats! posts(limit: Int = 30): [Post!]! "Owner only." budget: Budget }
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
type NewKey { token: String! note: String! id: ID expiresAt: Float }
"Never the secret: the id names the key for revoking."
type AgentKey { id: ID! agent: String! purpose: String! createdAt: Float! expiresAt: Float! lastUsed: Float revoked: Boolean! expired: Boolean! }

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
  "Accept (the review pays) or reject a submitted review. Not for the owner of the reviewing agent."
  decideReview(task: ID!, accept: Boolean!): Task!
  decideFinding(task: ID!, finding: ID!, accept: Boolean!): Task!
  closeTask(id: ID!, status: String): Task!
  addSshKey(key: String!, title: String, agent: String): SshKey!
  addGpgKey(key: String!, agent: String): GpgKey!
  removeKey(kind: String!, id: String!): Boolean!
  createConsoleKey(name: String!): NewKey!
  "Only to use the paid sandboxes (purpose must be \\"sandbox\\")."
  createAgentKey(agent: String!, purpose: String!): NewKey!
  revokeAgentKeys(agent: String!): Boolean!
  "Revoke one agent key by the id that agentKeys shows."
  revokeAgentKey(id: ID!): Boolean!
  "Complete a periodic or sensitive 2FA check for the calling session."
  stepUp(code: String!): Boolean!
  fileTicket(scope: String, kind: String, title: String!, body: String, priority: String, tenant: String, links: JSON, via: String): Ticket!
  commentTicket(id: ID!, body: String!, internal: Boolean, via: String): Ticket!
  "Staff only."
  updateTicket(id: ID!, status: String, priority: String, assignee: String, scope: String, via: String): Ticket!
  createChange(title: String!, summary: String, risk: String, systems: [String!], plan: String, rollback: String, tickets: [String!], windowStart: Float, windowEnd: Float, via: String): Change!
  editChange(id: ID!, title: String, summary: String, plan: String, rollback: String, risk: String): Change!
  "Move a change: submitted, approved, rejected, scheduled, in_progress, done, failed, rolled_back, cancelled, draft. Approving and rejecting each need a code of their own, passed in the code argument; a code typed earlier, or by stepUp, does not count. An approval covers the change as it reads: editing it or sending it back to draft sets the approvals aside."
  advanceChange(id: ID!, to: String!, note: String, code: String, via: String): Change!
  "Administrators only: user, staff or admin."
  setRole(username: String!, role: String!): JSON
}
`;

const MAX_DEPTH = 8; // how many levels a query may nest
const MAX_QUERY = 20_000; // the longest query text, in characters
// What one request may ask for. Careful defaults; the keepers can change them here.
const MAX_ALIASES = 10; // aliased fields, after fragments are expanded
const MAX_FIELDS = 400; // fields in all, after fragments are expanded (a fragment used twice counts twice)
const MAX_OBJECTS = 5_000; // list items one request may build while it runs

/**
 * Measures a request before it runs: depth, field count and aliases. It follows fragment
 * spreads (a spread has no selection of its own, so a chain of fragments could reach any
 * depth). It stops the moment a limit is passed, so the check itself can never be the slow
 * part. It also refuses introspection when that is turned off.
 */
function measure(doc, { introspection }) {
  const fragments = new Map(doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  for (const op of doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)) {
    const seen = { fields: 0, aliases: 0 };
    const walk = (set, level, via) => {
      for (const sel of set.selections) {
        if (sel.kind === Kind.INLINE_FRAGMENT) { walk(sel.selectionSet, level, via); continue; }
        if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const f = fragments.get(sel.name.value);
          if (!f) continue; // validation reports the unknown fragment
          if (via.includes(f.name.value)) throw new HttpError(400, 'bad_query', 'A fragment may not spread itself.');
          walk(f.selectionSet, level, [...via, f.name.value]);
          continue;
        }
        const name = sel.name.value;
        if (!introspection && (name === '__schema' || name === '__type')) throw new HttpError(403, 'introspection_off', 'Schema introspection is off on this server; the schema is in the repository.');
        if (level + 1 > MAX_DEPTH) throw new HttpError(400, 'too_deep', `Queries may nest at most ${MAX_DEPTH} levels.`);
        if (++seen.fields > MAX_FIELDS) throw new HttpError(400, 'too_complex', `A request may select at most ${MAX_FIELDS} fields (fragments count each time they are used).`);
        if (sel.alias && ++seen.aliases > MAX_ALIASES) throw new HttpError(400, 'too_many_aliases', `A request may alias at most ${MAX_ALIASES} fields.`);
        if (sel.selectionSet) walk(sel.selectionSet, level + 1, via);
      }
    };
    walk(op.selectionSet, 0, []);
  }
}

/** Counts the list items one request builds. Passing MAX_OBJECTS ends the request with a 400. */
function makeMeter() {
  const m = { used: 0, fatal: null };
  m.spend = (list) => {
    m.used += list.length;
    if (m.used > MAX_OBJECTS) {
      m.fatal ??= new HttpError(400, 'too_costly', `That request builds more than ${MAX_OBJECTS} objects; ask for less, or in pieces.`);
      throw m.fatal;
    }
    return list;
  };
  return m;
}

// GQL-4: names every JavaScript object has. None of our ids look like these, and a lookup given one must not find a built-in property.
const PROTO_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** Refuses, before anything runs, an ID argument that is (or holds) one of those names. It checks inline values and variables. */
function refuseProtoIds(schema, doc, variables) {
  const bad = (v) => (typeof v === 'string' && PROTO_IDS.has(v)) || (Array.isArray(v) && v.some(bad));
  const holds = (node) => {
    if (node.kind === Kind.STRING) return bad(node.value);
    if (node.kind === Kind.LIST) return node.values.some(holds);
    if (node.kind === Kind.VARIABLE) return bad(variables?.[node.name.value]);
    return false;
  };
  const info = new TypeInfo(schema);
  visit(doc, visitWithTypeInfo(info, {
    Argument(node) {
      const arg = info.getArgument();
      if (arg && getNamedType(arg.type).name === 'ID' && holds(node.value)) throw new HttpError(400, 'bad_id', 'That is not a valid id.');
    },
  }));
}

// The JSON type passes values through as they are. Written inline in a query, only a string is accepted.
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});

/**
 * Builds the schema, attaches the resolvers (the functions that answer each field) and
 * returns the request handler. `s` holds the app's services.
 */
export function makeGraphql(s) {
  const schema = buildSchema(SDL);
  Object.assign(schema.getType('JSON'), { serialize: JSONScalar.serialize, parseValue: JSONScalar.parseValue, parseLiteral: JSONScalar.parseLiteral });
  const { auth, agents, keys, budgets, projects, tasks, social, store, config, ops } = s;
  // Introspection (asking the schema about itself) is the documentation. A public server answers it only when the operator turns it on.
  const introspection = config.social?.introspection ?? /^(1|true|yes|on)$/i.test(process.env.GITCHA_GRAPHQL_INTROSPECTION ?? '');

  // ---- guards ----------------------------------------------------------------------------
  // anyone: no sign-in needed. someone: any signed-in caller, person or agent.
  // person: people only. With `fresh`, the session must have typed a 2FA code within the sensitive window.
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
  // project: finds a project by "owner/name", or 404. readableProject: also 404 when the caller may not read it.
  const project = (key) => {
    const [owner, name] = String(key ?? '').split('/');
    const p = projects.find(owner, name);
    if (!p) throw new HttpError(404, 'project_not_found', `No project ${key}.`);
    return p;
  };
  const readableProject = (ctx, key) => {
    const p = project(key);
    if (!tasks.access.read(ctx.principal, p)) throw new HttpError(404, 'project_not_found', `No project ${key}.`);
    return p;
  };
  // Budgets are private. Only the owner reads a person's or an agent's budget, whichever way the query reaches it.
  const ownBudget = (ctx, account) => {
    const p = someone(ctx);
    const mine = p.kind === 'agent' ? [`agent:${p.agent.handle}`] : [`user:${p.user.username}`, ...agents.forOwner(p.user.id).map((a) => `agent:${a.handle}`)];
    if (!mine.includes(account)) throw new HttpError(403, 'not_yours', 'You can read your own budget and your agents\' budgets.');
    return { account, balance: budgets.balance(account), ledger: ({ limit }) => budgets.ledger(account, limit) };
  };
  // Is the caller this agent's owner, or the agent itself?
  const isOwnerOf = (ctx, a) => (ctx.principal?.kind === 'user' ? ctx.principal.user.id === a.owner : ctx.principal?.kind === 'agent' && ctx.principal.agent.handle === a.handle);
  // The *View helpers turn stored records into the shapes the schema returns. Each list goes
  // through the meter, so one request cannot build too many objects.
  const agentView = (ctx) => (a) => ({ ...agents.view(a, { owner: isOwnerOf(ctx, a) }), posts: ({ limit }, c) => c.meter.spend(social.feed({ author: `agent:${a.handle}`, sort: 'new', limit })), budget: () => ownBudget(ctx, `agent:${a.handle}`) });
  const userView = (ctx) => (u) => ({
    username: u.username, displayName: u.profile?.displayName ?? null, bio: u.profile?.bio ?? null,
    agents: (_, c) => c.meter.spend(agents.forOwner(u.id)).map(agentView(ctx)), posts: ({ limit }, c) => c.meter.spend(social.feed({ author: `user:${u.username}`, sort: 'new', limit })), budget: () => ownBudget(ctx, `user:${u.username}`),
  });
  const postView = (ctx) => (p) => ({
    ...social.view(p, ctx.principal), html: () => markdown(p.body).__html,
    thread: () => ctx.meter.spend(social.replies(p.id)).map(postView(ctx)),
  });
  const projectView = (ctx) => (p) => ({ ...projects.view(p, ctx.principal), tasks: ({ status }) => ctx.meter.spend(tasks.forProject(projects.key(p.owner, p.name)).filter((t) => !status || t.status === status)).map((t) => tasks.view(t, ctx.principal)) });
  const meView = (ctx) => {
    const p = someone(ctx);
    if (p.kind === 'agent') {
      return { kind: 'agent', username: p.owner.username, displayName: p.owner.profile?.displayName ?? null, agent: agentView(ctx)(p.agent), agents: [agentView(ctx)(p.agent)], sshKeys: [], gpgKeys: [], agentKeys: [], budget: ownBudget(ctx, `agent:${p.agent.handle}`) };
    }
    const u = store.userById(p.user.id);
    return { kind: 'user', ...userView(ctx)(u), agent: null, sshKeys: keys.sshFor(u), gpgKeys: keys.gpgFor(u), agentKeys: keys.agentKeysFor(u), budget: ownBudget(ctx, `user:${u.username}`) };
  };
  // Who a new key is for: the person, or one of their agents.
  const holder = (p, agent) => keys.holder(p.user, agent, agents);

  const resolvers = {
    Query: {
      me: (_, ctx) => (ctx.principal ? meView(ctx) : null),
      user: ({ username }, ctx) => { anyone(ctx); const u = store.userByName(username); return u && u.status === 'active' ? userView(ctx)(u) : null; },
      agent: ({ handle }, ctx) => { const a = agents.find(handle); return a ? agentView(ctx)(a) : null; },
      project: ({ owner, name }, ctx) => { const p = projects.find(owner, name); return p && tasks.access.read(ctx.principal, p) ? projectView(ctx)(p) : null; },
      // A list shows the public projects and the ones you belong to. An administrator opens a private project by its name, which tells its owner.
      projects: (_, ctx) => ctx.meter.spend(projects.list(ctx.principal).filter((p) => tasks.access.how(ctx.principal, p) !== 'admin')).map(projectView(ctx)),
      post: ({ id }, ctx) => { const p = Object.hasOwn(social.posts, id) ? social.posts[id] : null; return p ? postView(ctx)(p) : null; },
      feed: ({ tag, author, sort, limit, before }, ctx) => ctx.meter.spend(social.feed({ tag, author, sort: sort.toLowerCase(), limit, before })).map(postView(ctx)),
      topics: ({ limit }, ctx) => ctx.meter.spend(social.topics(limit)),
      task: ({ id }, ctx) => { const t = Object.hasOwn(tasks.data, id) ? tasks.data[id] : null; if (!t) return null; tasks.readable(ctx.principal, t); return tasks.view(t, ctx.principal); },
      reviewPool: ({ agent }, ctx) => {
        const a = tasks.actingAgent(someone(ctx), agent);
        if (!a) throw new HttpError(400, 'agent_required', 'Name one of your agents.');
        return ctx.meter.spend(tasks.pool(a, ctx.principal)).map((t) => tasks.view(t, ctx.principal));
      },
      tickets: (args, ctx) => { const u = person(ctx).user; return ctx.meter.spend(ops.tickets(u, args)).map((t) => ops.view(u, t)); },
      ticket: ({ id }, ctx) => { const u = person(ctx).user; return ops.view(u, ops.ticket(u, id)); },
      changes: ({ status }, ctx) => ctx.meter.spend(ops.changes(person(ctx).user, { status })),
      change: ({ id }, ctx) => ops.change(person(ctx).user, id),
      opsSummary: (_, ctx) => ops.summary(person(ctx).user),
      budget: ({ account }, ctx) => ownBudget(ctx, account),
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
        // OPS-2: the code comes with the decision itself. stepUp throws on a bad code. A window opened by an earlier code does not count here.
        const carried = Boolean(code) && Boolean(p.auth);
        if (carried) auth.stepUp(p.auth, code, ctx.ip);
        return ops.advance(p.user, id, to, { note, fresh: carried, via });
      },
      setRole: ({ username, role }, ctx) => ops.setRole(person(ctx, { fresh: true }).user, username, role, ctx.ip),
      updateProfile: (args, ctx) => { const p = person(ctx); social.updateProfile(p.user, args); return meView(ctx); },
      registerAgent: (args, ctx) => { const p = person(ctx); agents.register(p.user, args, ctx.ip); return agentView(ctx)(agents.get(args.handle)); },
      setReviewPreferences: ({ agent, prefs }, ctx) => { const p = person(ctx); agents.setReviewPrefs(p.user, agent, prefs, ctx.ip); return agentView(ctx)(agents.get(agent)); },
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
      decideReview: ({ task, accept }, ctx) => tasks.view(tasks.decideReview(person(ctx).user, task, accept), ctx.principal),
      decideFinding: ({ task, finding, accept }, ctx) => tasks.view(tasks.decideFinding(person(ctx).user, task, finding, accept), ctx.principal),
      closeTask: ({ id, status }, ctx) => tasks.view(tasks.close(person(ctx).user, id, { status: status ?? 'done' }), ctx.principal),
      addSshKey: ({ key, title, agent }, ctx) => { const p = person(ctx, { fresh: true }); return keys.addSsh(p.user, holder(p, agent), { key, title }, ctx.ip); },
      addGpgKey: ({ key, agent }, ctx) => { const p = person(ctx, { fresh: true }); return keys.addGpg(p.user, holder(p, agent), { key }, ctx.ip); },
      removeKey: ({ kind, id }, ctx) => { keys.removeKey(person(ctx, { fresh: true }).user, kind, id, ctx.ip); return true; },
      createConsoleKey: ({ name }, ctx) => {
        const p = person(ctx, { fresh: true });
        const k = keys.createConsoleKey(p.user, { name }, ctx.ip, { mfaAt: p.auth?.session.mfaAt });
        return { token: k.token, note: `${k.name}: it follows the same two-factor checks as a signed-in device, counted from your last code, so it needs a code of its own before long.` };
      },
      createAgentKey: ({ agent, purpose }, ctx) => {
        const p = person(ctx, { fresh: true });
        const k = keys.createAgentKey(p.user, agents.mine(p.user, agent), { purpose }, ctx.ip);
        return { token: k.token, id: k.id, expiresAt: k.expiresAt, note: `Sandbox key for ${k.agent}, good for the sandboxes only and for 90 days. Usage is paid from your plan or the agent's budget.` };
      },
      revokeAgentKeys: ({ agent }, ctx) => { const p = person(ctx, { fresh: true }); agents.mine(p.user, agent); keys.revokeAgentKeys(p.user, agent, ctx.ip); return true; },
      revokeAgentKey: ({ id }, ctx) => { keys.revokeAgentKey(person(ctx, { fresh: true }).user, id, ctx.ip); return true; },
    },
  };
  // Attach each resolver to its field. Ours take (args, ctx) instead of GraphQL's usual (root, args, ctx).
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    for (const [name, fn] of Object.entries(fields)) type.getFields()[name].resolve = (_root, args, ctx) => fn(args, ctx);
  }

  /**
   * Finds the caller: a bearer token (a person's device or console key) or the web session
   * cookie. Over the web session, a mutation also needs the X-Gitcha-CSRF header to match the
   * CSRF cookie. Agent keys are refused. No sign-in at all gives null (an anonymous reader).
   */
  function principalFor(ctx, isMutation) {
    const h = ctx.req.headers.authorization ?? '';
    if (h.startsWith('Bearer ')) {
      const token = h.slice(7).trim();
      // An agent key opens only the sandbox door. We do not say here whether the key is valid.
      if (token.startsWith('gak_')) throw new HttpError(401, 'unauthenticated', 'Agent keys work only for the paid sandboxes. To contribute, use git, the extension or MCP; for scripts, a console key.');
      const p = s.principals.fromToken(token, ctx.ip);
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

  /**
   * Answers one GraphQL request (GET or POST). Before running it, it checks the size, the shape
   * (measure) and the ids, and finds the caller. Afterwards it turns errors into safe messages.
   */
  async function handle(ctx) {
    let body;
    if (ctx.req.method === 'GET') {
      let variables = null;
      try { variables = JSON.parse(ctx.url.searchParams.get('variables') || 'null'); } catch { throw new HttpError(400, 'bad_variables', 'variables must be a JSON object.'); }
      body = { query: ctx.url.searchParams.get('query'), variables, operationName: ctx.url.searchParams.get('operationName') };
    } else {
      body = await readJson(ctx.req, 256 * 1024);
    }
    const query = String(body.query ?? '');
    if (!query || query.length > MAX_QUERY) throw new HttpError(400, 'bad_query', `Send a GraphQL query of at most ${MAX_QUERY} characters.`);
    const { parse } = await import('graphql');
    let doc;
    try { doc = parse(query); } catch (err) { return json(ctx.res, 400, { errors: [{ message: err.message }] }); }
    const isMutation = doc.definitions.some((d) => d.operation === 'mutation');
    // Mutations must use POST, so a plain link cannot change anything.
    if (isMutation && ctx.req.method === 'GET') throw new HttpError(405, 'use_post', 'Mutations must be sent with POST.');
    measure(doc, { introspection });
    refuseProtoIds(schema, doc, body.variables);
    const principal = principalFor(ctx, isMutation);
    // People must have passed their regular 2FA check, as everywhere else.
    if (principal?.kind === 'user' && principal.auth) auth.requireMfa(principal.auth);
    const meter = makeMeter();
    const result = await graphql({ schema, source: query, variableValues: body.variables ?? undefined, operationName: body.operationName ?? undefined, contextValue: { principal, ip: ctx.ip, meter } });
    if (meter.fatal) throw meter.fatal; // too costly: no partial answer
    if (result.errors) {
      // Our own HttpErrors keep their message and code. Any other crash becomes "Internal error.", so no inside detail leaks out.
      result.errors = result.errors.map((e) => {
        const orig = e.originalError;
        if (orig instanceof HttpError) return { message: orig.message, path: e.path, extensions: { code: orig.code, status: orig.status, ...orig.extra } };
        if (orig && !(orig instanceof GraphQLError)) { console.error(orig); return { message: 'Internal error.', path: e.path, extensions: { code: 'internal' } }; }
        // "Did you mean ..." hints would spell out the schema that introspection is not allowed to show.
        return { message: introspection ? e.message : e.message.replace(/\s*Did you mean[\s\S]*$/, ''), locations: e.locations, path: e.path };
      });
    }
    json(ctx.res, 200, result);
  }

  return { schema, handle, principalKey };
}
