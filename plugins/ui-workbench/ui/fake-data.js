// Harness fake data (M3 T2/T3 截图工作流): the exact shapes the pages consume —
// /api/agents summaries, sanitized /api/bots records (account.secret 刻意缺席:
// 编辑器不回显 secret, 这是红线), /api/ports with the REAL schema shapes
// copied from channel-wecom + provider-dsh/claude/codex so the form rendering
// is exercised against production schema text. The stub's api() is
// method-blind (keyed by path only, query included) — '/api/bots' branches on
// body presence: GET (no body) → the list, anything with a body → a saved-
// record echo. T3 adds ledger rows (chat-list source for session+push), a
// native session history, the kernel plugin list and timeline rows.
const now = Date.now();
const minAgo = (m) => now - m * 60_000;

export const FAKE_LEDGER = [
  {
    seq: 1, at: minAgo(180), chatKey: 'wecom:group:G1', channel: 'wecom', chatKind: 'group',
    chatid: 'G1', userid: 'zhangsan', user: '帮我看下今天的构建为什么失败',
    assistant: '构建失败原因是单测 hanging_test 超时，我已把超时上限调到 60s 并重跑通过。',
    provider: 'dsh', sessionId: 'sess-a1b2c3d4', ok: true, reason: 'completed', tokens: null, cost: null,
  },
  {
    seq: 2, at: minAgo(120), chatKey: 'wecom:group:G1', channel: 'wecom', chatKind: 'group',
    chatid: 'G1', userid: 'zhangsan', user: '继续跑一遍全量',
    assistant: '', provider: 'dsh', sessionId: 'sess-a1b2c3d4', ok: false, reason: 'interrupted', tokens: null, cost: null,
  },
  {
    seq: 3, at: minAgo(90), chatKey: 'wecom:group:G1', channel: 'wecom', chatKind: 'group',
    chatid: 'G1', userid: 'zhangsan', user: '再试一次，只跑受影响的用例',
    assistant: '正在定位受影响用例……（超时前部分输出）', provider: 'dsh', sessionId: 'sess-a1b2c3d4',
    ok: false, reason: 'timeout', tokens: null, cost: null,
  },
  {
    seq: 4, at: minAgo(40), chatKey: 'wecom:single:lisi', channel: 'wecom', chatKind: 'single',
    chatid: 'lisi', userid: 'lisi', user: '帮我总结本周周报',
    assistant: '本周完成：台账页、推送页与时间线页的开发与自测；遗留：盲评两条例外。',
    provider: 'dsh', sessionId: 'sess-9f8e7d6c', ok: true, reason: 'completed', tokens: null, cost: null,
  },
];

export const FAKE_SESSION = {
  turns: [
    { user: '帮我看下今天的构建为什么失败', assistant: '构建失败原因是单测 hanging_test 超时，我已把超时上限调到 60s 并重跑通过。', at: minAgo(180) },
    { user: '继续跑一遍全量', assistant: '（该轮被新消息打断，无完整输出）', at: minAgo(120) },
    { user: '再试一次，只跑受影响的用例', assistant: '正在定位受影响用例……（超时前部分输出）', at: minAgo(90) },
  ],
  truncated: true,
  // 盲评 P2-1 基线：provider 的原生英文警告（session file not found: <绝对路径>），
  // 页面渲染时应映射成人话（只保留文件名）。
  warnings: ['session file not found: /Users/sky/work/main/.dsh/sessions/rollout-2026-11-05-no-such-session.jsonl'],
};

export const FAKE_PLUGINS = [
  { id: 'core-engine', name: 'Core Engine', type: 'core', version: '0.1.0', status: 'active' },
  { id: 'channel-wecom', name: 'Channel WeCom', type: 'channel', version: '0.1.0', status: 'active' },
  { id: 'provider-dsh', name: 'Provider DSH', type: 'provider', version: '0.1.0', status: 'active' },
  { id: 'provider-claude', name: 'Provider Claude', type: 'provider', version: '0.1.0', status: 'active' },
  { id: 'provider-codex', name: 'Provider Codex', type: 'provider', version: '0.1.0', status: 'disabled' },
  { id: 'ui-workbench', name: 'UI Workbench', type: 'ui', version: '0.1.0', status: 'active' },
  { id: 'ui-office3d', name: 'UI Office 3D', type: 'ui', version: '0.1.0', status: 'active' },
  { id: 'progressor-emoji', name: 'Progressor Emoji', type: 'progressor', version: '0.1.0', status: 'failed', error: 'import failed: Unexpected token \'export\'' },
];

