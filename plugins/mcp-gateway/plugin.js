// mcp-gateway plugin (W1 T1/T2): mounts the minimal MCP protocol subset at /mcp
// so AI Agent CLIs (claude / codex / ZCode) can operate the company directly.
// Manifest type 'middleware' among the six lifecycle types was picked because
// it is the only non-core bucket with zero built-in obligations: no ui/ dir
// to host ('ui'), no port contract to satisfy ('channel'/'provider'), no
// ordering meaning beyond default — and merely HAVING the type inserts
// nothing anywhere (unlike calling ctx.registerMiddleware, which would add us
// to the engine's outbound mask chain). http.register is the plugin's only
// side effect; it registers no port and the loader treats the prefix plainly.
import { createMcpHandler } from './server.js';
import { createToolSurface } from './tools.js';

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
    // T2 tool surface: 13 company tools over the 'companyOps' (core-engine
    // api.js operations) and 'kernelOps' (plugin enable/disable) services,
    // both looked up per call so a reload's fresh closures stay current.
    const { listTools, callTool } = createToolSurface({ services: ctx.services, log: ctx.log });
    ctx.http.register({ prefix: '/mcp', handler: createMcpHandler({ version: VERSION, listTools, callTool, log: ctx.log }) });
  },
};

