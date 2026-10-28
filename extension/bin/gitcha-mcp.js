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
    description: 'Search the Gitcha registry for packages by name or description. An empty query lists recently updated packages.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search words' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: ({ query = '' }) => call(async (c) => {
      const { packages } = await c.search(query);
      if (!packages.length) return text(`No packages found${query ? ` for "${query}"` : ''}.`);
      return text(packages.map((p) => `- ${p.name}@${p.latest}: ${p.description || '(no description)'} [${p.license}, by ${p.owner}, ${p.downloads} install${p.downloads === 1 ? '' : 's'}]`).join('\n'));
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
      return text(`${p.name}@${p.latest} (${p.license}) by ${p.owner}\n${p.description}\n\nVersions:\n${versions}\n\nREADME:\n${(p.readme ?? '(none)').slice(0, 6000)}`);
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
    description: 'Pack the directory containing gitcha.json and publish it. Versions are immutable. Publishing is a sensitive action: the registry usually requires a fresh 2FA code, which you must get from the user. Confirm with the user before publishing.',
    inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'Directory containing gitcha.json' } }, required: ['directory'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: ({ directory }) => call(async (c) => {
      const { files, tarball } = pack(path.resolve(directory));
      const r = await c.publish(tarball);
      return text(`Published ${r.name}@${r.version} (${files.length} files, ${tarball.length} bytes). Integrity: ${r.integrity}\nFiles: ${files.join(', ')}`);
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
- Confirm with the user before publishing or yanking. Only change 2FA check settings when the user explicitly asks.`;

createMcpServer({ name: 'gitcha', version: VERSION, instructions, tools }).listen();