// Chronological (oldest-first), matching the /api/timeline contract the page
// reverses for newest-on-top — the stub serves the array verbatim.
export const FAKE_TIMELINE = [
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'run_start', text: '', at: minAgo(12) },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'thinking', text: '先看 CI 日志定位失败用例，再对照昨天的改动范围判断是否回归。', at: minAgo(12) + 4000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'tool', text: '读取 ci-logs/latest.txt', at: minAgo(12) + 9000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'step', text: '', at: minAgo(12) + 15000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'turn', text: '帮我看下今天的构建为什么失败 → 构建失败原因是单测 hanging_test 超时，我已把超时上限调到 60s 并重跑通过。', at: minAgo(11) },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'run_end', text: '', at: minAgo(11) + 1000 },
  { botId: 'bot-2', chatKey: 'wecom:single:wangwu', kind: 'run_start', text: '', at: minAgo(9) },
  { botId: 'bot-2', chatKey: 'wecom:single:wangwu', kind: 'tool', text: '检索 schedule.json 第 41-80 行', at: minAgo(9) + 5000 },
  { botId: 'bot-2', chatKey: 'wecom:single:wangwu', kind: 'thinking', text: '这份周报要覆盖 M3 的六个页面插件交付，按页罗列风险与验证方式。', at: minAgo(3) },
].sort((a, b) => a.at - b.at);

