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
    // Plugin options schema (plugins.json → plugins['mcp-gateway'].options),
    // same item shape as a provider configSchema. dangerousTools (security
    // audit P1-5): default true keeps the dangerous 7 callable; false makes
    // their callTool answer isError with an admin-disabled notice — the
    // read-only tools (roster/detail/log/state/…) stay available either way.
    config: {
      dangerousTools: { type: 'bool', default: true, label: '允许 AI Agent 执行高危操作（离职/广播/资产变更/部门启停）' },
    },
  },

  activate(ctx) {
    // T2 tool surface: 13 company tools over the 'companyOps' (core-engine
    // api.js operations) and 'kernelOps' (plugin enable/disable) services,
    // both looked up per call so a reload's fresh closures stay current.
    const dangerousTools = ctx.config?.dangerousTools !== false;
    const { listTools, callTool } = createToolSurface({ services: ctx.services, log: ctx.log, dangerousTools });
    ctx.http.register({ prefix: '/mcp', handler: createMcpHandler({ version: VERSION, listTools, callTool, log: ctx.log }) });
  },
};

