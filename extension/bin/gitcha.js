#!/usr/bin/env node
// gitcha: command-line client for a Gitcha registry. Also used by the Claude
// extension for first-run sign-in, so passwords never pass through the model.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitchaClient, GitchaError } from '../lib/client.js';
import { resolveServer, getCredentials, saveCredentials, removeCredentials, credentialsPath } from '../lib/credentials.js';
import { pack } from '../lib/pack.js';
import { installOne, installAll, parseSpec } from '../lib/installer.js';
import { ask } from '../lib/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

const color = (process.stderr.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36), magenta = c(35);
const out = (...a) => console.log(...a);

const HELP = `${bold('gitcha')} ${dim(`v${VERSION}`)}: client for the Gitcha package registry

${bold('First run')}
  gitcha login [--server URL] [--device NAME]   sign in with password + authenticator code

${bold('Packages')}
  gitcha search [query]                         find packages
  gitcha info <name>                            show a package and its versions
  gitcha install [name[@version]] [--dir DIR]   install one package, or all from gitcha.json
  gitcha publish [DIR]                          publish the package in DIR (default: .)
  gitcha yank <name@version> [--undo]           hide a broken version from installs

${bold('Security')}
  gitcha status                                 who you are and when the next 2FA check is due
  gitcha verify [CODE]                          re-confirm 2FA now (intermittent check)
  gitcha security [--interval on|off] [--new-network on|off] [--sensitive on|off]
                                                view or toggle follow-up 2FA checks
  gitcha logout                                 revoke this device's token

${bold('Claude')}
  gitcha mcp                                    run the Claude extension (MCP server on stdio)

Options: --server URL (or GITCHA_SERVER), --json, --help, --version`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !['json', 'undo', 'help', 'version', 'hook'].includes(k)) args.flags[k] = argv[++i];
      else args.flags[k] = true;
    } else args._.push(a);
  }
  return args;
}

const REASON_TEXT = {
  interval: 'Periodic security check: please confirm it is still you.',
  new_network: 'This device is on a new network: please confirm it is you.',
  sensitive_action: 'This is a sensitive action and needs a fresh code.',
};

async function promptCode(reason) {
  if (!process.stdin.isTTY) {
    throw new Error(`${REASON_TEXT[reason] ?? 'Two-factor check required.'} Run \`gitcha verify <code>\` and try again.`);
  }
  process.stderr.write(`\n${yellow('🔐 ' + (REASON_TEXT[reason] ?? 'Two-factor check required.'))}\n`);
  return ask(`${bold('Authenticator code')}: `);
}

/** Load the saved device token; the first run must go through `gitcha login`. */
function authedClient(flags) {
  const server = resolveServer(flags.server);
  const creds = getCredentials(server);
  if (!creds) throw new Error(`You are not signed in to ${server}.\nRun ${cyan('gitcha login' + (flags.server ? ` --server ${server}` : ''))} first: a password and an authenticator code are required.`);
  return new GitchaClient({ server, token: creds.token, userAgent: `gitcha-cli/${VERSION}` });
}

/** Run fn; if the server asks for an intermittent 2FA check, prompt and retry once. */
async function withStepUp(client, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof GitchaError && err.mfaRequired)) throw err;
    const code = await promptCode(err.reason);
    await client.stepUp(code);
    process.stderr.write(green('✓ Verified.\n'));
    return fn();
  }
}

const when = (t) => (t ? new Date(t).toLocaleString() : 'never');

