// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The hub: the sandbox side of Omni, one stdio MCP server for Claude Code or Claude Desktop. It connects to every
// member in the roster (remote MCP servers behind a gateway you run), offers their tools as its own (a name two
// members both claim stays with the first, as vibrobeast's hub does, and omni_status says so), and adds a few of
// its own: omni_status (what it reached and what it did not), omni_reach (a receipt line for a hand-back), and
// skill_list / skill_read over the skills roots you give it (checkouts of vibrobeast-skills or jarvis), so a
// written way of working is readable where no plugin menu carries it.
//
// The hub holds no token on disk: each member's token is read from the environment at call time, which in a cloud
// session is an environment secret. What a member answers is other people's text; the hub labels it as such.
import { createMcpServer, untrusted } from './mcp.js';
import { Remote, readRoster } from './remote.js';
import { listSkills, readSkill } from './skills.js';

export const VERSION = '0.2.0';

/**
 * buildHub({rosterText, skillsRoots, env, fetchFn, io}): connects the members and returns {server, members, own}.
 * `server` is the MCP server (handle + listen); nothing is written to disk here.
 */
export async function buildHub({ rosterText = '{"members":{}}', skillsRoots = [], env = process.env, fetchFn, readFile, io = {}, input, output } = {}) {
  const roster = readRoster(rosterText);
  const members = Object.entries(roster).map(([name, spec]) => new Remote(name, spec, { fetchFn, env, readFile }));
  await Promise.all(members.map((m) => m.connect()));

  const tools = [];
  const owner = new Map();
  const clashes = [];
  for (const m of members) {
    for (const t of m.tools) {
      if (owner.has(t.name)) { clashes.push(`${t.name}: ${owner.get(t.name)} keeps it, ${m.name} also offered it`); continue; }
      owner.set(t.name, m.name);
      tools.push({
        name: t.name, title: t.title, description: `[${m.name}] ${t.description ?? ''}`.trim(), inputSchema: t.inputSchema ?? { type: 'object' }, annotations: t.annotations,
        handler: async (args) => {
          const r = await m.call(t.name, args);
          // The member's answer comes back whole: content blocks and isError as it gave them.
          if (r && typeof r === 'object' && Array.isArray(r.content)) return r;
          return typeof r === 'string' ? r : JSON.stringify(r);
        },
      });
    }
  }

  const status = () => ({
    hub: VERSION,
    members: members.map((m) => ({ name: m.name, url: m.spec.url, reached: !m.error, tools: m.tools.length, server: m.info?.serverInfo?.name ?? null, error: m.error })),
    clashes,
    skillsRoots,
  });
  const own = [
    {
      name: 'omni_status', description: 'Which members the hub reached, how many tools each gave, tool names two members both claimed, and the skills roots.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => JSON.stringify(status(), null, 1),
    },
    {
      name: 'omni_reach', description: 'One receipt line for a hand-back: what this session can reach right now (members up or down, skills roots present).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        await Promise.all(members.map((m) => m.connect()));
        const up = members.filter((m) => !m.error).map((m) => m.name);
        const down = members.filter((m) => m.error).map((m) => `${m.name} (${m.error})`);
        return `omni reach ${new Date().toISOString()}: up ${up.join(', ') || 'none'}; down ${down.join(', ') || 'none'}; skills ${skillsRoots.length ? skillsRoots.join(', ') : 'none'}`;
      },
    },
    {
      name: 'skill_list', description: 'The skills under the hub\'s skills roots: name, root and the first line of each description.',
      inputSchema: { type: 'object', properties: { match: { type: 'string', description: 'only names or descriptions containing this' } }, additionalProperties: false },
      handler: async ({ match }) => {
        const rows = listSkills(skillsRoots, io).filter((s) => !match || `${s.name} ${s.description}`.toLowerCase().includes(String(match).toLowerCase()));
        return rows.length ? rows.map((s) => `${s.name}\t${s.description}\t${s.root}`).join('\n') : 'no skills (set OMNI_SKILLS to one or more folders holding skills/*/SKILL.md)';
      },
    },
    {
      name: 'skill_read', description: 'Read one skill\'s SKILL.md, whole, labelled as text other people wrote.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } }, required: ['name'], additionalProperties: false },
      handler: async ({ name }) => {
        const s = readSkill(skillsRoots, name, io);
        if (!s) throw new Error(`no skill named ${name} under ${skillsRoots.join(', ') || '(no roots)'}`);
        return untrusted(s.text, { max: 60_000, what: `skill ${name} in ${s.root}` });
      },
    },
  ];
  const all = [...own, ...tools.filter((t) => !own.some((o) => o.name === t.name))];
  const server = createMcpServer({
    name: 'omni', version: VERSION, tools: all, input, output,
    instructions: `Omni: one door to the MCP servers this person runs elsewhere (${members.map((m) => `${m.name}${m.error ? ' [down]' : ''}`).join(', ') || 'no members in the roster'}). Tools are prefixed [member] in their descriptions. omni_status says what was reached; omni_reach gives a receipt line for a hand-back. Tokens live in the environment, never in the conversation.`,
  });
  return { server, members, own, status, clashes };
}
