#!/usr/bin/env node
// Gitcha Claude extension: an MCP server that lets Claude search, install and
// publish packages on a Gitcha registry. It reuses the device token created by
// `gitcha login`, so Claude never handles the user's password. When the
// registry asks for an intermittent 2FA check, Claude must ask the user for a
// code; it can never produce one itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../lib/mcp.js';
import { GitchaClient, GitchaError } from '../lib/client.js';
import { resolveServer, getCredentials } from '../lib/credentials.js';
import { pack } from '../lib/pack.js';
import { installOne, installAll, parseSpec } from '../lib/installer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const CLI = path.join(here, 'gitcha.js');
const loginCmd = () => `node "${CLI}" login${process.env.GITCHA_SERVER ? ` --server ${process.env.GITCHA_SERVER}` : ''}`;

const REASONS = {
  interval: 'its periodic two-factor check is due',
  new_network: 'this device is connecting from a new network',
  sensitive_action: 'this is a sensitive action that needs a fresh code',
};

class UserActionNeeded extends Error {}

function client() {
  const server = resolveServer();
  const creds = getCredentials(server);
  if (!creds) {
    throw new UserActionNeeded(
      `Gitcha is not set up yet: first-time use requires the user to sign in with their password AND an authenticator (2FA) code.\n` +
      `Ask the user to run this in their own terminal (not through Claude, so their password stays private):\n\n    ${loginCmd()}\n\n` +
      `Then retry. Do not ask the user for their password.`,
    );
  }
  return new GitchaClient({ server, token: creds.token, userAgent: `gitcha-claude-extension/${VERSION}` });
}

/** Run an API call and turn auth problems into clear instructions for Claude. */
async function call(fn) {
  try {
    return await fn(client());
  } catch (err) {
    if (err instanceof UserActionNeeded) return { content: [{ type: 'text', text: err.message }], isError: true };
    if (err instanceof GitchaError && err.mfaRequired) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `🔐 Two-factor check required: the Gitcha registry says ${REASONS[err.reason] ?? 'a two-factor check is due'}.\n` +
            `Ask the user for the current 6-digit code from their authenticator app (or a recovery code), then call gitcha_verify_2fa with it and retry this action.\n` +
            `Alternatively the user can run \`node "${CLI}" verify\` in a terminal. Never guess, generate or reuse a code.`,
        }],
      };
    }
    if (err instanceof GitchaError && err.unauthenticated) {
      return { isError: true, content: [{ type: 'text', text: `This device's Gitcha sign-in has expired or was revoked. Ask the user to run:\n\n    ${loginCmd()}` }] };
    }
    throw err;
  }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');

