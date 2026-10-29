// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The file formats for CI pipelines and lambda functions (small programs that
// run per request). People can write them in several formats. Each one is
// turned into one canonical (standard) shape, and that is what runners run:
//
//   pipeline: { image, timeoutMs, env, steps: [{ name, run }], artifacts, deploy }
//   function: { runtime, entry, source? , chain? , timeoutMs, memoryMb, public }
//
// Authoring formats:
//   gitcha-ci.json        the canonical pipeline, written by hand
//   gitcha-ci.org         org-mode (a plain-text outline format from Emacs): each
//                         "#+NAME: step-..." sh block is a step, in file order
//   gitcha-ci.topoforge.json  a TopoForge drawing: nodes with data.run are steps,
//                         arrows give their order (a topological sort, which
//                         puts each step after every step that points to it)
//   gitcha.fn.json        a function's settings; the code is in its own files
//   *.org#block           a function whose code is one named src block of an org file
//   *.topoforge.json      a function that chains other functions, drawn in TopoForge
import { HttpError } from '../errors.js';

// A container image name must start with a letter or digit. Then the launcher
// can never read it as an option like "--privileged" (FMT-2).
const IMAGE_RE = /^[A-Za-z0-9][\w./:@-]{0,199}$/;
// The kinds of function code a runner can run.
export const RUNTIMES = ['node', 'sh', 'python', 'chain', 'orgvm'];
// Org block languages, mapped to the runtime that runs them.
const ORG_LANG = { sh: 'sh', bash: 'sh', shell: 'sh', js: 'node', javascript: 'node', node: 'node', python: 'python', python3: 'python' };
const MAX_STEPS = 50;
// Step and function names: lowercase letters, digits and "-", up to 63 characters.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Turn a duration like "30s", "10m", "2h" or "500ms" into milliseconds. A bare
 * number means seconds. Empty gives `fallback`; the result is never above `max`.
 */
export function parseDuration(v, fallback, max) {
  if (v === undefined || v === null || v === '') return fallback;
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(v).trim());
  if (!m) throw new HttpError(400, 'bad_spec', `Bad duration "${v}" (use e.g. 30s, 10m).`);
  const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
  return Math.min(ms, max);
}

const bad = (msg) => new HttpError(400, 'bad_spec', msg);

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

