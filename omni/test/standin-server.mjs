// SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// A stand-in stdio MCP server for the gateway tests: a "memory seat" with two tools, one of which echoes the
// arguments and the process's environment marker, so a test can see which child answered and with what.
import { createMcpServer } from '../lib/mcp.js';

const seat = process.env.STANDIN_NAME ?? 'seat';
let notes = [];
createMcpServer({
  name: `standin-${seat}`, version: '1.0', instructions: 'a stand-in',
  tools: [
    { name: 'note_write', description: 'write a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      handler: async ({ text }) => { notes.push(text); return `${seat}: wrote generation ${notes.length}`; } },
    { name: 'note_list', description: 'list notes', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ content: [{ type: 'text', text: notes.join('\n') || '(none)' }] }) },
    { name: 'boom', description: 'fail', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async () => { throw new Error('as asked'); } },
  ],
}).listen();