export const FAKE = {
  agents: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, status: 'working',
      provider: 'dsh', channel: 'wecom',
      progress: { line: '🔧 正在修复 plugins/core-engine/api.js 的测试用例' },
      todayTurns: 12, users: 3, chats: 2, reason: null,
    },
    {
      id: 'bot-2', name: '二号机器人', enabled: true, status: 'offline',
      provider: 'claude', channel: 'wecom',
      progress: null, todayTurns: 0, users: 0, chats: 0,
      reason: 'provider claude 已禁用（插件停用或加载失败）',
    },
    {
      // 盲评 P2-4 基线：已停用 + provider 插件（codex，见 FAKE_PLUGINS）已停用的
      // bot——无离线 reason，卡片靠 providerMissing 橙点给出信号。
      id: 'bot-3', name: '归档机器人', enabled: false, status: 'offline',
      provider: 'codex', channel: 'wecom', providerMissing: true,
      progress: null, todayTurns: 0, users: 0, chats: 0, reason: null,
    },
  ],
  bots: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, channel: 'wecom',
      account: { botId: '1000002', wsUrl: 'wss://openws.work.weixin.qq.com' },
      provider: 'dsh', createdAt: now - 62 * 24 * 3600_000, // 入职两个月
      providerConfig: { cwd: '/Users/sky/work/main', permission: 'workspace-write', progressCoT: true },
    },
    {
      id: 'bot-2', name: '二号机器人', enabled: true, channel: 'wecom',
      account: { botId: '1000003' },
      provider: 'claude', createdAt: now - 9 * 24 * 3600_000,
      providerConfig: { cwd: '/Users/sky/work/bot2', progressCoT: true },
    },
    {
      id: 'bot-3', name: '归档机器人', enabled: false, channel: 'wecom',
      account: { botId: '1000004' },
      provider: 'codex', createdAt: now - 200 * 24 * 3600_000, // 老员工：createdAt 后补的规则之前入职
      providerConfig: { cwd: '/Users/sky/work/bot3' },
    },
  ],
  ports: {
    channels: [
      {
        id: 'wecom',
        owner: 'channel-wecom',
        accountSchema: [
          { key: 'botId', label: '机器人 ID', type: 'string', required: true },
          { key: 'secret', label: '机器人 Secret', type: 'password', required: true },
          { key: 'wsUrl', label: 'WebSocket 地址（默认官方，测试可指本地）', type: 'string', default: 'wss://openws.work.weixin.qq.com' },
        ],
      },
    ],
    providers: [
      {
        id: 'dsh',
        owner: 'provider-dsh',
        configSchema: [
          { key: 'cwd', label: '工作目录（agent 作业目录，也是沙箱 workspaceRoot）', type: 'string', required: true },
          { key: 'profile', label: 'dsh profile 名（默认 wecom-<botId>）', type: 'string' },
          { key: 'model', label: '模型 {provider, model, baseURL?, api?, apiKeyEnv?, apiKey?, contextWindow?, maxTokens?}', type: 'object' },
          { key: 'permission', label: '权限', type: 'enum', options: ['workspace-write', 'read-only', 'danger-full-access'], default: 'workspace-write' },
          { key: 'prompt', label: '人设（多行，写入 profile system-prompt personaPrefix）', type: 'string' },
          { key: 'writableDirs', label: '沙箱额外可写目录（绝对路径列表）', type: 'list' },
          { key: 'compaction', label: '自动压缩 {enabled?, thresholdRatio?, headroomTokens?, retainRatio?}', type: 'object' },
          { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
          { key: 'dshBin', label: 'dsh 可执行文件（PATH 或绝对路径）', type: 'string', default: 'dsh' },
          { key: 'nodeBin', label: 'node 可执行文件（profile 引导 PATH 用）', type: 'string' },
        ],
      },
      {
        id: 'claude',
        owner: 'provider-claude',
        configSchema: [
          { key: 'cwd', label: '工作目录（claude 按其 realpath 定位会话历史）', type: 'string', required: true },
          { key: 'model', label: '模型 {model, baseURL?, apiKey?, apiKeyEnv?}（baseURL→ANTHROPIC_BASE_URL，apiKey→ANTHROPIC_AUTH_TOKEN 或 apiKeyEnv）', type: 'object' },
          { key: 'permissionMode', label: '权限模式（--permission-mode）', type: 'enum', options: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], default: 'default' },
          { key: 'allowedTools', label: '允许的工具（列表，逗号拼接传 --allowedTools）', type: 'list' },
          { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
          { key: 'prompt', label: '人设（多行，--append-system-prompt）', type: 'string' },
          { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
          { key: 'claudeBin', label: 'claude 可执行文件（PATH 或绝对路径）', type: 'string', default: 'claude' },
          { key: 'claudeConfigDir', label: 'claude 配置目录（默认 ~/.claude，会话历史所在）', type: 'string' },
        ],
      },
      {
        id: 'codex',
        owner: 'provider-codex',
        configSchema: [
          { key: 'cwd', label: '工作目录（codex 作业目录，也是会话 rollout 的归属）', type: 'string', required: true },
          { key: 'model', label: '模型 {model}（→ -m；网关 baseURL 走 configOverrides 的 openai_base_url=…）', type: 'object' },
          { key: 'sandbox', label: '沙箱模式（新会话传 -s；续接轮自动改传 -c sandbox_mode=…）', type: 'enum', options: ['read-only', 'workspace-write', 'danger-full-access'] },
          { key: 'configOverrides', label: '运行时配置覆盖（列表，每项 key=value）', type: 'list' },
          { key: 'apiKeyEnv', label: '凭证环境变量名', type: 'string', default: 'CODEX_API_KEY' },
          { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
          { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
          { key: 'codexBin', label: 'codex 可执行文件（PATH 或绝对路径）', type: 'string', default: 'codex' },
          { key: 'codexHome', label: 'codex 配置目录（默认 ~/.codex；注入 $CODEX_HOME）', type: 'string' },
        ],
      },
    ],
  },
};

const echoBot = (base) => (body) => ({
  bot: { ...base, ...(body && typeof body === 'object' ? body : {}) },
});

// enable/disable echoes flip the one plugin (four-phase reload is kernel
// behavior; the harness only needs the list shape the page re-renders from).
const flipPlugin = (id) => () => ({
  ok: true,
  plugins: FAKE_PLUGINS.map((p) => (p.id === id ? { ...p, status: p.status === 'active' ? 'disabled' : 'active' } : p)),
});

export const FAKE_API = {
  '/api/ports': FAKE.ports,
  // Method-blind branch: GET (no body) → list; POST/PATCH (body) → saved echo
  // (create echoes a server-stamped createdAt — same shape as the kernel).
  '/api/bots': (body) => (body === undefined
    ? { bots: FAKE.bots }
    : echoBot({ ...FAKE.bots[0], id: body.id ?? 'new-bot', createdAt: Date.now() })(body)),
  '/api/bots/main-bot': echoBot(FAKE.bots[0]),
  '/api/bots/bot-2': echoBot(FAKE.bots[1]),
  '/api/bots/main-bot/toggle': () => ({ bot: FAKE.bots[0] }),
  '/api/bots/bot-2/toggle': () => ({ bot: FAKE.bots[1] }),
  '/api/bots/main-bot/test': () => ({
    code: 'completed', finalText: '收到', sessionId: 'sess-a1b2c3d4', events: 6,
  }),
  '/api/bots/bot-2/test': () => ({
    code: 'error', finalText: '', sessionId: null, events: 0,
    errorText: 'provider claude 已禁用（插件停用或加载失败）',
  }),
  // —— T3 pages ————————————————————————————————————————————————
  '/api/ledger?bot=main-bot': FAKE_LEDGER,
  '/api/ledger?bot=bot-2': [],
  '/api/ledger?bot=bot-3': [],
  '/api/session?bot=main-bot&session=sess-a1b2c3d4': FAKE_SESSION,
  '/api/send': () => ({ ok: true }),
  '/api/plugins': { plugins: FAKE_PLUGINS },
  '/api/plugins/provider-codex/enable': flipPlugin('provider-codex'),
  '/api/plugins/provider-claude/disable': flipPlugin('provider-claude'),
  '/api/service/reload': () => ({ ok: true }),
};
