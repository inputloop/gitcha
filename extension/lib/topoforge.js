// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Writing TopoForge drawings from Gitcha: a CI pipeline (with a build's results, if it ran), a chain of
// functions, and a map of a live instance. The reader for the other direction is in formats.js, and the
// two are made to meet: a pipeline drawn here and read back there is the same pipeline (the tests check it).
//
// The drawings are TopoForge 1.7 documents ({ format: "topoforge", version: 1, pages }). Every shape and
// connector carries the lasting handle TopoForge uses (the custom field tf_ref), so TopoForge's Story
// export can cite them. Open one in TopoForge with File > Open. Shared by the server and the CLI; no
// dependencies.
import { FormatError, parseEnvLines } from './formats.js';

// What a build's step looked like, by its result (fill colours a reader can tell apart, with words too).
const RESULT_FILL = { passed: '#dcfce7', failed: '#fee2e2', 'not run': '#f1f5f9' };

/** Make a handle TopoForge accepts (^[a-z0-9][a-z0-9._-]{0,63}$), unique within `used`. */
function handle(prefix, text, used) {
  const slug = String(text ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 40) || 'x';
  let ref = `${prefix}-${slug}`.slice(0, 60);
  for (let i = 2; used.has(ref); i++) ref = `${prefix}-${slug}`.slice(0, 56) + `-${i}`;
  used.add(ref);
  return ref;
}

/** A small builder for one page of a drawing. */
class PageBuilder {
  constructor(name) {
    this.page = { id: handle('pg', name, new Set()), name, layers: [{ id: 'L1', name: 'Drawing', visible: true, locked: false }], activeLayer: 'L1', nodes: [], links: [] };
    this.used = new Set();
  }

  /** Add a shape. Returns its id (which is also its handle). */
  node(type, { x, y, w, h, text, parent = null, data = {}, props = {}, style = {}, key = text }) {
    const id = handle(type, key, this.used);
    this.page.nodes.push({ id, type, x, y, w, h, text, layer: 'L1', parent, props, data: { tf_ref: id, ...data }, style });
    return id;
  }

  /** Add a connector from shape `a` to shape `b`. */
  link(a, b, { text = '', arrows = 'end', medium = 'logical', data = {} } = {}) {
    const id = handle('link', `${a}-${b}`, this.used);
    this.page.links.push({ id, a: { id: a }, b: { id: b }, route: 'orthogonal', text, layer: 'L1', arrows, props: { medium }, style: {}, data: { tf_ref: id, ...data } });
    return id;
  }
}

/** Wrap pages into a TopoForge document. */
export function drawing(name, pages) {
  return {
    format: 'topoforge', version: 1, name,
    settings: { grid: 20, snap: true, showGrid: true, guides: true, netLabels: true, ifLabels: true, minimap: true, defaultRoute: 'orthogonal' },
    pages: pages.map((p) => p.page), cur: 0,
  };
}

/** A time limit in milliseconds, written back as the shortest exact duration ("90s", "10m", "2h"). */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * Draw a CI pipeline: one rounded box per step, top to bottom, joined by arrows in the order they run,
 * and a note holding the settings. Takes either a raw pipeline (as written in gitcha-ci.json, with
 * `timeout`) or the server's canonical one (with `timeoutMs`). `results` (step name -> 'passed', 'failed'
 * or 'not run') colours the steps for a build that ran. Read back with pipelineFromDrawing.
 */
