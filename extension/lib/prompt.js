// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Terminal prompts, including hidden input for passwords.
import readline from 'node:readline';

// When stdin is piped (scripts, tests) share one line reader across prompts,
// otherwise each readline interface would swallow the remaining buffered lines.
let piped = null;
function nextPipedLine(input) {
  if (!piped) {
    const rl = readline.createInterface({ input, terminal: false });
    piped = { lines: [], waiters: [], done: false };
    rl.on('line', (l) => (piped.waiters.length ? piped.waiters.shift()(l) : piped.lines.push(l)));
    rl.on('close', () => { piped.done = true; for (const w of piped.waiters.splice(0)) w(null); });
  }
  if (piped.lines.length) return Promise.resolve(piped.lines.shift());
  if (piped.done) return Promise.resolve(null);
  return new Promise((r) => piped.waiters.push(r));
}

export async function ask(question, { hidden = false, input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    output.write(question);
    const line = await nextPipedLine(input);
    output.write('\n');
    if (line === null) throw new Error('No input available.');
    return line.trim();
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question) || s === '\r\n' || s === '\n') output.write(s); };
    }
    rl.on('SIGINT', () => { rl.close(); output.write('\n'); reject(new Error('Cancelled.')); });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) output.write('\n');
      resolve(answer.trim());
    });
  });
}
