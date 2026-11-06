// Harness fake data (M3 T2 截图工作流): the exact shapes the pages consume —
// /api/agents summaries, sanitized /api/bots records (account.secret 刻意缺席:
// 编辑器不回显 secret, 这是红线), /api/ports with the REAL schema shapes
// copied from channel-wecom + provider-dsh/claude/codex so the form rendering
// is exercised against production schema text. The stub's api() is
// method-blind (keyed by path only) — '/api/bots' branches on body presence:
// GET (no body) → the list, anything with a body → a saved-record echo.
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
  ],
  bots: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, channel: 'wecom',
      account: { botId: '1000002', wsUrl: 'wss://openws.work.weixin.qq.com' },
      provider: 'dsh',
      providerConfig: { cwd: '/Users/sky/work/main', permission: 'workspace-write', progressCoT: true },
    },
    {
      id: 'bot-2', name: '二号机器人', enabled: true, channel: 'wecom',
      account: { botId: '1000003' },
      provider: 'claude',
      providerConfig: { cwd: '/Users/sky/work/bot2', progressCoT: true },
    },
  ],
  ports: {
    channels: [
      {
        id: 'wecom',
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

export const FAKE_API = {
  '/api/ports': FAKE.ports,
  // Method-blind branch: GET (no body) → list; POST/PATCH (body) → saved echo.
  '/api/bots': (body) => (body === undefined
    ? { bots: FAKE.bots }
    : echoBot({ ...FAKE.bots[0], id: body.id ?? 'new-bot' })(body)),
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
};