/** Get the pages, nodes and links of a TopoForge document (format "topoforge", version 1). It accepts a few layouts. */
function topoPages(doc) {
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
 * Build a raw pipeline from a TopoForge drawing. Nodes with data.run (a shell
 * command) become steps. The settings (data.gitcha_image and so on) can sit on
 * any node; they are merged together. Only the first page is read.
 */
export function pipelineFromTopoForge(doc) {
  const page = topoPages(doc)[0] ?? { nodes: [], links: [] };
  const all = page.nodes ?? [];
  const stepNodes = all.filter((n) => typeof n.data?.run === 'string' && n.data.run.trim());
  const settings = Object.assign({}, ...all.map((n) => n.data ?? {}));
  return {
    image: settings.gitcha_image, timeout: settings.gitcha_timeout, artifacts: settings.gitcha_artifacts,
    deploy: settings.gitcha_deploy ? { site: settings.gitcha_deploy } : undefined,
    steps: topoOrder(stepNodes, page.links).map((n) => ({ name: (n.text || n.id).toString().slice(0, 60), run: n.data.run })),
  };
}

/**
 * Read a drawn chain of functions: the nodes with data.function, in arrow
 * order. Each function is fed the response of the one before it.
 */
export function chainFromTopoForge(doc) {
  const page = topoPages(doc)[0] ?? { nodes: [], links: [] };
  const fnNodes = (page.nodes ?? []).filter((n) => typeof n.data?.function === 'string');
  if (!fnNodes.length) throw bad('No node in the drawing names a function (set data "function" on a shape).');
  return topoOrder(fnNodes, page.links).map((n) => {
    if (!NAME_RE.test(n.data.function)) throw bad(`"${n.data.function}" is not a function name.`);
    return n.data.function;
  });
}

// ---- canonical forms --------------------------------------------------------------------

/**
 * Check a raw pipeline and return the canonical shape. Limits: 1 to 50 steps,
 * 20,000 characters per command, env names in CAPITALS, values up to 4096
 * characters. The time limit defaults to 10 minutes, capped at maxTimeoutMs
 * (1 hour unless told otherwise). "artifacts" must be a relative folder with
 * no "..", and "deploy" needs it.
 */
export function normalizePipeline(p, { maxTimeoutMs = 3_600_000, defaultImage } = {}) {
  if (!p || typeof p !== 'object') throw bad('The pipeline is not an object.');
  const steps = (p.steps ?? []).map((s, i) => {
    const run = typeof s === 'string' ? s : s?.run;
    if (typeof run !== 'string' || !run.trim()) throw bad(`Step ${i + 1} has no "run" command.`);
    return { name: String(s.name ?? `step ${i + 1}`).slice(0, 60), run: run.slice(0, 20_000) };
  });
  if (!steps.length) throw bad('The pipeline has no steps.');
  if (steps.length > MAX_STEPS) throw bad(`At most ${MAX_STEPS} steps.`);
  const image = p.image ?? defaultImage;
  if (!image || !IMAGE_RE.test(image)) throw bad('Set "image" to the container image the steps run in.');
  const env = {};
  for (const [k, v] of Object.entries(p.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) throw bad(`Bad environment variable name "${k}".`);
    env[k] = String(v).slice(0, 4096);
  }
  const artifacts = p.artifacts ? String(p.artifacts).replace(/^\/+/, '') : null;
  if (artifacts && (artifacts.includes('..') || !/^[\w./-]+$/.test(artifacts))) throw bad('"artifacts" must be a relative directory.');
  const deploy = p.deploy?.site ? { site: String(p.deploy.site).toLowerCase() } : null;
  if (deploy && !artifacts) throw bad('"deploy" needs "artifacts": the directory to publish.');
  const on = Array.isArray(p.on) ? p.on.filter((x) => ['publish', 'manual'].includes(x)) : ['manual'];
  return { image, timeoutMs: parseDuration(p.timeout, 10 * 60_000, maxTimeoutMs), env, steps, artifacts, deploy, on };
}

/**
 * Check a function's gitcha.fn.json and return the canonical shape. `files`
 * maps upload paths to their contents. An org entry may add a generated file
 * to it. The time limit defaults to 10 seconds (at most 5 minutes). Memory is
 * kept between 64 and 4096 MB (default 256).
 */
export function normalizeFunction(f, files = new Map()) {
  if (!f || typeof f !== 'object') throw bad('gitcha.fn.json is not an object.');
  const name = String(f.name ?? '').toLowerCase();
  if (!NAME_RE.test(name)) throw bad('"name" must be lowercase letters, digits and "-" (max 63).');
  let { runtime, entry } = f;
  let chain = null;
  // "entry": "handler.org#respond" pulls one named block out of an org file.
  // For most runtimes the block is saved as its own file under .gitcha/.
  if (typeof entry === 'string' && /\.org#[\w-]+$/.test(entry)) {
    const [file, block] = entry.split('#');
    const text = files.get(file);
    if (!text) throw bad(`The function's org file ${file} is not in the upload.`);
    const b = orgBlocks(text.toString('utf8')).find((x) => x.name === block);
    if (!b) throw bad(`No src block named "${block}" in ${file}.`);
    if (runtime === 'orgvm') {
      entry = `${file}#${block}`; // the orgvm runner evaluates the block in its own jail
    } else {
      runtime = ORG_LANG[b.lang];
      if (!runtime) throw bad(`Block ${block} is ${b.lang}; supported: ${Object.keys(ORG_LANG).join(', ')}.`);
      entry = `.gitcha/org-${block}${{ node: '.mjs', sh: '.sh', python: '.py' }[runtime]}`;
      files.set(entry, Buffer.from(b.body));
    }
  }
  // An entry that is a TopoForge drawing makes this a chain of functions.
  if (typeof entry === 'string' && /\.topoforge\.json$/.test(entry)) {
    const text = files.get(entry);
    if (!text) throw bad(`The drawing ${entry} is not in the upload.`);
    let doc;
    try { doc = JSON.parse(text.toString('utf8')); } catch { throw bad(`${entry} is not valid JSON.`); }
    runtime = 'chain';
    chain = chainFromTopoForge(doc);
  }
  if (!RUNTIMES.includes(runtime)) throw bad(`"runtime" must be one of ${RUNTIMES.join(', ')}.`);
  if (f.image && !IMAGE_RE.test(String(f.image))) throw bad('"image" must be a container image reference such as docker.io/library/node:22-alpine.');
  if (runtime !== 'chain' && (typeof entry !== 'string' || !(files.has(entry) || (runtime === 'orgvm' && files.has(entry.split('#')[0]))))) {
    throw bad(`The entry file "${entry}" is not in the upload.`);
  }
  if (Array.isArray(f.chain)) chain = f.chain.map(String);
  if (runtime === 'chain' && !chain?.length) throw bad('A chain needs at least one function.');
  return {
    name, runtime, entry: runtime === 'chain' ? null : entry, chain,
    image: f.image ? String(f.image) : null,
    timeoutMs: parseDuration(f.timeout, 10_000, 5 * 60_000),
    memoryMb: Math.min(Math.max(Number(f.memory ?? 256), 64), 4096),
    public: Boolean(f.public),
    description: String(f.description ?? '').slice(0, 300),
  };
}
