// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Reading the other ways a CI pipeline or a chain of functions can be written: an org file, or a
// TopoForge drawing. The server (server/src/compute/formats.js) and the CLI share this file, so a
// drawing means the same thing on both sides. It has no dependencies, like the rest of the client.
//
// A problem in what someone wrote throws a FormatError. The server turns it into a 400 reply; the CLI
// prints it.

/** A mistake in a pipeline, a drawing or an org file, with a message for the person who wrote it. */
export class FormatError extends Error {
  constructor(message) { super(message); this.name = 'FormatError'; }
}
const bad = (msg) => new FormatError(msg);

// Org block languages, mapped to the runtime that runs them.
export const ORG_LANG = { sh: 'sh', bash: 'sh', shell: 'sh', js: 'node', javascript: 'node', node: 'node', python: 'python', python3: 'python' };
// Step and function names: lowercase letters, digits and "-", up to 63 characters.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Environment variable names in a pipeline: CAPITALS, digits and "_".
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

// ---- org-mode -----------------------------------------------------------------

/**
 * Pull the src blocks (code blocks) out of an org file: [{ name, lang, body, line }]
 * in file order. A block's name comes from a "#+NAME:" line right above it.
 * Two leading spaces are removed from each code line.
 */
export function orgBlocks(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  let name = null;
  for (let i = 0; i < lines.length; i++) {
    const nm = /^\s*#\+name:\s*(\S+)\s*$/i.exec(lines[i]);
    if (nm) { name = nm[1]; continue; }
    const begin = /^\s*#\+begin_src\s+(\S+)/i.exec(lines[i]);
    if (begin) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*#\+end_src\s*$/i.test(lines[j]); j++) body.push(lines[j].replace(/^ {2}/, ''));
      if (j >= lines.length) throw bad(`Unterminated src block at line ${i + 1}.`);
      out.push({ name, lang: begin[1].toLowerCase(), body: body.join('\n') + '\n', line: i + 1 });
      name = null;
      i = j;
      continue;
    }
    if (lines[i].trim() && !/^\s*#\+/.test(lines[i])) name = null; // a name must sit right above its block
  }
  return out;
}

/** Org properties like "#+GITCHA_IMAGE: node:22-alpine" (keyword lines). */
export function orgKeywords(text) {
  const kw = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*#\+(gitcha_[a-z_]+):\s*(.*?)\s*$/i.exec(line);
    if (m) kw[m[1].toLowerCase()] = m[2];
  }
  return kw;
}

// Build a raw pipeline from an org file. Blocks named "step-..." become steps
// and must be sh blocks. #+GITCHA_* keyword lines give the settings.
export function pipelineFromOrg(text) {
  const kw = orgKeywords(text);
  const steps = orgBlocks(text)
    .filter((b) => b.name && /^step-/.test(b.name))
    .map((b) => {
      if (ORG_LANG[b.lang] !== 'sh') throw bad(`Step ${b.name} must be a sh block (found ${b.lang}).`);
      return { name: b.name.slice(5), run: b.body };
    });
  return {
    image: kw.gitcha_image, timeout: kw.gitcha_timeout, steps,
    artifacts: kw.gitcha_artifacts, deploy: kw.gitcha_deploy ? { site: kw.gitcha_deploy } : undefined,
    on: kw.gitcha_on ? kw.gitcha_on.split(/[\s,]+/) : undefined,
  };
}

// ---- TopoForge --------------------------------------------------------------------

/** Get the pages of a TopoForge document (format "topoforge", version 1). It accepts a few layouts. */
export function topoPages(doc) {
  if (!doc || typeof doc !== 'object') throw bad('The drawing is not a JSON object.');
  if (Array.isArray(doc.pages)) return doc.pages;
  if (doc.doc?.pages) return doc.doc.pages;
  if (Array.isArray(doc.nodes)) return [{ nodes: doc.nodes, links: doc.links ?? [] }];
  throw bad('No pages found in the TopoForge drawing.');
}

