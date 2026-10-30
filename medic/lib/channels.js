// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The channels: where the medic says what it found. syslog always (the host's own record); the others as
// configured. Each adapter is small and fails on its own: a room that is closed does not stop the log line.
// Everything sent is text the report made, after config.redact(); no setting's value leaves the host.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PRIORITY = { bad: 'daemon.err', warn: 'daemon.warning', ok: 'daemon.info', info: 'daemon.info' };

/** syslog, through logger(1): one line per finding and one headline, tagged gitcha-medic. */
async function syslog({ run, identity }, { headline, findings }) {
  const worst = findings.some((x) => x.level === 'bad') ? 'bad' : findings.some((x) => x.level === 'warn') ? 'warn' : 'ok';
  const r = await run('logger', ['-t', 'gitcha-medic', '-p', PRIORITY[worst], `${identity} ${headline}`]);
  if (r.code === 127) throw new Error('logger(1) is not installed (bsdutils)');
  if (r.code !== 0) throw new Error(r.err || `logger exited ${r.code}`);
  for (const x of findings.filter((y) => y.level !== 'ok')) {
    await run('logger', ['-t', 'gitcha-medic', '-p', PRIORITY[x.level], `${identity} ${x.level} ${x.id}: ${x.what}`]);
  }
  return 'logged';
}

/**
 * Tavern: POST /api/say to the node on this machine, as the agent face. The port and token come from the
 * agent.json Tavern writes in its data directory (GITCHA_MEDIC_TAVERN_AGENT_JSON); the token is read per call and
 * never kept. The medic speaks as GITCHA_MEDIC_TAVERN_AS in room GITCHA_MEDIC_TAVERN_ROOM.
 */
async function tavern({ config, fetchFn, readFile }, { brief }) {
  const t = config.tavern;
  if (!t.agentJson) throw new Error('GITCHA_MEDIC_TAVERN_AGENT_JSON names no file');
  const info = JSON.parse(readFile(t.agentJson));
  if (!info.port || !info.token) throw new Error(`${t.agentJson} has no port and token`);
  const res = await fetchFn(`http://127.0.0.1:${info.port}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ as: t.as, room: t.room, text: brief }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Tavern answered HTTP ${res.status}`);
  return `said in ${t.room}`;
}

/**
 * chadgram: one ilmsg/1 line appended to a JSONL file that a chad.tab route reads (-->> APPEND), as alphaOS's
 * CONTRACT-il-net.md shapes it: {"v":"ilmsg/1","id","ts","from":{net,env,game,who},"to":{env,who},"kind","body"}.
 */
async function chadgram({ config, identity, appendFile }, { brief, worst }) {
  const c = config.chadgram;
  if (!c.file) throw new Error('GITCHA_MEDIC_CHADGRAM_FILE names no file');
  const line = JSON.stringify({
    v: 'ilmsg/1', id: crypto.randomBytes(8).toString('hex'), ts: Math.floor(Date.now() / 1000),
    from: { net: c.net, env: identity, game: 'gitcha-medic', who: identity },
    to: { env: '', who: '' }, kind: worst === 'ok' ? 'heartbeat' : 'alert', body: brief,
  });
  appendFile(c.file, `${line}\n`);
  return `appended to ${c.file}`;
}

/** A generic webhook: JSON by POST. comic.chat and other rooms get an adapter of their own when they have an API to speak to. */
async function webhook({ config, identity, fetchFn }, { headline, brief, findings, worst }) {
  if (!config.webhook.url) throw new Error('GITCHA_MEDIC_WEBHOOK_URL is empty');
  const res = await fetchFn(config.webhook.url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'gitcha-medic', identity, level: worst, headline, text: brief, findings: findings.map(({ id, level, what, remedy }) => ({ id, level, what, remedy })) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
  return 'posted';
}

/** C4: a postcard dropped as a file in a folder, for a hand move into a C4 tree (as arcade.js does for games). */
async function c4({ config, identity, writeFile, mkdir }, { brief, worst, at }) {
  if (!config.c4.dir) throw new Error('GITCHA_MEDIC_C4_DIR is empty');
  mkdir(config.c4.dir);
  const name = `${at.replace(/[:.]/g, '-')}-${worst}-${identity.replace(/[^A-Za-z0-9@._-]/g, '_')}.md`;
  writeFile(path.join(config.c4.dir, name), `# gitcha-medic ${identity} ${at}\n\n${brief}\n`);
  return `dropped ${name}`;
}

const ADAPTERS = { syslog, tavern, chadgram, webhook, c4 };
/** TODO adapters named in the design and not yet written: comic.chat (needs its server API), the Wire (an outbox a keeper carries). */
export const PLANNED = ['comic.chat', 'wire'];

/**
 * announce(config, message, deps): send `message` ({headline, brief, findings, worst, at}) to every channel in
 * config.channels. Returns one row per channel: {channel, ok, said}. Nothing throws out of here.
 */
export async function announce(config, message, deps = {}) {
  const ctx = {
    config, identity: config.identity, run: deps.run,
    fetchFn: deps.fetchFn ?? fetch,
    readFile: deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8')),
    appendFile: deps.appendFile ?? ((p, s) => fs.appendFileSync(p, s)),
    writeFile: deps.writeFile ?? ((p, s) => fs.writeFileSync(p, s)),
    mkdir: deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true })),
  };
  const rows = [];
  for (const name of config.channels) {
    try { rows.push({ channel: name, ok: true, said: await ADAPTERS[name](ctx, message) }); }
    catch (err) { rows.push({ channel: name, ok: false, said: String(err?.message ?? err) }); }
  }
  return rows;
}
