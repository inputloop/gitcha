// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// The gitcha.json package manifest, shared by the server and the client.
export const MANIFEST_FILE = 'gitcha.json';
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['gitcha.json must be a JSON object'];
  if (!NAME_RE.test(m.name ?? '')) errors.push('"name" must be lowercase letters, digits, ".", "_" or "-" (max 64)');
  if (!VERSION_RE.test(m.version ?? '')) errors.push('"version" must be a semantic version like 1.2.3');
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 500)) {
    errors.push('"description" must be a string of at most 500 characters');
  }
  if (m.license !== undefined && typeof m.license !== 'string') errors.push('"license" must be an SPDX identifier string');
  if (m.team !== undefined && !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(m.team)) errors.push('"team" must be a team name');
  if (m.private !== undefined && typeof m.private !== 'boolean') errors.push('"private" must be true or false');
  if (m.private && !m.team) errors.push('"private" packages must belong to a team (set "team")');
  if (m.files !== undefined && !(Array.isArray(m.files) && m.files.every((f) => typeof f === 'string'))) {
    errors.push('"files" must be an array of paths');
  } else if (m.files?.some((f) => !f || f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split(/[\\/]/).includes('..'))) {
    errors.push('"files" entries must be paths inside the project (no "..", no leading "/")');
  }
  return errors;
}

export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a), pb = VERSION_RE.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return (pa[4] ?? '').localeCompare(pb[4] ?? '');
}

/** Highest non-yanked, non-prerelease version (falls back to prereleases). */
export function latestVersion(versions) {
  const live = versions.filter((v) => !v.yanked).map((v) => v.version).sort(compareVersions);
  const stable = live.filter((v) => !v.includes('-'));
  return (stable.length ? stable : live).at(-1) ?? null;
}