/**
 * Order nodes by their arrows (a -> b means a runs before b). When two nodes
 * could go next, the one drawn first goes first. A loop of arrows is an error.
 */
export function topoOrder(nodes, links) {
  const ids = new Set(nodes.map((n) => n.id));
  const after = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const l of links ?? []) {
    let [from, to] = [l.a?.id, l.b?.id];
    if (l.arrows === 'start') [from, to] = [to, from];
    else if (l.arrows !== 'end') continue; // undirected or two-way lines carry no order
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    after.get(from).push(to);
    indeg.set(to, indeg.get(to) + 1);
  }
  const pos = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out = [];
  while (ready.length) {
    ready.sort((x, y) => pos.get(x) - pos.get(y));
    const id = ready.shift();
    out.push(id);
    for (const nxt of after.get(id)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) ready.push(nxt);
    }
  }
  if (out.length !== nodes.length) throw bad('The arrows in the drawing form a loop; steps need a clear order.');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return out.map((id) => byId.get(id));
}

/**
 * Read "KEY=value" lines (the custom field gitcha_env) into an object. Blank lines and lines
 * starting with "#" are skipped. A name that is not in CAPITALS is a mistake, said plainly.
 */
export function parseEnvLines(text) {
  const env = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // The name is trimmed; the value is kept exactly, spaces and all, so a drawn pipeline reads back the same.
    const eq = line.indexOf('=');
    const k = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (!ENV_RE.test(k)) throw bad(`gitcha_env: "${k.slice(0, 40)}" is not an environment variable name (CAPITALS, digits and _).`);
    env[k] = eq < 0 ? '' : line.slice(eq + 1);
  }
  return env;
}

/**
 * Build a raw pipeline from a TopoForge drawing. Nodes with data.run (a shell
 * command) become steps. The settings (data.gitcha_image, gitcha_timeout,
 * gitcha_artifacts, gitcha_deploy, gitcha_on and gitcha_env) can sit on any
 * node; they are merged together. Only the first page is read.
 */
export function pipelineFromDrawing(doc) {
  const page = topoPages(doc)[0] ?? { nodes: [], links: [] };
  const all = page.nodes ?? [];
  const stepNodes = all.filter((n) => typeof n.data?.run === 'string' && n.data.run.trim());
  const settings = Object.assign({}, ...all.map((n) => n.data ?? {}));
  return {
    image: settings.gitcha_image, timeout: settings.gitcha_timeout, artifacts: settings.gitcha_artifacts,
    deploy: settings.gitcha_deploy ? { site: settings.gitcha_deploy } : undefined,
    on: settings.gitcha_on ? String(settings.gitcha_on).split(/[\s,]+/).filter(Boolean) : undefined,
    env: settings.gitcha_env ? parseEnvLines(settings.gitcha_env) : undefined,
    steps: topoOrder(stepNodes, page.links).map((n) => ({ name: stepName(n), run: n.data.run })),
  };
}

/** A step's name: the custom field "step" if it is set, else the first line of the shape's text. */
function stepName(n) {
  const named = typeof n.data?.step === 'string' && n.data.step.trim() ? n.data.step : null;
  return (named ?? String(n.text || n.id).split('\n')[0]).toString().slice(0, 60);
}

/**
 * Read a drawn chain of functions: the nodes with data.function, in arrow
 * order. Each function is fed the response of the one before it.
 */
export function chainFromDrawing(doc) {
  const page = topoPages(doc)[0] ?? { nodes: [], links: [] };
  const fnNodes = (page.nodes ?? []).filter((n) => typeof n.data?.function === 'string');
  if (!fnNodes.length) throw bad('No node in the drawing names a function (set data "function" on a shape).');
  return topoOrder(fnNodes, page.links).map((n) => {
    if (!NAME_RE.test(n.data.function)) throw bad(`"${n.data.function}" is not a function name.`);
    return n.data.function;
  });
}
