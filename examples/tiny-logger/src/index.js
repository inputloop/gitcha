// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', name = 'app', out = console } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl) => (...args) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${name}]`;
    (out[lvl] ?? out.log)(line, ...args);
  };
  return Object.fromEntries(Object.keys(LEVELS).map((l) => [l, log(l)]));
}