export function pipelineToDrawing(p, { name = 'CI pipeline', results = null, job = null } = {}) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.steps) || !p.steps.length) throw new FormatError('The pipeline has no steps to draw.');
  const pg = new PageBuilder('Pipeline');
  const W = 280, H = 90, GAP = 60;
  const heading = job ? `Build ${job.id}: ${job.status}\nGreen passed, red failed, grey did not run. Each step's custom field "result" says the same in words.` : `${name}\nEach step runs after the one its arrow comes from. Open a step's custom fields to read or change its command (run).`;
  pg.node('text', { x: 0, y: -110, w: 640, h: 70, text: heading, key: 'title' });

  const env = Object.entries(p.env ?? {});
  for (const [k, v] of env) if (/[\r\n]/.test(String(v))) throw new FormatError(`The value of ${k} has a line break; it cannot be written as a gitcha_env line.`);
  const timeout = p.timeout ?? durationText(p.timeoutMs);
  const on = Array.isArray(p.on) ? p.on : undefined;
  const settings = {
    ...(p.image ? { gitcha_image: p.image } : {}),
    ...(timeout ? { gitcha_timeout: String(timeout) } : {}),
    ...(p.artifacts ? { gitcha_artifacts: p.artifacts } : {}),
    ...(p.deploy?.site ? { gitcha_deploy: p.deploy.site } : {}),
    ...(on ? { gitcha_on: on.join(',') } : {}),
    ...(env.length ? { gitcha_env: env.map(([k, v]) => `${k}=${v}`).join('\n') } : {}),
  };
  const lines = ['Pipeline settings', ...Object.entries(settings).map(([k, v]) => `${k.slice(7)}: ${k === 'gitcha_env' ? `${env.length} variable(s)` : v}`)];
  pg.node('note', { x: W + 80, y: 0, w: 300, h: 40 + 22 * lines.length, text: lines.join('\n'), data: settings, key: 'settings' });

  let prev = null;
  p.steps.forEach((s, i) => {
    const run = typeof s === 'string' ? s : s.run;
    const stepName = String((typeof s === 'string' ? null : s.name) ?? `step ${i + 1}`);
    const firstLine = String(run ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
    const result = results?.[stepName];
    const id = pg.node('rounded', {
      x: 0, y: i * (H + GAP), w: W, h: H,
      text: `${stepName.split('\n')[0]}\n${firstLine.length > 44 ? `${firstLine.slice(0, 43)}…` : firstLine}`,
      data: { step: stepName, run, ...(result ? { result } : {}) },
      style: result ? { fill: RESULT_FILL[result] } : {},
      key: `step-${stepName}`,
    });
    if (prev) pg.link(prev, id);
    prev = id;
  });
  return drawing(name, [pg]);
}

/**
 * Read which steps of a finished build passed, failed or did not run, from the markers the runner
 * prints in the log (runner/lib/script.js): "@@GITCHA-STEP@@ NAME" as a step starts and
 * "@@GITCHA-FAILED@@ NAME CODE" when it fails. A step after a failure did not run.
 */
export function stepResults(steps, log, jobStatus) {
  const started = new Set(), failed = new Set();
  for (const line of String(log ?? '').split('\n')) {
    let m = /^@@GITCHA-STEP@@ (.*)$/.exec(line);
    if (m) { started.add(m[1]); continue; }
    m = /^@@GITCHA-FAILED@@ (.*) (-?\d+)$/.exec(line);
    if (m) failed.add(m[1]);
  }
  const out = {};
  const names = steps.map((s) => String(typeof s === 'string' ? '' : s.name));
  names.forEach((n, i) => {
    if (failed.has(n)) out[n] = 'failed';
    else if (!started.has(n)) out[n] = 'not run';
    // A step that started is passed if a later step started too, or if the whole build succeeded.
    else out[n] = names.slice(i + 1).some((m) => started.has(m)) || jobStatus === 'succeeded' ? 'passed' : (jobStatus === 'running' ? 'running' : 'failed');
  });
  return out;
}

/**
 * Draw a chain function: one box per function it calls, in order. Read back with chainFromDrawing
 * (each box carries the custom field "function").
 */
export function chainToDrawing(fnName, chain, { owner = '' } = {}) {
  if (!Array.isArray(chain) || !chain.length) throw new FormatError('The chain names no functions.');
  const pg = new PageBuilder('Chain');
  pg.node('text', { x: 0, y: -110, w: 640, h: 70, text: `Function ${owner ? `${owner}/` : ''}${fnName}\nEach function is given the answer of the one before it.`, key: 'title' });
  let prev = null;
  chain.forEach((f, i) => {
    const id = pg.node('rounded', { x: i * 340, y: 0, w: 260, h: 80, text: f, data: { function: f }, key: `fn-${f}` });
    if (prev) pg.link(prev, id);
    prev = id;
  });
  return drawing(`${fnName} (chain)`, [pg]);
}

