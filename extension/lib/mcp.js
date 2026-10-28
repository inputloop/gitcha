// Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
import readline from 'node:readline';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createMcpServer({ name, version, instructions, tools, input = process.stdin, output = process.stdout }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const protocolVersion = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name, version }, instructions });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map(({ name: n, title, description, inputSchema, annotations }) => ({ name: n, title, description, inputSchema, annotations })),
        });
      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tool.handler(params.arguments ?? {});
          return reply(id, typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result);
        } catch (err) {
          return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        if (method?.startsWith('notifications/') || !isRequest) return undefined;
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    handle,
    listen() {
      const rl = readline.createInterface({ input, terminal: false });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
        handle(msg).catch((err) => msg.id !== undefined && fail(msg.id, -32603, err.message));
      });
      return rl;
    },
  };
}
