// Hide pipeline secrets in build logs. Used by the runner (before a log line leaves the machine) and by
// the server (again, before it is stored), so a secret a step prints shows as *** instead.
// A secret is hidden whole, and each of its lines on its own too (a key file printed line by line).
// Lines shorter than 6 characters are not hidden alone: "-----" or "}" would mask half the log.

/** A function that masks `values` (the secrets' texts) in a piece of log text. */
export function secretMasker(values) {
  const parts = new Set();
  for (const v of values ?? []) {
    const s = String(v ?? '');
    if (s.length >= 4) parts.add(s);
    for (const line of s.split(/\r?\n/)) if (line.trim().length >= 6) parts.add(line.trim());
  }
  // Longest first, so a whole secret is replaced before any of its lines.
  const list = [...parts].sort((a, b) => b.length - a.length);
  if (!list.length) return (text) => text;
  return (text) => {
    let out = String(text);
    for (const p of list) if (out.includes(p)) out = out.split(p).join('***');
    return out;
  };
}

/** A secret's name: capitals, digits and _, as an environment variable. */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
