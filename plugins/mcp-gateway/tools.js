// MCP tool surface (W1 T2): the company's 19 tools exposed over /mcp —
// Chinese names/copy per README §4.2 公司话词表, dual output for every tool
// (content[].text = human-readable Chinese summary, structuredContent =
// machine payload), and consequence copy on the dangerous ones
// (offboard / department_toggle / broadcast + the W3 asset trio
// bind_asset / unbind_asset / rematerialize) so an Agent can read the impact
// back to its user before/after acting.
//
// Reuse rule (plan W1 T2): tools call the companyOps service (core-engine
// api.js operations — the SAME functions the /api routes run) and the
// kernelOps service (src/index.js plugin enable/disable — the same function
// the kernel-native /api/plugins/:id route runs). No HTTP self-calls, no
// plugin-to-plugin imports; the services container is the only broker. Both
// services are looked up PER CALL so a reload's fresh closures are always
// current.
//
// secret 红线 (§8): tool results never echo secrets. The ops themselves
// return masked/secret-free bodies (maskedBotEcho semantics); every
// structured payload is additionally run through companyOps.sanitize — the
// same recursive scrub sendJson applies — as belt-and-braces. Write paths
// (hire/update) ACCEPT secrets in arguments; they are simply never echoed.
//
// Error channel split (server.js contract): an unknown tool name or unshaped
// params throws a {jsonRpcCode: -32602} error (protocol level); anything the
// tool ran into AFTER validation — validation-copy 400s, unknown botId 404s,
// offline-broadcast 409s — comes back as a NORMAL tool result with
// isError: true, so the Agent can read and relay the reason instead of the
// client library surfacing a protocol failure.

// —— small text helpers ————————————————————————————————————————————————
const STATUS_ZH = { working: '工作中', idle: '待命', offline: '离线' };
const DEPT_STATUS_ZH = { active: '在役', disabled: '停用', failed: '故障' };

const fmt = (at) => new Date(at ?? 0).toLocaleString('sv-SE');
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : String(s ?? ''));

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  structuredContent: { ok: true, ...structured },
});
const fail = (text, structured) => ({
  content: [{ type: 'text', text }],
  structuredContent: { ok: false, ...structured },
  isError: true,
});

// Throw shapes the server maps onto JSON-RPC errors (vs. tool results).
const rpcError = (code, message) => {
  const err = new Error(message);
  err.jsonRpcCode = code;
  return err;
};
const unavailable = (message) => {
  const err = new Error(message);
  err.toolUnavailable = true;
  return err;
};

// Op-layer failures (httpError-shaped {status, message, errors?}) → isError
// tool result carrying the API's own semantics (400 校验 / 404 查无 / 409 离线广播).
const opFail = (toolName, err) => {
  const status = Number.isInteger(err?.status) ? err.status : 0;
  const message = err?.message ?? String(err);
  const lines = [`❌ 操作未完成（${status || '内部错误'}）：${message}`];
  if (Array.isArray(err?.errors) && err.errors.length > 0) lines.push(`字段问题：${err.errors.join('；')}`);
  return fail(lines.join('\n'), { tool: toolName, status: status || null, error: message, errors: err?.errors ?? undefined });
};

