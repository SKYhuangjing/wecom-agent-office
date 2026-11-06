// mcp-gateway plugin (W1 T1): mounts the minimal MCP protocol subset at /mcp
// so AI Agent CLIs (claude / codex / ZCode) can operate the company directly.
// Manifest type 'middleware' among the six lifecycle types was picked because
// it is the only non-core bucket with zero built-in obligations: no ui/ dir
// to host ('ui'), no port contract to satisfy ('channel'/'provider'), no
// ordering meaning beyond default — and merely HAVING the type inserts
// nothing anywhere (unlike calling ctx.registerMiddleware, which would add us
// to the engine's outbound mask chain). http.register is the plugin's only
// side effect; it registers no port and the loader treats the prefix plainly.
import { createMcpHandler } from './server.js';

const VERSION = '0.1.0';

export default {
  manifest: {
    id: 'mcp-gateway',
    name: 'MCP 网关',
    type: 'middleware',
    version: VERSION,
    requires: { kernel: '^1' },
  },

  activate(ctx) {
    // T1 ships the protocol shell only: tools/list answers an empty roster
    // and tools/call returns -32601. T2 wires the real tool surface through
    // this same factory (listTools/callTool options).
    ctx.http.register({ prefix: '/mcp', handler: createMcpHandler({ version: VERSION, log: ctx.log }) });
  },
};
