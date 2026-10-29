// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Rules for gitcha.json, the package manifest (the file that names a package and its version).
// The server and the client share this file, so both check packages the same way.
export const MANIFEST_FILE = 'gitcha.json';
// A package name: 1 to 64 characters, lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** NAME_RE also allows "constructor", which every JavaScript object already has. That is not a package name. */
export const isPackageName = (name) => typeof name === 'string' && NAME_RE.test(name) && !(name in Object.prototype);
// A semantic version (semver), such as 1.2.3 or 1.2.3-beta.1. No leading zeros.
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

// Check a parsed gitcha.json. Returns a list of error messages, empty when the manifest is fine.
// "files" entries must stay inside the project, so a package cannot pack files from elsewhere.
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['gitcha.json must be a JSON object'];
  if (!isPackageName(m.name ?? '')) errors.push('"name" must be lowercase letters, digits, ".", "_" or "-" (max 64), and not a word every JavaScript object already has');
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

// Sort helper for versions: negative if a comes first, positive if b does.
// A prerelease (1.0.0-beta) sorts before the plain release (1.0.0). Prerelease tags compare as text.
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

/** The highest version that is not yanked and not a prerelease. If there is none, the highest prerelease. */
export function latestVersion(versions) {
  const live = versions.filter((v) => !v.yanked).map((v) => v.version).sort(compareVersions);
  const stable = live.filter((v) => !v.includes('-'));
  return (stable.length ? stable : live).at(-1) ?? null;
}