/**
 * Draw a live instance from a snapshot the server makes (see server/src/topoforge.js): the server
 * and where it keeps its data, its runners (online or not), its sites and their names, and the ring.
 * Long lists are cut to `max` shapes each, with a note saying how many more there are.
 */
export function systemToDrawing(snap, { max = 40 } = {}) {
  const pg = new PageBuilder('Instance');
  pg.node('text', { x: 0, y: -130, w: 1000, h: 80, text: `${snap.name}: this instance, as it is now\nDrawn by Gitcha ${snap.version} from ${snap.url} at ${snap.at}. Each shape's custom fields hold the details.`, key: 'title' });

  const server = pg.node('server', { x: 360, y: 260, w: 80, h: 92, text: 'gitcha-server', props: { hostname: snap.host ?? '', notes: `Gitcha ${snap.version}` }, data: { url: snap.url, users: String(snap.counts.users), projects: String(snap.counts.projects), packages: String(snap.counts.packages) }, key: 'gitcha' });
  const store = snap.store === 'cassandra'
    ? pg.node('database', { x: 360, y: 460, w: 80, h: 92, text: 'Apache Cassandra', data: { store: 'cassandra' }, key: 'store' })
    : pg.node('storage', { x: 360, y: 460, w: 80, h: 92, text: 'db.json (file store)', data: { store: 'file' }, key: 'store' });
  pg.link(server, store, { text: 'store.tx' });

  const grid = (zoneType, title, x, y, items, draw) => {
    const shown = items.slice(0, max);
    const cols = 4, cw = 140, rh = 140;
    const rows = Math.max(1, Math.ceil(shown.length / cols));
    const zone = pg.node(zoneType, { x, y, w: cols * cw + 20, h: rows * rh + 60 + (items.length > max ? 40 : 0), text: title, key: title });
    shown.forEach((it, i) => draw(it, x + 30 + (i % cols) * cw, y + 50 + Math.floor(i / cols) * rh, zone));
    if (items.length > max) pg.node('text', { x: x + 20, y: y + 50 + rows * rh, w: cols * cw - 20, h: 30, text: `and ${items.length - max} more`, parent: zone, key: `${title}-more` });
    if (!items.length) pg.node('text', { x: x + 20, y: y + 50, w: cols * cw - 20, h: 30, text: 'none', parent: zone, key: `${title}-none` });
    return zone;
  };

  const runners = grid('zone', `Runners (${snap.runners.length})`, 700, 0, snap.runners, (r, x, y, zone) => {
    pg.node('server', { x, y, w: 80, h: 92, text: r.name, parent: zone, props: { status: r.online ? 'online' : 'offline' }, data: { backend: r.backend ?? '', labels: (r.labels ?? []).join(','), scope: r.scope ?? '', capabilities: (r.capabilities ?? []).join(',') }, key: `runner-${r.name}` });
  });
  pg.link(runners, server, { text: 'long-poll for jobs' });

  const sites = grid('zone', `Sites (${snap.sites.length})`, 700, 420, snap.sites, (s, x, y, zone) => {
    pg.node('server', { x, y, w: 80, h: 92, text: s.name, parent: zone, props: { hostname: s.hostnames[0] ?? '' }, data: { owner: s.owner, names: s.hostnames.join('\n'), deploys: String(s.deploys) }, key: `site-${s.name}` });
  });
  pg.link(server, sites, { text: 'serves' });

  const ring = grid('zone', `The ring (${snap.ring.length})`, -300, 0, snap.ring, (u, x, y, zone) => {
    pg.node('cloud', { x, y, w: 80, h: 80, text: u.replace(/^https?:\/\//, ''), parent: zone, data: { url: u }, key: `peer-${u}` });
  });
  pg.link(server, ring, { text: 'links', arrows: 'both', medium: 'wan' });
  return drawing(`${snap.name} (instance)`, [pg]);
}

export { parseEnvLines };
