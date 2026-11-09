// mcp-gateway plugin (W1 T1/T2): mounts the minimal MCP protocol subset at /mcp
// so AI Agent CLIs (claude / codex / ZCode) can operate the company directly.
// Manifest type 'middleware' among the six lifecycle types was picked because
// it is the only non-core bucket with zero built-in obligations: no ui/ dir
// to host ('ui'), no port contract to satisfy ('channel'/'provider'), no
// ordering meaning beyond default — and merely HAVING the type inserts
// nothing anywhere (unlike calling ctx.registerMiddleware, which would add us
// to the engine's outbound mask chain). http.register is the plugin's only
// side effect; it registers no port and the loader treats the prefix plainly.
//
// v2 AI-access discovery: a second route /api/mcp (longer prefix, wins over
// core-engine's /api catch-all) feeds the console's onboarding UI — session
// count, tool roster, and the repo's Agent skill doc (docs/skills/
// wao-company.md, read per request; a packaged install without the repo docs
// tree answers 404 honestly instead of pretending).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from './server.js';
import { createToolSurface, toolRoster } from './tools.js';

const VERSION = '0.1.0';
const SKILL_DOC = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/skills/wao-company.md');

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
      dangerousTools: { type: 'bool', default: true, label: '允许 AI Agent 执行高危操作（删除/推送/资产变更/插件启停）' },
    },
  },

  activate(ctx) {
    // T2 tool surface: 13 company tools over the 'companyOps' (core-engine
    // api.js operations) and 'kernelOps' (plugin enable/disable) services,
    // both looked up per call so a reload's fresh closures stay current.
    const dangerousTools = ctx.config?.dangerousTools !== false;
    const { listTools, callTool } = createToolSurface({ services: ctx.services, log: ctx.log, dangerousTools });
    const { handler, sessionCount } = createMcpHandler({ version: VERSION, listTools, callTool, log: ctx.log });
    ctx.http.register({ prefix: '/mcp', handler });

    // Console status face (GET /api/mcp · GET /api/mcp/skill). Read-only; the
    // UI's api() carries WAO_TOKEN so this sits behind the same auth gate as
    // every other /api route when the operator set one.
    const dangerousByName = new Map(toolRoster().map((t) => [t.name, t.dangerous]));
    const json = (res, code, obj, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    ctx.http.register({
      prefix: '/api/mcp', handler: (req, res) => {
        // Prefix bleed guard (shell matches startsWith): only our two exact
        // paths answer; anything else under the prefix is a plain 404.
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname !== '/api/mcp' && pathname !== '/api/mcp/' && pathname !== '/api/mcp/skill') {
          req.resume();
          return json(res, 404, { error: 'not found' });
        }
        if (req.method !== 'GET') {
          req.resume(); // drain any body so keep-alive sockets stay reusable
          return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        }
        req.resume();
        if (pathname === '/api/mcp/skill') {
          let content = null;
          try { content = readFileSync(SKILL_DOC, 'utf8'); } catch { content = null; /* honest 404 below */ }
          if (content == null) {
            return json(res, 404, { error: `skill 文件未找到（${SKILL_DOC}）——请从仓库 docs/skills/wao-company.md 获取` });
          }
          return json(res, 200, { ok: true, filename: 'wao-company.md', content });
        }
        return json(res, 200, {
          ok: true,
          endpoint: '/mcp',
          sessions: sessionCount(),
          tools: listTools().map(({ name, description }) => ({
            name, description, dangerous: dangerousByName.get(name) === true,
          })),
        });
      },
    });
  },
};
