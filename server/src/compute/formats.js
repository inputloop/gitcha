// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
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
import * as shared from '../../../extension/lib/formats.js';
import { FormatError, ORG_LANG, NAME_RE } from '../../../extension/lib/formats.js';

// A container image name must start with a letter or digit. Then the launcher
// can never read it as an option like "--privileged" (FMT-2).
const IMAGE_RE = /^[A-Za-z0-9][\w./:@-]{0,199}$/;
// The kinds of function code a runner can run.
export const RUNTIMES = ['node', 'sh', 'python', 'chain', 'orgvm'];
const MAX_STEPS = 50;

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

// ---- org-mode and TopoForge --------------------------------------------------------------
// The readers live in extension/lib/formats.js, shared with the CLI, so a drawing means the same thing on
// both sides. Here they are wrapped so that a mistake in what someone wrote becomes a 400 reply (bad_spec).
const asHttp = (fn) => (...args) => {
  try { return fn(...args); } catch (err) { if (err instanceof FormatError) throw bad(err.message); throw err; }
};
export const orgBlocks = asHttp(shared.orgBlocks);
export const orgKeywords = shared.orgKeywords;
export const pipelineFromOrg = asHttp(shared.pipelineFromOrg);
export const topoOrder = asHttp(shared.topoOrder);
export const pipelineFromTopoForge = asHttp(shared.pipelineFromDrawing);
export const chainFromTopoForge = asHttp(shared.chainFromDrawing);

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
  // The secret settings the steps use, by name (their values live on the server: compute/vault.js).
  if (p.secrets !== undefined && !Array.isArray(p.secrets)) throw bad('"secrets" is a list of names, like ["APT_SIGNING_KEY"].');
  const secrets = [...new Set((p.secrets ?? []).map(String))];
  if (secrets.length > 20) throw bad('A pipeline uses at most 20 secrets.');
  for (const n of secrets) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(n)) throw bad(`Bad secret name "${n}" (capitals, digits and _).`);
    if (Object.hasOwn(env, n)) throw bad(`"${n}" is both in "env" and in "secrets".`);
  }
  return { image, timeoutMs: parseDuration(p.timeout, 10 * 60_000, maxTimeoutMs), env, steps, artifacts, deploy, on, secrets };
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