// Hand-rolled JSON Schema subset validation (typed/required/enum/minimum/
// additionalProperties) — zero-dependency on purpose; reject over silent fix.
function validateArgs(schema, args) {
  for (const key of schema.required ?? []) {
    if (!(key in args)) return `缺少必填参数 ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (prop == null) {
      if (schema.additionalProperties === false) return `未知参数 ${key}（本工具不接受额外字段）`;
      continue;
    }
    if (value === undefined) continue; // JSON never carries undefined; null falls through to type checks
    if (prop.type === 'string' && typeof value !== 'string') return `参数 ${key} 必须是字符串`;
    if (prop.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `参数 ${key} 必须是数字`;
    if (prop.type === 'boolean' && typeof value !== 'boolean') return `参数 ${key} 必须是布尔值`;
    if (prop.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return `参数 ${key} 必须是对象`;
    if (prop.type === 'array' && !Array.isArray(value)) return `参数 ${key} 必须是数组`;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `参数 ${key} 必须是 ${prop.enum.join(' / ')} 之一`;
    if (typeof prop.minimum === 'number' && typeof value === 'number' && value < prop.minimum) return `参数 ${key} 不能小于 ${prop.minimum}`;
  }
  return null;
}

// Per-call service lookups (reload-fresh). unavailable() marks the
// "core-engine / kernel not behind us" states — a tool result, not a crash.
const opsNow = (services) => services.get('companyOps')
  ?? (() => { throw unavailable('公司引擎服务不可用（core-engine 未激活），员工/台账相关工具暂不能使用'); })();
const kopsNow = (services) => services.get('kernelOps')
  ?? (() => { throw unavailable('内核操作服务不可用（kernelOps 未注册），部门/公司状态工具暂不能使用'); })();

// hire/update error enrichment: an "unknown channel/provider" validation
// failure is useless to a blind Agent unless it also says what IS available.
// Appended to the op's own errors (display-only; nothing rethrown or altered).
function appendPortHints(err, ops) {
  if (!Array.isArray(err?.errors)) return;
  const unknown = err.errors.some((e) => /unknown (channel|provider)/.test(String(e)));
  if (!unknown) return;
  try {
    const { channels, providers } = ops.ports();
    err.errors.push(`当前在册通道端口：${channels.map((c) => c.id).join('、') || '（无）'}；岗位端口：${providers.map((p) => p.id).join('、') || '（无）'}`);
  } catch { /* hint is best-effort */ }
}

// —— the 19 tools ———————————————————————————————————————————————————————
const TOOLS = [
  {
    name: 'list_employees',
    description: '查看在岗员工名册：全员工牌号/花名/在岗状态/离线原因/当前工作汇报进度行/今日与累计工单数/技能岗位。状态四档：working=工作中/idle=待命/offline=离线(休假)/enabled:false=休假(调休)；转述时用此词表。只读，无参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run({ services }) {
      const ops = opsNow(services);
      const { agents } = ops.agents();
      if (agents.length === 0) return ok('公司当前没有在册员工。', { agents: [] });
      const lines = [`在岗名册（${agents.length} 人）：`];
      for (const a of agents) {
        const st = a.enabled ? (STATUS_ZH[a.status] ?? a.status) : '休假';
        lines.push(`- ${a.id}（${a.name}）｜${st}｜岗位 ${a.provider}｜今日工单 ${a.todayTurns}｜累计 ${a.turns} 轮`);
        if (a.reason) lines.push(`  ↳ 离线原因：${a.reason}`);
        if (a.progress?.line) lines.push(`  ↳ 工作汇报：${clip(a.progress.line, 60)}`);
      }
      return ok(lines.join('\n'), { agents: ops.sanitize(agents) });
    },
  },
  {
    name: 'get_employee',
    description: '按工牌号查一位员工的详情：在岗状态（状态四档：working=工作中/idle=待命/offline=离线(休假)/enabled:false=休假(调休)；转述时用此词表）/离线原因/入职时间/岗位与通道/工位/门禁名单/工单统计/配置摘要。敏感值不回显（secret 类键整体省略）。只读。',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string', description: '工牌号（bot id）' } },
      required: ['botId'],
      additionalProperties: false,
    },
    run({ services, args }) {
      const ops = opsNow(services);
      const d = ops.botDetail(args.botId); // 404 → isError
      const lines = [
        `${d.bot.name}（工牌号 ${d.bot.id}）`,
        `- 状态：${d.enabled ? (STATUS_ZH[d.status] ?? d.status) : '休假'}${d.reason ? `｜离线原因：${d.reason}` : ''}`,
        `- 入职时间：${d.createdAt ? fmt(d.createdAt) : '未知'}`,
      ];
      if (d.progress?.line) lines.push(`- 工作汇报：${clip(d.progress.line, 80)}`);
      lines.push(
        `- 技能岗位：${d.bot.provider}｜通道：${d.bot.channel}`,
        `- 工位：${d.bot.providerConfig?.cwd ?? '—'}`,
        `- 门禁名单：${Array.isArray(d.bot.allowedUsers) && d.bot.allowedUsers.length > 0 ? d.bot.allowedUsers.join('、') : '不限制（任何用户可对话）'}`,
        `- 工单统计：今日 ${d.todayTurns}｜累计 ${d.turns} 轮｜服务 ${d.users} 人 / ${d.chats} 个会话`,
        `- 配置摘要（无 secret）：${JSON.stringify(ops.sanitize({ account: d.bot.account, providerConfig: d.bot.providerConfig }))}`,
      );
      return ok(lines.join('\n'), { employee: ops.sanitize(d) });
    },
  },
  {
    name: 'hire',
    description: '办理入职：提交完整 bot 档案（工牌号 id、花名 name、通道 channel 及其 account 凭证、岗位 provider 及其 providerConfig（含工位 cwd）、enabled、allowedUsers 门禁名单）。凭证字段可含 secret（只写不回显）。校验失败会逐字段列出原因并附当前在册的通道/岗位端口清单。',
    inputSchema: {
      type: 'object',
      properties: {
        bot: {
          type: 'object',
          description: '完整员工档案，即 POST /api/bots 的 bot 记录：{id,name,channel,account,provider,providerConfig,enabled?,allowedUsers?}。providerConfig 支持 progressStyle（polite 拟人播报/cot 详细汇报）与 progressText 播报文案模板。',
        },
      },
      required: ['bot'],
      // top level is closed (typos like "bots"/"record" must fail, not vanish);
      // the bot record itself stays open — its fields are validated by the
      // engine's own bot schema (validateBot), not re-declared here.
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      try {
        const { bot: created } = await ops.createBot(args.bot);
        return ok(
          `✅ 入职完成：${created.name}（工牌号 ${created.id}）已建档${created.enabled !== false ? '并上岗' : '（当前为休假状态，未连接）'}。\n建议先做一次岗前测试（probation_test）验证岗位可用。`,
          { bot: ops.sanitize(created) },
        );
      } catch (err) {
        appendPortHints(err, ops);
        throw err;
      }
    },
  },
  {
    name: 'update_employee',
    description: '更新员工档案（patch 语义）：只传要改的字段（如 name/providerConfig.progressStyle/providerConfig.progressText/account.endpoint/enabled/allowedUsers）。密码类字段留空或缺省＝保留原值；改岗位/通道或其配置会重新物化工位文件并重连。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '工牌号（bot id）' },
        patch: {
          type: 'object',
          description: '要合并的字段块，即 PATCH /api/bots/:id 的 body；未提及的字段保持不变，密码留空＝保留。',
        },
      },
      required: ['botId', 'patch'],
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      try {
        const { bot } = await ops.patchBot(args.botId, args.patch);
        return ok(
          `✅ 档案已更新：${bot.name}（工牌号 ${bot.id}）${bot.enabled !== false ? '，已重新连接生效' : '（休假中，返岗时生效）'}。`,
          { bot: ops.sanitize(bot) },
        );
      } catch (err) {
        appendPortHints(err, ops);
        throw err;
      }
    },
  },
  {
    name: 'offboard',
    description: '⚠️ 危险操作：办离职（删除该员工）。在途工作收尾后断开连接、清理物化工位文件、从名册移除；台账文件与时间线历史保留。同工牌号可重新 hire（历史台账不自动接续）。执行前务必向用户复述后果并确认。',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string', description: '工牌号（bot id）' } },
      required: ['botId'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const d = ops.botDetail(args.botId); // 404 first, and gives the name for the exit-interview copy
      await ops.deleteBot(args.botId);
      log?.info?.(`mcp: offboard bot ${args.botId}`);
      return ok(
        `👋 离职手续已办结：${d.bot.name}（工牌号 ${args.botId}）。后果说明：\n`
        + '- 在途工作已收尾：串行链排空后才断开连接，未及处理的入队消息已按维护话术答复\n'
        + '- 工位已清理：物化配置文件按岗位支持情况清理（清理失败仅记日志，不阻断离职）\n'
        + '- 档案留存：台账文件保留在 data/ledger/；时间线为本进程事件流，全员查询仍可见其历史事件；单员工查询随档案注销关闭\n'
        + '- 可重新入职：以同一工牌号重新 hire 即可（历史台账不自动接续）',
        { offboarded: { id: args.botId, name: d.bot.name } },
      );
    },
  },
  {
    name: 'set_duty',
    description: '排班切换：在岗↔调休（enabled 取反）。调休＝在途工作收尾后下线、档案保留；返岗＝重新连接上岗。',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string', description: '工牌号（bot id）' } },
      required: ['botId'],
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      const { bot } = await ops.toggleBot(args.botId);
      if (bot.enabled) {
        const d = ops.botDetail(args.botId);
        return ok(`🔋 返岗：${bot.name}（工牌号 ${bot.id}）已恢复上岗，当前状态：${STATUS_ZH[d.status] ?? d.status}。`, { bot: ops.sanitize(bot), status: d.status });
      }
      return ok(`🌴 调休：${bot.name}（工牌号 ${bot.id}）已停用——在途工作收尾后下线；档案保留，随时可返岗（再次 set_duty）。`, { bot: ops.sanitize(bot), status: 'off-duty' });
    },
  },
  {
    name: 'probation_test',
    description: '岗前测试：直连岗位运行器跑一轮（默认探针「回复：收到」，可自定义 prompt；带 sessionId 则续跑该会话）。不进引擎链、不记台账。结果 code 字段才是探针成功判据（completed＝通过），勿只看 isError——未通过也是正常应答。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '工牌号（bot id）' },
        sessionId: { type: 'string', description: '可选：续跑的原生会话 id（缺省＝新会话）' },
        prompt: { type: 'string', description: '可选：自定义测试问题（1..2000 字，缺省「回复：收到」）' },
      },
      required: ['botId'],
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      const body = {};
      if (args.sessionId !== undefined) body.sessionId = args.sessionId;
      if (args.prompt !== undefined) body.prompt = args.prompt;
      const r = await ops.testBot(args.botId, body);
      const d = ops.botDetail(args.botId);
      if (r.code === 'completed') {
        return ok(
          `✅ 岗前测试通过：${d.bot.name}（工牌号 ${args.botId}）\n- 回复：${clip(r.finalText, 200)}\n- 会话：${r.sessionId ?? '—'}\n（直连岗位运行器：不进引擎链、不记台账）`,
          { result: r },
        );
      }
      return ok(
        `⚠️ 岗前测试未通过：${d.bot.name}（工牌号 ${args.botId}）code=${r.code}\n- 失败说明：${clip(r.errorText ?? '', 300)}`,
        { result: r },
      );
    },
  },
  {
    name: 'broadcast',
    description: '⚠️ 危险操作：以某员工身份向指定会话推送广播（服务端主动推送）。内容会真实送达企业微信目标会话、无法撤回——执行前务必向用户确认会话与内容。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '播音员工（bot id）' },
        chatKey: { type: 'string', description: '目标会话 key（通道各自的寻址格式，如 wecom:group:XXX）' },
        content: { type: 'string', description: '广播内容（非空）' },
      },
      required: ['botId', 'chatKey', 'content'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const d = ops.botDetail(args.botId);
      await ops.send({ botId: args.botId, chatKey: args.chatKey, content: args.content });
      log?.info?.(`mcp: broadcast via ${args.botId} -> ${args.chatKey}`);
      return ok(
        `📢 广播已发出：${d.bot.name}（工牌号 ${args.botId}）→ 会话 ${args.chatKey}\n⚠️ 后果说明：内容已真实送达企业微信（即刻推送至目标会话，无法撤回）。`,
        { botId: args.botId, chatKey: args.chatKey },
      );
    },
  },
  {
    name: 'list_departments',
    description: '查看部门（插件）清单：id/名称/类型/版本/状态（在役/停用/故障）。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run({ services }) {
      const kops = kopsNow(services);
      const plugins = kops.plugins();
      const lines = [`部门清单（${plugins.length} 个）：`];
      for (const p of plugins) {
        const st = DEPT_STATUS_ZH[p.status] ?? p.status;
        lines.push(`- ${p.id}${p.name ? `（${p.name}）` : ''}｜${p.type ?? '?'}｜v${p.version ?? '?'}｜${st}${p.error ? `｜${clip(p.error, 80)}` : ''}`);
      }
      return ok(lines.join('\n'), { departments: plugins });
    },
  },
  {
    name: 'department_toggle',
    description: '⚠️ 危险操作：部门启停（插件 enable/disable）。停用会触发部门重组（四阶段重载：在途工作收尾→卸载→重扫→调和），依赖其通道/岗位的员工立即下线；重新启用后员工自动返岗。注意：重组会重建 MCP 会话（若下次调用收到 -32002 请重新 initialize）。执行前向用户说明受影响员工清单。',
    inputSchema: {
      type: 'object',
      properties: {
        departmentId: { type: 'string', description: '部门（插件）id，见 list_departments' },
        enabled: { type: 'boolean', description: 'true＝启用（恢复），false＝停用' },
      },
      required: ['departmentId', 'enabled'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const kops = kopsNow(services);
      // Impact BEFORE the flip: which ON-DUTY employees lose their channel/
      // provider port. Off-duty (休假) employees are already offline — counting
      // them as "taken down by this flip" would overstate the impact. null =
      // impact UNKNOWN (engine service unavailable or the tally failed); the
      // flip below is authoritative either way.
      let affected = null;
      const ops = services.get('companyOps'); // optional here — the flip itself needs no engine
      if (ops != null) {
        try {
          const { channels, providers } = ops.ports();
          const chans = channels.filter((c) => c.owner === args.departmentId).map((c) => c.id);
          const provs = providers.filter((p) => p.owner === args.departmentId).map((p) => p.id);
          affected = ops.agents().agents
            .filter((a) => a.enabled && (provs.includes(a.provider) || chans.includes(a.channel)))
            .map((a) => ({ id: a.id, name: a.name }));
        } catch { affected = null; /* impact is advisory; the flip below is authoritative */ }
      }
      log?.info?.(`mcp: department_toggle ${args.departmentId} -> ${args.enabled}`);
      const plugins = await kops.setPluginEnabled(args.departmentId, args.enabled);
      const dept = plugins.find((p) => p.id === args.departmentId) ?? null;
      if (args.enabled) {
        return ok(
          `✅ 部门恢复：${args.departmentId} 已启用（部门重组完成，当前状态：${DEPT_STATUS_ZH[dept?.status] ?? dept?.status ?? '?'}）。依赖其通道/岗位的员工将由调和机制自动返岗。`,
          { departmentId: args.departmentId, enabled: true, status: dept?.status ?? null },
        );
      }
      const impactLine = affected == null
        ? '- 影响未知（引擎不可用）：本次停用未清点受影响员工，请稍后用 list_employees 核对\n'
        : `- 影响 ${affected.length} 名员工下线${affected.length > 0 ? `：${affected.map((a) => `${a.id}（${a.name}）`).join('、')}` : ''}\n`;
      return ok(
        `⚠️ 部门停用：${args.departmentId} 已停用（部门重组完成）。\n`
        + impactLine
        + '- 在途工作已按四阶段收尾（drain → 卸载 → 重扫 → 调和）\n'
        + '- 恢复方式：再次 department_toggle（enabled=true）即可，员工自动返岗\n'
        + '- 注意：重组重建了 MCP 会话，若下次调用收到 -32002，请重新 initialize',
        { departmentId: args.departmentId, enabled: false, status: dept?.status ?? null, affectedEmployees: affected == null ? null : affected.map((a) => a.id) },
      );
    },
  },
  {
    name: 'work_log',
    description: '查工作档案（台账）：该员工的对话轮次记录（时间/会话/用户与助手内容/结束原因），可按会话过滤。文本最多列最近 20 轮，结构化内容为全量。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '工牌号（bot id）' },
        chatKey: { type: 'string', description: '可选：只看该会话（通道寻址格式）' },
      },
      required: ['botId'],
      additionalProperties: false,
    },
    run({ services, args }) {
      const ops = opsNow(services);
      const rows = ops.ledger({ bot: args.botId, chat: args.chatKey });
      if (rows.length === 0) {
        return ok(`工作档案（台账）：${args.botId}${args.chatKey ? `｜会话 ${args.chatKey}` : ''}，暂无记录。`, { botId: args.botId, chatKey: args.chatKey ?? null, turns: [] });
      }
      const shown = rows.slice(-20);
      const lines = [
        `工作档案（台账）：${args.botId}${args.chatKey ? `｜会话 ${args.chatKey}` : ''}，共 ${rows.length} 轮：`,
        ...shown.map((r) => `- [${fmt(r.at)}] ${r.chatKey ?? ''}｜${clip(r.user, 40)} → ${clip(r.assistant || '（未完成）', 60)}（${r.reason ?? '?'}）`),
      ];
      if (rows.length > shown.length) lines.push(`…仅显示最近 ${shown.length} 轮（全量见 structuredContent）`);
      return ok(lines.join('\n'), { botId: args.botId, chatKey: args.chatKey ?? null, turns: rows });
    },
  },
  {
    name: 'work_timeline',
    description: '查工作日志（时间线事件流）：run_start/step/tool/thinking/turn/run_end 事件，可限定员工与时间窗口（分钟，缺省 30）。员工离职后其历史事件仍可经全员流查询。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '可选：只看该员工（缺省＝全员）' },
        windowMin: { type: 'number', description: '可选：时间窗口（分钟，≥0，缺省 30）', minimum: 0 },
      },
      additionalProperties: false,
    },
    run({ services, args }) {
      const ops = opsNow(services);
      const windowMs = args.windowMin !== undefined ? args.windowMin * 60_000 : undefined;
      const rows = ops.timeline({ bot: args.botId, windowMs });
      const shown = rows.slice(-30);
      const lines = [
        `工作日志（时间线）${args.botId ? `：${args.botId}` : '：全员'}｜窗口：近 ${args.windowMin ?? 30} 分钟，${rows.length} 条事件：`,
        ...shown.map((r) => `- [${fmt(r.at)}] ${r.kind}｜${clip(r.text, 60)}`),
      ];
      if (rows.length > shown.length) lines.push(`…仅显示最近 ${shown.length} 条（全量见 structuredContent）`);
      return ok(lines.join('\n'), { botId: args.botId ?? null, windowMin: args.windowMin ?? 30, events: rows });
    },
  },
  {
    name: 'company_state',
    description: '公司状态摘要：运行时长、部门（在役/停用/故障计数与清单）、员工（在册/工作中/待命/离线/休假）。状态四档：working=工作中/idle=待命/offline=离线(休假)/enabled:false=休假(调休)；转述时用此词表。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run({ services }) {
      const kops = kopsNow(services);
      const plugins = kops.plugins();
      const byStatus = (s) => plugins.filter((p) => p.status === s).length;
      const lines = [
        `公司状态：运行中（已运行 ${Math.round(kops.uptimeSec() / 60)} 分钟）`,
        `- 部门：在役 ${byStatus('active')}／停用 ${byStatus('disabled')}／故障 ${byStatus('failed')}（共 ${plugins.length} 个，明细见 list_departments）`,
      ];
      const ops = services.get('companyOps');
      if (ops == null) {
        lines.push('- 员工：公司引擎服务不可用（core-engine 未激活）');
        return ok(lines.join('\n'), { uptimeSec: kops.uptimeSec(), departments: plugins, agents: [] });
      }
      const { agents } = ops.agents();
      const n = (s) => agents.filter((a) => (s === 'offduty' ? a.enabled === false : a.enabled !== false && a.status === s)).length;
      // 离线 counts ENABLED bots currently offline — the fourth bucket the old
      // line dropped (在册 ≠ 工作中+待命+休假 when anyone is offline).
      lines.push(`- 员工：在册 ${agents.length} 人（工作中 ${n('working')}／待命 ${n('idle')}／离线 ${n('offline')}／休假 ${n('offduty')}）`);
      return ok(lines.join('\n'), { uptimeSec: kops.uptimeSec(), departments: plugins, agents: ops.sanitize(agents) });
    },
  },

  // —— 资产面（W3 T1，DESIGN-ASSETS §8.1 MCP 写面分级）———————————————————
  // create 强制 origin:'mcp'（服务端盖章）→ 绑定时仅可 exclusive（§2.3 兜底，
  // 在 companyOps.bindAsset 同一校验链里）；update/delete 对配发（shared 池）
  // 资产只读——运营者资产的控制台/REST 专属；bind/unbind/rematerialize 为
  // 危险级，描述带后果确认文案，回执附 writes 清单。
  {
    name: 'create_asset',
    description: '登记公司资产（五类：skill 技能/memory 记忆/mcp/prompt 提示词/tool 工具）。经本工具创建的资产标记来源为 Agent（origin:mcp），仅可私发（exclusive）绑定；内容校验红线同 REST（名称 slug 禁点、体积上限、控制字符、MCP 仅 stdio/http 形态、URL 拒内嵌凭据）。回显不含密钥：mcp env/headers 值按位置掩码为 __MASKED__。',
    inputSchema: {
      type: 'object',
      properties: {
        asset: {
          type: 'object',
          description: '资产记录：{type:"skill"|"memory"|"mcp"|"prompt"|"tool", name, description?, content}。content 按 type 各异：skill={name,body}；mcp={servers:{id:{command,args?,env?}|{type:"http",url,headers?}}}；memory={notes:[]}；prompt={text}；tool={kind:"rtk"|"ripgrep"}。id/version/origin/createdAt 由服务端生成。',
        },
      },
      required: ['asset'],
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      const { asset } = await ops.createAsset(args.asset);
      return ok(
        `✅ 资产已登记：${asset.name}（${asset.type}，id ${asset.id}，来源 Agent）。\n`
        + '- 绑定限制：Agent 自建资产仅可私发（exclusive）绑定到单个 bot\n'
        + '- 密钥回显：mcp env/headers 值已按位置掩码（__MASKED__），库中保留原值',
        { asset: ops.sanitize(asset) },
      );
    },
  },
  {
    name: 'update_asset',
    description: '更新资产内容（patch 语义：只传要改的 name/description/content；version 自增，配发（shared）绑定的 bot 自动重物化，私发（exclusive）快照不跟随）。分级：共享（配发）资产的改动请走控制台/REST——本工具仅允许修改 Agent 自建（origin:mcp）的资产。回传 __MASKED__ 值按位置保留库中原值。',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '资产 id（ast-…）' },
        patch: { type: 'object', description: '要合并的字段块，即 PATCH /api/assets/:id 的 body' },
      },
      required: ['assetId', 'patch'],
      additionalProperties: false,
    },
    async run({ services, args }) {
      const ops = opsNow(services);
      const r = await ops.updateAsset(args.assetId, args.patch);
      const fan = r.rematerialized.length > 0
        ? `配发绑定已重物化：${r.rematerialized.join('、')}${r.failed.length > 0 ? `；失败 ${r.failed.map((f) => `${f.botId}（${f.error}）`).join('、')}` : ''}`
        : '无配发（shared）绑定需要重物化';
      return ok(
        `✅ 资产已更新：${r.asset.name} → v${r.asset.version}。\n- ${fan}`,
        { asset: ops.sanitize(r.asset), rematerialized: r.rematerialized, failed: r.failed },
      );
    },
  },
  {
    name: 'delete_asset',
    description: '删除资产：配发（shared）绑定随删除解绑并重物化清理；私发（exclusive）副本保留快照继续生效。分级：共享（配发）资产的删除请走控制台/REST——本工具仅允许删除 Agent 自建（origin:mcp）的资产。执行前务必向用户复述后果并确认。',
    inputSchema: {
      type: 'object',
      properties: { assetId: { type: 'string', description: '资产 id（ast-…）' } },
      required: ['assetId'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const r = await ops.deleteAsset(args.assetId);
      log?.info?.(`mcp: delete_asset ${args.assetId}`);
      return ok(
        `🗑️ 资产已删除：${args.assetId}。\n`
        + `- 解绑配发（shared）绑定 ${r.removedBindings} 个${r.rematerialized.length > 0 ? `，已重物化清理：${r.rematerialized.join('、')}` : ''}\n`
        + (r.keptExclusive > 0 ? `- 保留私发（exclusive）副本 ${r.keptExclusive} 个：源资产已删除，副本仍生效\n` : ''),
        { id: r.id, removedBindings: r.removedBindings, keptExclusive: r.keptExclusive, rematerialized: r.rematerialized, failed: r.failed },
      );
    },
  },
  {
    name: 'bind_asset',
    description: '⚠️ 危险操作：将资产绑定到 bot（配发 shared=同源跟随更新／私发 exclusive=绑定时刻内容快照）。将向 bot 磁盘写入技能/配置文件并重建 runner，下一轮生效。Agent 自建资产（origin:mcp）仅可私发。同名资产/同 serverId MCP/跨 bot 同文件等冲突会被拒绑并指名。执行前务必向用户复述后果并确认。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '工牌号（bot id）' },
        assetId: { type: 'string', description: '资产 id（ast-…）' },
        mode: { type: 'string', enum: ['shared', 'exclusive'], description: 'shared=配发（同源跟随更新）；exclusive=私发（内容快照）' },
      },
      required: ['botId', 'assetId', 'mode'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const r = await ops.bindAsset(args.botId, { assetId: args.assetId, mode: args.mode });
      log?.info?.(`mcp: bind_asset ${args.assetId} -> ${args.botId} (${args.mode})`);
      const modeZh = r.binding.mode === 'exclusive' ? '私发（exclusive）' : '配发（shared）';
      const lines = [
        `✅ 已绑定：${args.botId} ← ${r.binding.name}（${modeZh}）。`,
        '⚠️ 后果说明：将向 bot 磁盘写入技能/配置文件并重建 runner，下一轮生效。',
      ];
      for (const w of r.warnings ?? []) lines.push(`- ⚠️ ${w}`);
      for (const s of r.suppressed ?? []) lines.push(`- 同名单资产 ${s.assetId} 被私发副本压制（配发条目暂不生效）`);
      if (r.failed.length > 0) lines.push(`- ⚠️ 重物化失败：${r.failed.map((f) => `${f.botId}（${f.error}）`).join('、')}，可用 rematerialize 重试`);
      else if (r.skipped) lines.push('- 物化管线未装备（not-equipped）：绑定已生效，产物文件待物化管线（W3 T2）落地');
      return ok(lines.join('\n'), { receipt: ops.sanitize(r) });
    },
  },
  {
    name: 'unbind_asset',
    description: '⚠️ 危险操作：解绑 bot 的资产。将删除该 bot 盘上的资产产物；私发（exclusive）副本内容随卸载丢失。执行前务必向用户复述后果并确认。',
    inputSchema: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: '工牌号（bot id）' },
        assetId: { type: 'string', description: '资产 id（ast-…）' },
      },
      required: ['botId', 'assetId'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const r = await ops.unbindAsset(args.botId, args.assetId);
      log?.info?.(`mcp: unbind_asset ${args.assetId} from ${args.botId}`);
      const lines = [
        `✅ 已解绑：${args.botId} ← ${r.removed.name ?? args.assetId}。`,
        '⚠️ 后果说明：将删除该 bot 盘上的资产产物。',
      ];
      if (r.removed.exclusiveContentLost) lines.push('- 私发（exclusive）副本内容随卸载丢失（快照已一并移除）');
      if (r.failed.length > 0) lines.push(`- ⚠️ 清理重物化失败：${r.failed.map((f) => `${f.botId}（${f.error}）`).join('、')}`);
      return ok(lines.join('\n'), { receipt: ops.sanitize(r) });
    },
  },
  {
    name: 'rematerialize',
    description: '⚠️ 危险操作：按当前绑定强制重写该 bot 的全部资产产物文件（确定性序列化，幂等可重试；漂移修复/扇出失败重试用）。将按当前绑定重写该 bot 的全部资产产物文件。执行前务必向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string', description: '工牌号（bot id）' } },
      required: ['botId'],
      additionalProperties: false,
    },
    async run({ services, args, log }) {
      const ops = opsNow(services);
      const r = await ops.rematerialize(args.botId);
      log?.info?.(`mcp: rematerialize ${args.botId}`);
      const writes = r.writes.length > 0
        ? r.writes.map((w) => `${w.action} ${w.path}`).join('；')
        : '（物化管线未装备：writes 为空）';
      return ok(
        `✅ 已重物化：${args.botId}（写入清单：${writes}）。下一轮 run 生效。`,
        { botId: args.botId, writes: r.writes, skipped: r.skipped ?? null },
      );
    },
  },
];

// createToolSurface({services, log}) → { listTools, callTool } — the T2 seam
// server.js's createMcpHandler consumes.
export function createToolSurface({ services, log }) {
  const listTools = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  const callTool = async (params) => {
    if (params == null || typeof params !== 'object' || Array.isArray(params)) {
      throw rpcError(-32602, 'tools/call params 必须是对象（{name, arguments}）');
    }
    const { name, arguments: args = {} } = params;
    if (typeof name !== 'string' || name === '') {
      throw rpcError(-32602, 'tools/call params.name 必须是非空字符串');
    }
    const tool = TOOLS.find((t) => t.name === name);
    if (tool == null) {
      throw rpcError(-32602, `未知工具：${name}（可用工具见 tools/list）`);
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      throw rpcError(-32602, 'arguments 必须是 JSON 对象');
    }
    const problem = validateArgs(tool.inputSchema, args);
    if (problem != null) {
      return fail(`参数不符：${problem}（工具 ${name}，schema 见 tools/list）`, { tool: name, error: problem });
    }
    try {
      return await tool.run({ services, args, log });
    } catch (err) {
      if (err?.toolUnavailable) return fail(err.message, { tool: name });
      log?.error?.(`mcp: tool ${name} failed: ${err?.message ?? err}`);
      return opFail(name, err);
    }
  };

  return { listTools, callTool };
}