const commands = {
  async login({ flags }) {
    const server = resolveServer(flags.server);
    const client = new GitchaClient({ server, userAgent: `gitcha-cli/${VERSION}` });
    const health = await client.health();
    out(`${magenta('◆')} Signing in to ${bold(server)} ${dim(`(Gitcha v${health.version})`)}`);
    const username = flags.username || (await ask(`${bold('Username')}: `));
    const password = (await ask(`${bold('Password')}: `, { hidden: true }));
    const { mfa_ticket } = await client.login(username, password);
    out(dim('Password accepted. Two-factor authentication is required.'));
    const code = flags.code || (await ask(`${bold('Authenticator code')}: `));
    const device = flags.device || `gitcha CLI on ${os.hostname()}`;
    const res = await client.loginMfa(mfa_ticket, code, device);
    saveCredentials(server, { username: res.username, token: res.token, device: res.device });
    out(green(`✓ Signed in as ${bold(res.username)}.`) + ` Device "${res.device}" registered.`);
    out(dim(`  Token saved to ${credentialsPath()} (mode 600). Your password is not stored.`));
    if (res.next_check_at) out(dim(`  Next periodic 2FA check: ${when(res.next_check_at)}`));
  },

  async logout({ flags }) {
    const client = authedClient(flags);
    try { await client.logout(); } catch (err) { if (!(err instanceof GitchaError)) throw err; }
    removeCredentials(client.server);
    out(green('✓ Signed out; this device token has been revoked.'));
  },

  async status({ flags }) {
    const server = resolveServer(flags.server);
    const creds = getCredentials(server);
    if (!creds) {
      if (flags.hook) return out(`Gitcha: not signed in to ${server}. Tell the user to run \`gitcha login\` in a terminal before using Gitcha tools.`);
      return out(`${yellow('●')} Not signed in to ${server}. Run ${cyan('gitcha login')}.`);
    }
    const client = authedClient(flags);
    const me = await client.whoami();
    if (flags.json) return out(JSON.stringify(me, null, 2));
    if (flags.hook) {
      return out(`Gitcha: signed in to ${server} as ${me.user.username}; 2FA ${me.mfa.ok ? `ok (next check ${when(me.mfa.next_check_at)})` : `check due (${me.mfa.reason})`}.`);
    }
    out(`${green('●')} Signed in to ${bold(server)} as ${bold(me.user.username)} ${dim(`(${me.user.role})`)}`);
    out(`  Device          ${me.device.name}`);
    out(`  Last 2FA        ${when(me.mfa.verified_at)}`);
    out(me.mfa.ok
      ? `  Next 2FA check  ${me.mfa.next_check_at ? when(me.mfa.next_check_at) : dim('periodic checks off')}`
      : `  2FA status      ${yellow(`check due: ${REASON_TEXT[me.mfa.reason]}`)} Run ${cyan('gitcha verify')}.`);
  },

  async verify({ _, flags }) {
    const client = authedClient(flags);
    const code = _[1] || (await ask(`${bold('Authenticator code')}: `));
    const res = await client.stepUp(code);
    out(green('✓ Two-factor verified.') + (res.next_check_at ? dim(` Next periodic check: ${when(res.next_check_at)}`) : ''));
  },

  async security({ flags }) {
    const client = authedClient(flags);
    const map = { interval: 'interval', 'new-network': 'new_network', sensitive: 'sensitive' };
    const changes = {};
    for (const [flag, key] of Object.entries(map)) {
      if (flags[flag] === undefined) continue;
      if (!['on', 'off'].includes(flags[flag])) throw new Error(`--${flag} must be "on" or "off"`);
      changes[key] = flags[flag] === 'on';
    }
    let res;
    if (Object.keys(changes).length) {
      res = await withStepUp(client, () => client.setSecurity(changes));
      out(green('✓ Two-factor check settings updated.'));
    } else {
      res = await client.getSecurity();
    }
    const { checks } = res;
    if (flags.json) return out(JSON.stringify(checks, null, 2));
    const row = (label, key, extra = '') => out(`  ${checks[key] ? green('on ') : yellow('off')}  ${label}${extra}${checks.locked.includes(key) ? dim('  (required by admin)') : ''}`);
    out(bold('Follow-up two-factor checks') + dim(' (sign-in always requires a code)'));
    row('Periodic re-verification', 'interval', dim(` every ${Math.round(checks.intervalMs / 3600000)}h`));
    row('New network check       ', 'new_network');
    row('Sensitive action check  ', 'sensitive');
    out(dim('\nToggle with e.g. `gitcha security --new-network off` (needs a fresh code).'));
  },

  async search({ _, flags }) {
    const client = authedClient(flags);
    const { packages } = await withStepUp(client, () => client.search(_.slice(1).join(' ')));
    if (flags.json) return out(JSON.stringify(packages, null, 2));
    if (!packages.length) return out(dim('No packages found.'));
    for (const p of packages) out(`${bold(cyan(p.name))} ${green('v' + p.latest)}  ${p.description || dim('no description')}  ${dim(`by ${p.owner} · ${p.downloads} install${p.downloads === 1 ? '' : 's'}`)}`);
  },

  async info({ _, flags }) {
    if (!_[1]) throw new Error('Usage: gitcha info <name>');
    const client = authedClient(flags);
    const p = await withStepUp(client, () => client.info(_[1]));
    if (flags.json) return out(JSON.stringify(p, null, 2));
    out(`${bold(cyan(p.name))} ${green('v' + p.latest)}  ${dim(p.license)}`);
    if (p.description) out(p.description);
    out(dim(`owner ${p.owner} · ${p.downloads} install${p.downloads === 1 ? '' : 's'}`));
    out(bold('\nVersions'));
    for (const v of p.versions) out(`  ${v.yanked ? red(v.version + ' (yanked)') : v.version}  ${dim(v.integrity.slice(0, 30) + '…')}  ${dim(when(v.publishedAt))}`);
  },

  async install({ _, flags }) {
    const client = authedClient(flags);
    const dir = flags.dir || process.cwd();
    const results = _[1]
      ? [await withStepUp(client, () => installOne(client, parseSpec(_[1]), { dir }))]
      : await withStepUp(client, () => installAll(client, { dir }));
    if (flags.json) return out(JSON.stringify(results, null, 2));
    if (!results.length) return out(dim('Nothing to install (no "dependencies" in gitcha.json).'));
    for (const r of results) out(`${green('✓')} ${bold(r.name)}@${r.version} ${dim(`→ ${path.relative(process.cwd(), r.path) || r.path} (${r.files} files, ${r.integrity.slice(0, 19)}…)`)}`);
  },

  async publish({ _, flags }) {
    const client = authedClient(flags);
    const dir = path.resolve(_[1] || '.');
    const { manifest, files, tarball } = pack(dir);
    out(`${magenta('◆')} Packing ${bold(`${manifest.name}@${manifest.version}`)} ${dim(`(${files.length} files, ${(tarball.length / 1024).toFixed(1)} KB)`)}`);
    const res = await withStepUp(client, () => client.publish(tarball));
    if (flags.json) return out(JSON.stringify(res, null, 2));
    out(green(`✓ Published ${bold(`${res.name}@${res.version}`)}`) + dim(`  ${res.integrity}`));
  },

  async yank({ _, flags }) {
    if (!_[1] || !_[1].includes('@')) throw new Error('Usage: gitcha yank <name@version> [--undo]');
    const client = authedClient(flags);
    const { name, version } = parseSpec(_[1]);
    const res = await withStepUp(client, () => client.yank(name, version, !flags.undo));
    out(green(`✓ ${res.name}@${res.version} ${res.yanked ? 'yanked' : 'restored'}.`));
  },

  async mcp() {
    await import('./gitcha-mcp.js');
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.flags.version) return out(VERSION);
  if (!cmd || args.flags.help || cmd === 'help') return out(HELP);
  const fn = commands[cmd === 'whoami' ? 'status' : cmd];
  if (!fn) throw new Error(`Unknown command "${cmd}". Run \`gitcha help\`.`);
  await fn(args);
}

main().catch((err) => {
  // The SessionStart hook must never break a Claude session.
  if (process.argv.includes('--hook')) return out(`Gitcha: status unavailable (${err.message.split('\n')[0]}).`);
  console.error(red('✗ ') + err.message);
  process.exitCode = 1;
});