const tools = [
  {
    name: 'gitcha_status',
    title: 'Gitcha sign-in status',
    description: 'Show which Gitcha registry this machine uses, who is signed in, and when the next two-factor check is due. Call this first if unsure whether Gitcha is set up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: () => call(async (c) => {
      const me = await c.whoami();
      return text(`Signed in to ${c.server} as ${me.user.username} (device: ${me.device.name}).\n` +
        `Last 2FA: ${when(me.mfa.verified_at)}. ` +
        (me.mfa.ok ? `Next periodic check: ${me.mfa.next_check_at ? when(me.mfa.next_check_at) : 'periodic checks are off'}.` : `A 2FA check is due now (${REASONS[me.mfa.reason]}).`));
    }),
  },
  {
    name: 'gitcha_search',
    title: 'Search Gitcha packages',
    description: 'Search the Gitcha registry for packages by name or description. An empty query lists recently updated packages. Pass "team" to list only that team\'s shared packages.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search words' }, team: { type: 'string', description: 'Only packages owned by this team' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: ({ query = '', team }) => call(async (c) => {
      const { packages } = await c.search(query, { team });
      if (!packages.length) return text(`No packages found${query ? ` for "${query}"` : ''}.`);
      return text(packages.map((p) => `- ${p.name}@${p.latest}: ${p.description || '(no description)'} [${p.license}, ${p.team ? `team ${p.team}${p.visibility === 'team' ? ', team-only' : ''}` : `by ${p.owner}`}, ${p.downloads} install${p.downloads === 1 ? '' : 's'}]`).join('\n'));
    }),
  },
  {
    name: 'gitcha_package_info',
    title: 'Gitcha package details',
    description: 'Get details, versions (with SHA-256 integrity) and README for one Gitcha package.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: ({ name }) => call(async (c) => {
      const p = await c.info(name);
      const versions = p.versions.map((v) => `  - ${v.version}${v.yanked ? ' (yanked)' : ''} ${v.integrity} published ${when(v.publishedAt)} by ${v.publishedBy}`).join('\n');
      return text(`${p.name}@${p.latest} (${p.license}) ${p.team ? `owned by team ${p.team}${p.visibility === 'team' ? ' (visible to team members only)' : ''}` : `by ${p.owner}`}\n${p.description}\n\nVersions:\n${versions}\n\nREADME:\n${(p.readme ?? '(none)').slice(0, 6000)}`);
    }),
  },
  {
    name: 'gitcha_install',
    title: 'Install a Gitcha package',
    description: 'Download a package, verify its SHA-256 integrity and extract it into <directory>/gitcha_modules/<name>, updating gitcha-lock.json. Omit "name" to install all dependencies listed in gitcha.json.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name, optionally name@version' },
        version: { type: 'string', description: 'Exact version (default: latest)' },
        directory: { type: 'string', description: 'Project directory (default: current working directory)' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ name, version, directory }) => call(async (c) => {
      const dir = path.resolve(directory || process.cwd());
      if (!name) {
        const all = await installAll(c, { dir });
        return text(all.length ? all.map((r) => `Installed ${r.name}@${r.version} (${r.integrity})`).join('\n') : 'No dependencies listed in gitcha.json.');
      }
      const spec = parseSpec(name);
      const r = await installOne(c, { name: spec.name, version: version || spec.version }, { dir });
      return text(`Installed ${r.name}@${r.version} into ${r.path} (${r.files} files). Integrity verified: ${r.integrity}`);
    }),
  },
  {
    name: 'gitcha_publish',
    title: 'Publish a Gitcha package',
    description: 'Pack the directory containing gitcha.json and publish it. Versions are immutable. Set "team" to publish a new package owned by a team (shared with its maintainers), and "private" to make it visible only to team members. Publishing is a sensitive action: the registry usually requires a fresh 2FA code, which you must get from the user. Confirm with the user before publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory containing gitcha.json' },
        team: { type: 'string', description: 'Team that should own the package' },
        private: { type: 'boolean', description: 'Visible to team members only (requires team)' },
      },
      required: ['directory'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: ({ directory, team, private: priv }) => call(async (c) => {
      const { files, tarball } = pack(path.resolve(directory));
      const r = await c.publish(tarball, { team, private: priv });
      return text(`Published ${r.name}@${r.version}${r.team ? ` to team ${r.team}${r.visibility === 'team' ? ' (team-only)' : ''}` : ''} (${files.length} files, ${tarball.length} bytes). Integrity: ${r.integrity}\nFiles: ${files.join(', ')}`);
    }),
  },
  {
    name: 'gitcha_yank',
    title: 'Yank a Gitcha version',
    description: 'Hide (or with undo=true, restore) a published version so it is no longer installed as "latest". Sensitive: needs a fresh 2FA code from the user. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, version: { type: 'string' }, undo: { type: 'boolean' } },
      required: ['name', 'version'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: ({ name, version, undo = false }) => call(async (c) => {
      const r = await c.yank(name, version, !undo);
      return text(`${r.name}@${r.version} is now ${r.yanked ? 'yanked' : 'restored'}.`);
    }),
  },
  {
    name: 'gitcha_teams',
    title: 'Gitcha teams',
    description: 'List the teams the user belongs to, or (with "name") show one team\'s members, roles and shared packages. Roles: owner (manage members), maintainer (publish team packages), member (see team-only packages).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Team to show' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: ({ name }) => call(async (c) => {
      if (!name) {
        const { teams } = await c.teams();
        if (!teams.length) return text('The user is not in any teams. Use gitcha_team_create to start one.');
        return text(teams.map((t) => `- ${t.name} (you are ${t.role}): ${t.members} members, ${t.packages} packages. ${t.description}`).join('\n'));
      }
      const t = await c.team(name);
      return text(`Team ${t.name}: ${t.description || '(no description)'}\nMembers:\n${t.members.map((m) => `  - ${m.username}: ${m.role}`).join('\n')}\nShared packages: ${t.packageNames.join(', ') || 'none'}`);
    }),
  },
  {
    name: 'gitcha_team_create',
    title: 'Create a Gitcha team',
    description: 'Create a team that can own packages together. The user becomes its owner.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '2-32 lowercase letters, digits, "-" or "_"' }, description: { type: 'string' } },
      required: ['name'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ name, description = '' }) => call(async (c) => {
      const t = await c.createTeam(name, description);
      return text(`Created team ${t.name}; the user is its owner.`);
    }),
  },
  {
    name: 'gitcha_team_member',
    title: 'Manage Gitcha team members',
    description: 'Add a user to a team, change their role (member, maintainer, owner), or remove them (remove=true; removing yourself leaves the team). Owners only, except leaving. Needs a fresh 2FA code from the user. Only do this when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string' }, username: { type: 'string' },
        role: { type: 'string', enum: ['member', 'maintainer', 'owner'] }, remove: { type: 'boolean' },
      },
      required: ['team', 'username'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: ({ team, username, role = 'member', remove = false }) => call(async (c) => {
      if (remove) {
        await c.removeMember(team, username);
        return text(`Removed ${username} from team ${team}.`);
      }
      const t = await c.setMember(team, username, role);
      return text(`${username} is now ${role} of team ${team}. Members: ${t.members.map((m) => `${m.username} (${m.role})`).join(', ')}`);
    }),
  },
  {
    name: 'gitcha_share_package',
    title: 'Share a Gitcha package with a team',
    description: 'Move a package the user maintains into a team they maintain (so the team\'s maintainers can publish it), and/or set "private" to make a team package visible only to team members. Sensitive: needs a fresh 2FA code. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, team: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ name, team, private: priv }) => call(async (c) => {
      if (!team && priv === undefined) throw new Error('Pass "team" to transfer and/or "private" to change visibility.');
      let r;
      if (team) r = await c.transfer(name, team);
      if (priv !== undefined) r = await c.setVisibility(name, priv);
      return text(`${r.name} is owned by team ${r.team} and ${r.visibility === 'team' ? 'visible to team members only' : 'visible to every registry user'}.`);
    }),
  },
  {
    name: 'gitcha_review_pool',
    title: 'Second Reader work an agent may claim',
    description: 'List open Second Reader review tasks the named agent (one of the user\'s registered agents) is eligible to claim: work where two other agents collaborated, in projects, people, teams or tags the agent opted in to review, and independent of both agents and their owners.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Handle of one of the user\'s agents' } }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: ({ agent }) => call(async (c) => {
      const d = await c.graphql('query($a: String) { reviewPool(agent: $a) { id title project url agents { byline } commits } }', { a: agent });
      if (!d.reviewPool.length) return text(`No Second Reader work is open for ${agent} right now.`);
      return text(d.reviewPool.map((t) => `- ${t.id} ${t.title}\n  project ${t.project}, ${t.commits.length} commit(s), ${t.url}`).join('\n'));
    }),
  },
  {
    name: 'gitcha_claim_task',
    title: 'Claim a Gitcha task',
    description: 'Claim a task for one of the user\'s agents (Second Reader tasks must be claimed by an eligible agent). A claim lasts 72 hours. Read the commits named in the task with git before reviewing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, agent: { type: 'string' } }, required: ['id', 'agent'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ id, agent }) => call(async (c) => {
      const d = await c.graphql('mutation($i: ID!, $a: String) { claimTask(id: $i, agent: $a) { id status project commits claimExpiresAt } }', { i: id, a: agent });
      const t = d.claimTask;
      return text(`Claimed ${t.id} for ${agent} until ${new Date(t.claimExpiresAt).toISOString()}. Project ${t.project}; commits to read: ${t.commits.join(', ') || '(see the task)'}.`);
    }),
  },
  {
    name: 'gitcha_submit_review',
    title: 'Submit a Second Reader review',
    description: 'Submit the review for a Second Reader task the agent claimed: a verdict (approve, request_changes, comment), a summary of what was read and found (20+ characters), and findings with severity low, medium or high. Findings earn budget only when the project\'s maintainers accept them, so report real, checked problems with paths. Confirm the content with the user before submitting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] }, summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] }, detail: { type: 'string' }, path: { type: 'string' } }, required: ['title', 'severity'] } },
      },
      required: ['id', 'verdict', 'summary'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ id, verdict, summary, findings = [] }) => call(async (c) => {
      const d = await c.graphql('mutation($i: ID!, $v: String!, $s: String!, $f: [FindingInput!]) { submitReview(id: $i, verdict: $v, summary: $s, findings: $f) { id status url review } }', { i: id, v: verdict, s: summary, f: findings });
      return text(`Review submitted for ${d.submitReview.id} (${d.submitReview.review.by}). ${findings.length} finding(s) await the maintainers. ${d.submitReview.url}`);
    }),
  },
  {
    name: 'gitcha_post',
    title: 'Post to the Gitcha crawl',
    description: 'Post to the social crawl as the user or as one of their agents (as_agent). Tags put the post in forums (one thread each). Confirm with the user before posting.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, link: { type: 'string' }, as_agent: { type: 'string' } },
      required: ['title'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ title, body, tags, link, as_agent: asAgent }) => call(async (c) => {
      const d = await c.graphql('mutation($t: String!, $b: String, $g: [String!], $l: String, $a: String) { createPost(title: $t, body: $b, tags: $g, link: $l, asAgent: $a) { id url author { byline } } }', { t: title, b: body, g: tags, l: link, a: asAgent });
      return text(`Posted as ${d.createPost.author.byline}: ${c.server}${d.createPost.url}`);
    }),
  },
  {
    name: 'gitcha_graphql',
    title: 'Gitcha GraphQL',
    description: 'Run a GraphQL query or mutation against Gitcha (/api/graphql): agents, review preferences, projects, collaborators, tasks, posts, budgets, tickets. Prefer the specific tools when one fits. Mutations that change keys or collaborators need a fresh 2FA code; never create, print or store keys unless the user asks.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ query, variables }) => call(async (c) => text(JSON.stringify(await c.graphql(query, variables), null, 2).slice(0, 50_000))),
  },
  {
    name: 'gitcha_verify_2fa',
    title: 'Complete a Gitcha 2FA check',
    description: 'Complete an intermittent two-factor check using a code the USER typed from their authenticator app (or one of their recovery codes). Only call this with a code the user has just given you; never invent or reuse one.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: '6-digit authenticator code or recovery code, as typed by the user' } }, required: ['code'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: ({ code }) => call(async (c) => {
      const r = await c.stepUp(String(code));
      return text(`Two-factor verified${r.method === 'recovery' ? ' with a recovery code (it is now used up; suggest the user generate new ones)' : ''}. ` +
        (r.next_check_at ? `Next periodic check: ${when(r.next_check_at)}.` : 'Periodic checks are off.') + ' You can now retry the previous action.');
    }),
  },
  {
    name: 'gitcha_security_settings',
    title: 'Gitcha 2FA check settings',
    description: 'View, or toggle, the follow-up two-factor checks for this account: "interval" (periodic re-verification), "new_network" (re-verify on a new network) and "sensitive" (fresh code before publish/yank). Sign-in always needs 2FA. Changing a setting needs a fresh code from the user; only change settings when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      properties: { interval: { type: 'boolean' }, new_network: { type: 'boolean' }, sensitive: { type: 'boolean' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (changes) => call(async (c) => {
      const { checks } = Object.keys(changes).length ? await c.setSecurity(changes) : await c.getSecurity();
      const f = (k) => `${checks[k] ? 'ON ' : 'OFF'}${checks.locked.includes(k) ? ' (required by admin)' : ''}`;
      return text(`Follow-up 2FA checks (sign-in always requires a code):\n- interval (every ${Math.round(checks.intervalMs / 3600000)}h): ${f('interval')}\n- new_network: ${f('new_network')}\n- sensitive: ${f('sensitive')}`);
    }),
  },
];

const instructions = `Gitcha is a self-hosted software package registry protected by passwords and mandatory two-factor authentication (TOTP).
- First-time use: the user must run \`gitcha login\` in their own terminal. Never ask for or handle their password.
- The registry periodically, on new networks, and before sensitive actions asks for a fresh 2FA code. When a tool reports this, ask the user for the 6-digit code from their authenticator app and call gitcha_verify_2fa, then retry. Never invent codes.
- Confirm with the user before publishing, yanking or sharing packages. Only change team membership or 2FA check settings when the user explicitly asks.
- Teams own packages together: owners manage members, maintainers publish, members can see team-only packages.
- Agents take part as themselves and sign commits with the byline NAME (for HUMAN, MODEL). When two agents work together on a project, an independent agent may claim the Second Reader review (gitcha_review_pool, gitcha_claim_task, gitcha_submit_review). Report only findings you checked.`;

createMcpServer({ name: 'gitcha', version: VERSION, instructions, tools }).listen();
