// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Asks the user questions in the terminal for the CLI, such as "Password:" or a 6-digit code.
// Passwords are read in raw mode (the program gets each key press itself) with no echo, so they never show.
import readline from 'node:readline';

// When stdin is piped (scripts, tests), all prompts share one line reader.
// Otherwise each new readline reader would swallow the lines still waiting in the buffer.
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

/**
 * Read a secret from a terminal in raw mode. Nothing is echoed and nothing is redrawn, so Backspace cannot make
 * readline print what was typed. Backspace and Ctrl-U edit what was typed. Arrow keys and other escape sequences
 * (the multi-character codes a terminal sends for special keys) are ignored. Ctrl-C cancels, Enter ends.
 */
function readHidden(question, input, output) {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let buf = [];
    let esc = 0; // 0 plain, 1 just after ESC, 2 inside a CSI/SS3 sequence
    const finish = (fn, value) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      try { input.setRawMode(wasRaw); } catch { /* terminal went away */ }
      input.pause();
      output.write('\n');
      fn(value);
    };
    const onEnd = () => finish(reject, new Error('No input available.'));
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (esc === 1) { esc = ch === '[' || ch === 'O' ? 2 : 0; continue; }
        if (esc === 2) { if (ch >= '@' && ch <= '~') esc = 0; continue; }
        if (ch === '\x1b') { esc = 1; continue; }
        if (ch === '\r' || ch === '\n') return finish(resolve, buf.join('').trim());
        if (ch === '\x03') return finish(reject, new Error('Cancelled.'));
        if (ch === '\x04') { if (buf.length === 0) return finish(reject, new Error('No input available.')); continue; }
        if (ch === '\x7f' || ch === '\b') { buf.pop(); continue; }
        if (ch === '\x15') { buf = []; continue; }
        if (ch >= ' ') buf.push(ch);
      }
    };
    input.on('data', onData);
    input.on('end', onEnd);
  });
}

/**
 * Ask a question and return the trimmed answer. With `hidden`, typed keys are not shown (for passwords).
 * Questions go to stderr by default, so stdout stays clean for output that scripts read.
 */
export async function ask(question, { hidden = false, input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    output.write(question);
    const line = await nextPipedLine(input);
    output.write('\n');
    if (line === null) throw new Error('No input available.');
    return line.trim();
  }
  if (hidden) return readHidden(question, input, output);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    rl.on('SIGINT', () => { rl.close(); output.write('\n'); reject(new Error('Cancelled.')); });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
