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

// 资产科 (W3 T4)：/api/assets 清单行（mcp env/headers 是位置掩码 __MASKED__ 的
// 剥敏回显——红线：假数据也不放明文机密）+ bots 的 assets 绑定摘要（§2.2 形状：
// 无 content；exclusive 带 snapshotVersion/exclusiveBehind/sourceDeleted）+
// agents 的 assetWarnings/assetTools（后者=manifest.tools 装备态回显 §7.1/§7.2：
// bot-2 的 rg 已装备、rtk 二进制缺失 unavailable——装备台两种徽章都有基线）。
// ast-rtk09 刻意不在清单里——它是已下架资产的私发快照
// （源删除后快照独立生效，§3.2 DELETE row）。
export const FAKE_ASSETS = [
  {
    id: 'ast-skl001', type: 'skill', name: 'wao-company', description: '话术与台账规范',
    content: { name: 'wao-company', description: '回复前先查台账；术语对照见 README §4.2', body: '# WAO 使用规范\n\n1. 回复前先查台账\n2. 界面用标准术语，技术词进 tooltip\n' },
    origin: 'operator', version: 3, createdAt: now - 12 * 24 * 3600_000, updatedAt: minAgo(3000), bindings: 1,
  },
  {
    id: 'ast-mcp002', type: 'mcp', name: 'gateway', description: 'MCP 网关（stdio + http 各一）',
    content: {
      servers: {
        company: { command: 'node', args: ['server.js'], env: { TOKEN: '__MASKED__', NOTE: '__MASKED__' } },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-K': '__MASKED__' } },
      },
    },
    origin: 'mcp', version: 2, createdAt: minAgo(7200), updatedAt: minAgo(90), bindings: 1,
  },
  {
    id: 'ast-mem003', type: 'memory', name: 'team-notes', description: '团队记事本（发版窗口/周报模板）',
    content: { notes: ['周报模板：本周完成 / 下周计划 / 风险', '发版窗口：周四 14:00', '值班表在 ops/oncall.md，改动先打招呼'] },
    origin: 'operator', version: 2, createdAt: now - 30 * 24 * 3600_000, updatedAt: minAgo(2880), bindings: 1,
  },
  {
    id: 'ast-rg004', type: 'tool', name: 'rg-guide', description: 'ripgrep 代码检索指引（预检 rg 在位）',
    content: { kind: 'ripgrep' },
    origin: 'operator', version: 1, createdAt: minAgo(5000), updatedAt: minAgo(4800), bindings: 1,
  },
  {
    // scope-recall（B 产品化）：资产库第三件工具资产基线——检索式长期记忆
    // （不进向导默认装备包，记忆条数逼近上限时推荐升级）。
    id: 'ast-sr005', type: 'tool', name: 'scope-recall', description: '检索式长期记忆（hermes-scope-recall）：hooks 自动召回+原文溯源——记忆规模升级项，v1 仅 claude 引擎',
    content: { kind: 'scope-recall' },
    origin: 'plugin', version: 1, createdAt: minAgo(2400), updatedAt: minAgo(2400), bindings: 0,
  },
  {
    // 知识资产模块（DESIGN-KNOWLEDGE）：业务记忆样例（含版本历史元数据——
    // 清单表/知识 tab/回滚面的数据源）。
    id: 'ast-mem010', type: 'memory', name: 'biz-memory', description: '业务记忆（SLS 查询口径/租户映射）',
    content: { notes: [
      '查某业务日志 → 用 MCP 工具 mcp__oneaix-sls__sls_execute_sql，project=k8s-log-onedata-prod，时间范围 now-1h',
      '舱位捕手租户 202438 → monitorId 925（join 查询口径），聚合查询 limit≤100',
      '运价日志 logStore=timp；聚合优先、禁裸翻页',
      'SLS 查询预算 ≤8 次/轮，先聚合后下钻',
    ] },
    origin: 'operator', version: 2, createdAt: now - 20 * 24 * 3600_000, updatedAt: minAgo(2880), bindings: 1,
    history: [{ version: 1, at: minAgo(4300), via: 'distill' }],
  },
  {
    // AI 整理轮产物样例（origin:curation）：知识 tab 技能区/版本回滚面基线。
    id: 'ast-skl010', type: 'skill', name: 'sls-playbook', description: 'SLS 日志查询手册（AI 整理轮沉淀）',
    content: { name: 'sls-playbook', description: '什么时候查 SLS、用什么工具、什么参数——查询手册', body: '# SLS 日志查询手册\n\n1. 优先聚合查询（count/sum），禁裸翻页\n2. 单轮查询预算 ≤8 次\n3. 租户→monitorId 映射先查记忆再发查询\n' },
    origin: 'curation', version: 2, createdAt: minAgo(600), updatedAt: minAgo(600), bindings: 1,
    history: [{ version: 1, at: minAgo(700), via: 'curation' }],
  },
];

export const FAKE = {
  agents: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, status: 'working',
      provider: 'dsh', channel: 'wecom',
      progress: { line: '🔧 正在修复 plugins/core-engine/api.js 的测试用例' },
      todayTurns: 12, users: 3, chats: 2, reason: null,
      assetWarnings: [],
    },
    {
      id: 'bot-2', name: '二号机器人', enabled: true, status: 'offline',
      provider: 'claude', channel: 'wecom',
      progress: null, todayTurns: 0, users: 0, chats: 0,
      reason: '引擎 claude 已停用（插件停用或加载失败）',
      assetWarnings: [
        'memory 共享 cwd：跨会话记忆可能被同目录其他会话互见',
        'rtk 已绑定但二进制不可用（rtk 未安装或不在 PATH）——配置暂未生效，绑定保留',
      ],
      // manifest.tools 装备态回显：rg 预检在位（available）、rtk 二进制缺失
      // （unavailable）——装备台「装备态」列两种徽章的基线。
      assetTools: [
        { assetId: 'ast-rg004', kind: 'ripgrep', state: 'available', version: 'ripgrep 14.1.1' },
        { assetId: 'ast-rtk09', kind: 'rtk', state: 'unavailable' },
      ],
      lastMaterializedAt: minAgo(95),
      lastResult: 'ok',
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
      provider: 'dsh', createdAt: now - 62 * 24 * 3600_000, // 创建两个月
      providerConfig: { cwd: '/Users/sky/work/main', permission: 'workspace-write' },
      assets: [
        { assetId: 'ast-skl001', name: 'wao-company', type: 'skill', mode: 'shared', origin: 'operator' },
        { assetId: 'ast-mem010', name: 'biz-memory', type: 'memory', mode: 'shared', origin: 'operator' },
        { assetId: 'ast-skl010', name: 'sls-playbook', type: 'skill', mode: 'exclusive', origin: 'curation', exclusiveBehind: 0, snapshotVersion: 2, snapshotAt: minAgo(600) },
      ],
    },
    {
      id: 'bot-2', name: '二号机器人', enabled: true, channel: 'wecom',
      account: { botId: '1000003' },
      provider: 'claude', createdAt: now - 9 * 24 * 3600_000,
      providerConfig: { cwd: '/Users/sky/work/bot2', model: { model: 'auto/glm-5.3-flash' }, visionInput: true },
      assets: [
        { assetId: 'ast-mcp002', name: 'gateway', type: 'mcp', mode: 'exclusive', origin: 'mcp', exclusiveBehind: 1, snapshotVersion: 1, snapshotAt: minAgo(7200) },
        { assetId: 'ast-mem003', name: 'team-notes', type: 'memory', mode: 'shared', origin: 'operator' },
        { assetId: 'ast-rg004', name: 'rg-guide', type: 'tool', mode: 'shared', origin: 'operator' },
        { assetId: 'ast-rtk09', name: 'rtk-slim', type: 'tool', mode: 'exclusive', origin: 'operator', exclusiveBehind: null, snapshotVersion: 1, snapshotAt: now - 3 * 24 * 3600_000, sourceDeleted: true },
      ],
    },
    {
      id: 'bot-3', name: '归档机器人', enabled: false, channel: 'wecom',
      account: { botId: '1000004' },
      provider: 'codex', createdAt: now - 200 * 24 * 3600_000, // 老机器人：createdAt 后补的规则之前创建
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
        assets: true, // provider 有 materializeAssets（向导 3.5 步可勾装备；盲评 P2-4）
        configSchema: [
          { key: 'cwd', label: '工作目录', hint: 'agent 作业目录，也是沙箱 workspaceRoot', type: 'string', required: true },
          { key: 'profile', label: 'dsh profile 名（默认 wecom-<botId>）', type: 'string' },
          { key: 'model', label: '模型', type: 'object', hint: '提供方+模型名即可（默认 magpie 网关）；其余可选', fields: [
            { key: 'provider', label: '提供方', type: 'string', placeholder: '如 magpie' },
            { key: 'model', label: '模型名', type: 'string', placeholder: '如 workbuddy/deepseek-v4.1-flash' },
            { key: 'baseURL', label: '网关地址（可选）', type: 'string' },
            { key: 'apiKey', label: '网关密钥（可选）', type: 'password' },
            { key: 'apiKeyEnv', label: '密钥环境变量名（可选）', type: 'string' } ] },
          { key: 'permission', label: '权限', type: 'enum', options: ['workspace-write', 'read-only', 'danger-full-access'], default: 'workspace-write' },
          { key: 'prompt', label: '人设（多行，写入 profile system-prompt personaPrefix）', type: 'string', multiline: true, rows: 5 },
          { key: 'writableDirs', label: '沙箱额外可写目录（绝对路径列表）', type: 'list' },
          { key: 'compaction', label: '自动压缩 {enabled?, thresholdRatio?, headroomTokens?, retainRatio?}', type: 'object' },
          { key: 'progressStyle', label: '工作汇报风格', hint: '拟人=只播报「思考中…请稍等」；详细=进度行展示思维链/工具摘要', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
          { key: 'progressText', label: '播报文案', hint: '占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
          { key: 'dshBin', label: 'dsh 可执行文件（PATH 或绝对路径）', type: 'string', default: 'dsh' },
          { key: 'nodeBin', label: 'node 可执行文件（profile 引导 PATH 用）', type: 'string' },
        ],
      },
      {
        id: 'claude',
        owner: 'provider-claude',
        assets: true,
        configSchema: [
          { key: 'cwd', label: '工作目录', hint: 'claude 按其 realpath 定位会话历史', type: 'string', required: true },
          { key: 'model', label: '模型', type: 'object', hint: '网关三项留空走默认（本机 magpie 与登录态）', fields: [
            { key: 'model', label: '模型名', type: 'string', placeholder: '如 workbuddy、auto/glm-5.3-flash' },
            { key: 'baseURL', label: '网关地址（可选）', type: 'string', placeholder: 'http://127.0.0.1:3425' },
            { key: 'apiKey', label: '网关密钥（可选）', type: 'password' },
            { key: 'apiKeyEnv', label: '密钥环境变量名（可选）', type: 'string' } ] },
          { key: 'permissionMode', label: '权限模式', hint: '传 --permission-mode；bypassPermissions=工具调用不再逐一确认', type: 'enum', options: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], default: 'default' },
          { key: 'allowedTools', label: '允许的工具', hint: '留空=不限制；逐项拼接传 --allowedTools', type: 'list' },
          { key: 'env', label: '注入子进程的环境变量', hint: 'JSON 对象、值必须是字符串；一般无需填写', type: 'object' },
          { key: 'prompt', label: '人设（多行）', hint: '每轮追加为系统提示（--append-system-prompt）', type: 'string', multiline: true, rows: 5 },
          { key: 'progressStyle', label: '工作汇报风格', hint: '拟人=只播报「思考中…请稍等」；详细=进度行展示思维链/工具摘要', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
          { key: 'progressText', label: '播报文案', hint: '占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
          { key: 'claudeBin', label: 'claude 可执行文件', hint: 'PATH 上的命令名或绝对路径', type: 'string', default: 'claude' },
          { key: 'claudeConfigDir', label: 'claude 配置目录', hint: '默认 ~/.claude（会话历史所在）；重定向时注入子进程 $CLAUDE_CONFIG_DIR', type: 'string' },
          { key: 'visionInput', label: '图片输入', hint: '允许用户发图；需模型具备视觉能力，图片按视觉 token 计费', type: 'bool', default: false },
        ],
      },
      {
        id: 'codex',
        owner: 'provider-codex',
        assets: true,
        configSchema: [
          { key: 'cwd', label: '工作目录', hint: 'codex 作业目录，也是会话 rollout 的归属', type: 'string', required: true },
          { key: 'model', label: '模型', type: 'object', hint: '只填模型名即可；网关地址走「运行时配置覆盖」', fields: [
            { key: 'model', label: '模型名', type: 'string', placeholder: '如 gpt-5.2、auto/gpt-6-luna' } ] },
          { key: 'sandbox', label: '沙箱模式', hint: '留空=codex 自身配置默认；续接轮自动改传 -c sandbox_mode', type: 'enum', options: ['read-only', 'workspace-write', 'danger-full-access'] },
          { key: 'configOverrides', label: '运行时配置覆盖（列表，每项 key=value）', type: 'list' },
          { key: 'apiKeyEnv', label: '凭证环境变量名', type: 'string', default: 'CODEX_API_KEY' },
          { key: 'env', label: '注入子进程的环境变量', hint: 'JSON 对象、值必须是字符串；一般无需填写', type: 'object' },
          { key: 'progressStyle', label: '工作汇报风格', hint: '拟人=只播报「思考中…请稍等」；详细=进度行展示思维链/工具摘要', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
          { key: 'progressText', label: '播报文案', hint: '占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
          { key: 'codexBin', label: 'codex 可执行文件（PATH 或绝对路径）', type: 'string', default: 'codex' },
          { key: 'codexHome', label: 'codex 配置目录（默认 ~/.codex；注入 $CODEX_HOME）', type: 'string' },
          { key: 'visionInput', label: '图片输入', hint: '允许用户发图；需模型具备视觉能力，图片按视觉 token 计费', type: 'bool', default: false },
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

// 整理史活容器（curate/rollback 状态化后 knowledge 回读反映变化）
const curLog = {
  mainBot: [
    { at: minAgo(600), ok: true, guidance: '重点整理 SLS 查询口径', summary: '合并 2 条重复的 SLS 查询记忆；新增技能 sls-playbook（独立绑定）' },
    { at: now - 3 * 24 * 3600_000, ok: false, guidance: '', reason: 'proposal-missing（模型未写出提案文件，最终回复也无合法 JSON 围栏）', summary: '' },
  ],
};

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
  // —— 知识资产面（DESIGN-KNOWLEDGE）————————————————————————————————
  // knowledge 只给 main-bot 造全量基线（dsh 送达面：profile 段最直观）；bot-2
  // 给精简（claude argv+盘面）；curate/rollback 各一条成功回执（harness 里点
  // 完即可看回执渲染，不真改 fake 状态）。
  '/api/bots/main-bot/knowledge': () => {
    // 活推导：memories/versions 由 FAKE_ASSETS + FAKE.bots 当前状态算出（curate/
    // rollback 状态化后刷新可见）；prompt 面静态基线（预览内容不随轮变）。
    const bot = FAKE.bots.find((b) => b.id === 'main-bot');
    const mem = FAKE_ASSETS.find((a) => a.id === 'ast-mem010');
    const skillRows = (bot.assets ?? [])
      .filter((x) => x.type === 'skill')
      .map((x) => {
        const a = FAKE_ASSETS.find((y) => y.id === x.assetId);
        return a == null ? null : {
          assetId: a.id, name: a.content?.name ?? a.name, displayName: a.name,
          description: a.content?.description ?? '', mode: x.mode, origin: a.origin,
          originLabel: a.origin === 'curation' ? 'AI 整理' : a.origin === 'mcp' ? 'Agent 建' : a.origin === 'plugin' ? '系统' : '人写',
          version: a.version, body: a.content.body ?? '', bodyChars: (a.content.body ?? '').length, truncated: false,
        };
      })
      .filter(Boolean);
    const versionRows = (bot.assets ?? [])
      .filter((x) => x.type === 'memory' || x.type === 'skill')
      .map((x) => {
        const a = FAKE_ASSETS.find((y) => y.id === x.assetId);
        return a == null ? null : {
          assetId: a.id, name: a.name, type: a.type, mode: x.mode, origin: a.origin,
          originLabel: a.origin === 'curation' ? 'AI 整理' : a.origin === 'mcp' ? 'Agent 建' : a.origin === 'plugin' ? '系统' : '人写',
          effectiveVersion: a.version,
          registry: { version: a.version, history: (a.history ?? []).map((h) => ({ version: h.version, at: h.at, via: h.via })) },
          snapshot: x.mode === 'exclusive' ? { version: x.snapshotVersion ?? a.version, history: [] } : null,
        };
      })
      .filter(Boolean);
    return {
      botId: 'main-bot', botName: '主号机器人', provider: 'dsh',
      delivery: 'dsh：人设+记忆+提示词约束+技能索引全部拼进 profile 的 system-prompt personaPrefix（单一组合器）；技能正文落 .wao/skills/；MCP 走 mcp-<serverId> profile 行。',
      prompt: { sections: [
        { kind: 'profile', title: 'dsh profile system-prompt · personaPrefix（完整系统提示词）',
          text: '【WAO 技能：wao-company】\n回复前先查台账；术语对照见 README §4.2\n技能正文在 .wao/skills/wao-company/SKILL.md——需要时先读该文件再执行。\n\n【WAO 跨会话记忆：biz-memory】\n' + mem.content.notes.join('\n') + '\n\n---\n沉淀规则：本轮若产生了跨会话有价值的东西，在回复最末尾另起一行输出沉淀标记（同事看不到这行，系统会自动收集进上面的记忆）……' },
        { kind: 'file', title: '技能正文（.wao/skills/*/SKILL.md）',
          paths: (bot.assets ?? []).filter((x) => x.type === 'skill')
            .map((x) => `/Users/sky/work/main/.wao/skills/${x.name}/SKILL.md`),
          files: (bot.assets ?? []).filter((x) => x.type === 'skill').map((x) => {
            const a = FAKE_ASSETS.find((y) => y.id === x.assetId);
            return a == null ? null : {
              path: `/Users/sky/work/main/.wao/skills/${x.name}/SKILL.md`, exists: true,
              bytes: 200, truncated: false,
              text: `---\nname: ${a.content?.name ?? a.name}\ndescription: ${a.content?.description ?? ''}\nx-wao-asset: ${a.id}\n---\n\n${a.content?.body ?? ''}`,
            };
          }).filter(Boolean) },
        { kind: 'stdin', title: '任务信封（stdin）',
          text: '每轮任务 = [会话自愈 handoff 前缀] + 用户消息 + [附件段] + [失败注记段]，以 \n\n---\n\n 连接后经 stdin 传入；上面的人设/记忆/技能索引已在 profile system-prompt 里。' },
      ] },
      memories: [{
        assetId: mem.id, name: mem.name, mode: 'shared', origin: 'operator', originLabel: '人写',
        notes: mem.content.notes, count: mem.content.notes.length, cap: 50,
      }],
      skills: skillRows,
      versions: versionRows,
      curation: [...curLog.mainBot].reverse().slice(0, 10),
    };
  },
  '/api/bots/bot-2/knowledge': () => ({
    botId: 'bot-2', botName: '二号机器人', provider: 'claude',
    delivery: 'claude：人设与 prompt/ripgrep 资产合并进 --append-system-prompt（每轮 argv）；skill/记忆物化为配置目录盘面文件；MCP 走 --mcp-config 单文件。',
    prompt: { sections: [
      { kind: 'argv', title: '--append-system-prompt · 每轮追加的系统提示词', text: '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'。' },
      { kind: 'file', title: '跨会话记忆（CLAUDE.md 标记节）', paths: ['/Users/sky/work/bot2/CLAUDE.md'],
        files: [{ path: '/Users/sky/work/bot2/CLAUDE.md', exists: true, bytes: 344, truncated: false, text: '# 项目备注\n\n<!-- wao:assets:begin:v1:bot=bot-2 -->\n## WAO 跨会话记忆：team-notes\n\n周报模板：本周完成 / 下周计划 / 风险\n发版窗口：周四 14:00\n<!-- wao:assets:end:v1 -->\n' }] },
      { kind: 'file', title: 'MCP 服务配置（WAO 域单文件，含密钥不预览内容）', paths: ['data/assets/bot-2/claude-mcp.json'], secret: true },
      { kind: 'stdin', title: '任务信封（stdin stream-json user 消息）', text: '每轮任务 = [会话自愈 handoff 前缀] + 用户消息 + …，经 stdin 传入。' },
    ] },
    memories: [{ assetId: 'ast-mem003', name: 'team-notes', mode: 'shared', origin: 'operator', originLabel: '人写',
      notes: ['周报模板：本周完成 / 下周计划 / 风险', '发版窗口：周四 14:00', '值班表在 ops/oncall.md，改动先打招呼'], count: 3, cap: 50 }],
    skills: [],
    versions: [
      { assetId: 'ast-mem003', name: 'team-notes', type: 'memory', mode: 'shared', origin: 'operator', originLabel: '人写', effectiveVersion: 2,
        registry: { version: 2, history: [] }, snapshot: null },
    ],
    curation: [],
  }),
  '/api/bots/bot-3/knowledge': () => ({ botId: 'bot-3', provider: 'codex', delivery: '', prompt: { sections: [] }, memories: [], skills: [], versions: [], curation: [] }),
  '/api/bots/main-bot/curate': (body) => {
    // 状态化（盲测 T4/T6）：假整理真改 fake 状态——回执之后回知识 tab 能看到
    // 「自动生效」（记忆条数变化、新技能出现、整理史多一行、版本历史推进）。
    const bot = FAKE.bots.find((b) => b.id === 'main-bot');
    const mem = FAKE_ASSETS.find((a) => a.id === 'ast-mem010');
    const merged = [
      '查某业务日志 → 用 MCP 工具 mcp__oneaix-sls__sls_execute_sql，project=k8s-log-onedata-prod，时间范围 now-1h（聚合 limit≤100）',
      '舱位捕手租户 202438 → monitorId 925（join 查询口径）',
      'SLS 查询预算 ≤8 次/轮，先聚合后下钻',
    ];
    const before = mem.content.notes.length;
    mem.history = [...(mem.history ?? []), { version: mem.version, at: mem.updatedAt, via: 'distill' }];
    mem.content = { notes: merged };
    mem.version += 1;
    mem.updatedAt = Date.now();
    FAKE_ASSETS.push({
      id: 'ast-skl011', type: 'skill', name: 'sls-tips', description: 'SLS 查询小抄（AI 整理轮沉淀）',
      content: { name: 'sls-tips', description: '什么时候查什么库的小抄', body: '# SLS 查询小抄\n\n1. 业务日志 project=k8s-log-onedata-prod\n2. 运价 logStore=timp\n3. 先聚合后下钻，预算 ≤8 次\n' },
      origin: 'curation', version: 1, createdAt: Date.now(), updatedAt: Date.now(), bindings: 1,
    });
    bot.assets.push({ assetId: 'ast-skl011', name: 'sls-tips', type: 'skill', mode: 'exclusive', origin: 'curation', exclusiveBehind: 0, snapshotVersion: 1, snapshotAt: Date.now() });
    const record = {
      at: Date.now(), ok: true, summary: `记忆 ${before}→3 条（合并 2 条重复）；新增技能 sls-tips（独立绑定本 bot）`,
      guidance: typeof body?.guidance === 'string' ? body.guidance : '', source: 'file',
      changes: {
        memory: { before, after: 3, mode: 'shared' }, memoryUnchanged: false,
        skillsCreated: [{ assetId: 'ast-skl011', name: 'sls-tips' }],
        skillsUpdated: [],
        skipped: [{ name: 'wao-company', reason: 'update 仅允许改「AI 整理」来源的技能（目标 origin=operator 只读）' }],
      },
      usage: { totalTokens: 21455, inputTokens: 9821, cacheReadTokens: 8900, outputTokens: 2634 },
    };
    curLog.mainBot.push(record);
    return record;
  },
  ...Object.fromEntries(['ast-mem010', 'ast-skl001', 'ast-skl010', 'ast-skl011'].map((assetId) => [
    `/api/assets/${assetId}/rollback`,
    (body) => {
      // 状态化（盲测 T7）：版本续增 + 旧态入历史——知识 tab 刷新后「当前 vN」推进。
      const asset = FAKE_ASSETS.find((a) => a.id === assetId);
      if (asset != null) {
        asset.history = [...(asset.history ?? []), { version: asset.version, at: asset.updatedAt, via: 'rollback' }];
        asset.version += 1;
        asset.updatedAt = Date.now();
      }
      return { ok: true, scope: 'registry', assetId, restoredVersion: body?.version ?? 1,
        version: asset?.version ?? 3, rematerialized: ['main-bot'], failed: [], writes: [] };
    },
  ])),
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
  // —— 资产科 (W3 T4) ————————————————————————————————————————————————
  // stub 的 api() 按 path 键（method-blind）：无 body 视为 GET/DELETE，有 body
  // 视为 POST/PATCH。处理器直接改 FAKE_ASSETS / FAKE.bots，让 harness 里的
  // 建资产→配发→卸下→重物化操作流真的走通（回执形状照抄 §3.2）。
  '/api/assets': (body) => {
    if (body === undefined) {
      return {
        assets: FAKE_ASSETS,
        // 装备包推荐（B 产品化）：ast-mem003 刻意只有 3 条（远低于 35 阈值）→
        // 基线返回 null（不展示）；harness 里手工塞 memoryUpgradeHint 可看样式。
        memoryUpgradeHint: null,
      };
    }
    const created = {
      id: `ast-${Math.random().toString(36).slice(2, 8)}`,
      type: body.type, name: body.name,
      ...(body.description !== undefined && body.description !== '' ? { description: body.description } : {}),
      content: body.content, origin: 'operator', version: 1,
      createdAt: Date.now(), updatedAt: Date.now(), bindings: 0,
    };
    FAKE_ASSETS.push(created);
    return { asset: created, rematerialized: [], failed: [], writes: [] };
  },
  ...Object.fromEntries(FAKE_ASSETS.map((a) => [`/api/assets/${a.id}`, (body) => {
    if (body === undefined) { // DELETE（页面不用 GET 单读）
      const holders = FAKE.bots.filter((b) => (b.assets ?? []).some((x) => x.assetId === a.id));
      let removedBindings = 0;
      let keptExclusive = 0;
      for (const bot of holders) {
        const kept = [];
        for (const x of bot.assets) {
          if (x.assetId !== a.id) { kept.push(x); continue; }
          if (x.mode === 'shared') removedBindings += 1; else { keptExclusive += 1; kept.push(x); }
        }
        bot.assets = kept;
      }
      FAKE_ASSETS.splice(FAKE_ASSETS.indexOf(a), 1);
      return {
        ok: true, id: a.id, removedBindings, keptExclusive,
        rematerialized: holders.filter((b) => b.assets.some((x) => x.assetId !== a.id) || removedBindings > 0).map((b) => b.id),
        failed: [], writes: [],
        ...(keptExclusive > 0 ? { note: `源工具已删除，${keptExclusive} 个独立（exclusive）副本仍生效（快照保留在各自 bot 记录中）` } : {}),
      };
    }
    // PATCH：version 递增 + 共享绑定 fan-out 回执
    Object.assign(a, { ...body, version: a.version + 1, updatedAt: Date.now() });
    const sharedBots = FAKE.bots.filter((b) => (b.assets ?? []).some((x) => x.assetId === a.id && x.mode === 'shared'));
    return {
      asset: a, rematerialized: sharedBots.map((b) => b.id), failed: [],
      writes: sharedBots.map((b) => ({ action: 'write', path: `${b.providerConfig?.cwd ?? '/tmp'}/.wao/${a.type}--${a.name}.md` })),
    };
  }])),
  ...Object.fromEntries(FAKE.bots.filter((b) => b.id !== 'bot-3').map((bot) => [
    `/api/bots/${bot.id}/assets`,
    (body) => { // POST 绑定（配发/私发）
      const asset = FAKE_ASSETS.find((x) => x.id === body?.assetId) ?? { id: body?.assetId, name: body?.assetId, type: 'skill', origin: 'operator' };
      const mode = body?.mode === 'exclusive' ? 'exclusive' : 'shared';
      bot.assets = [...(bot.assets ?? []), mode === 'exclusive'
        ? { assetId: asset.id, name: asset.name, type: asset.type, mode, origin: asset.origin, exclusiveBehind: 0, snapshotVersion: asset.version ?? 1, snapshotAt: Date.now() }
        : { assetId: asset.id, name: asset.name, type: asset.type, mode, origin: asset.origin }];
      if (FAKE_ASSETS.includes(asset)) asset.bindings = (asset.bindings ?? 0) + 1;
      return {
        ok: true,
        binding: { assetId: asset.id, mode, name: asset.name, type: asset.type, origin: asset.origin ?? 'operator' },
        rematerialized: [bot.id], failed: [],
        writes: [{ action: 'write', path: `${bot.providerConfig?.cwd ?? '/tmp'}/.wao/${asset.type}--${asset.name}.md` }],
        ...(asset.type === 'memory' && !bot.providerConfig?.claudeConfigDir
          ? { warnings: ['记忆落在共享 cwd，对同目录其他会话可见，建议配专属 config 目录（claudeConfigDir/codexHome/piAgentDir）'] } : {}),
      };
    },
  ])),
  ...Object.fromEntries(FAKE.bots.filter((b) => b.id !== 'bot-3').flatMap((bot) => {
    // 预登记「注册表全部资产 + 初始绑定（含已下架快照）」的解绑面；新建资产的
    // 解绑不在矩阵内——harness 会走错误横幅（真实流在真服务上验收）。
    const ids = [...new Set([...FAKE_ASSETS.map((a) => a.id), ...(bot.assets ?? []).map((x) => x.assetId)])];
    return ids.map((assetId) => [
      `/api/bots/${bot.id}/assets/${assetId}`,
      () => { // DELETE 解绑
        const x = (bot.assets ?? []).find((b) => b.assetId === assetId);
        if (x == null) throw new Error(`工具 ${assetId} 未绑定到 bot ${bot.id}`);
        bot.assets = (bot.assets ?? []).filter((b) => b.assetId !== assetId);
        const src = FAKE_ASSETS.find((a) => a.id === assetId);
        if (src != null) src.bindings = Math.max(0, (src.bindings ?? 1) - 1);
        return {
        ok: true,
          removed: { assetId: x.assetId, mode: x.mode, name: x.name, type: x.type, exclusiveContentLost: x.mode === 'exclusive' },
          rematerialized: [bot.id], failed: [],
          writes: [{ action: 'unlink', path: `${bot.providerConfig?.cwd ?? '/tmp'}/.wao/${x.type}--${x.name}.md` }],
        };
      },
    ]);
  })),
  ...Object.fromEntries(FAKE.bots.filter((b) => b.id !== 'bot-3').map((bot) => [
    `/api/bots/${bot.id}/rematerialize-assets`,
    () => ({
      ok: true, botId: bot.id, rematerialized: [bot.id], failed: [],
      writes: (bot.assets ?? []).map((x) => (x.type === 'tool'
        ? { action: 'rtk-init', path: `${bot.providerConfig?.cwd ?? '/tmp'}/.wao` }
        : { action: 'write', path: `${bot.providerConfig?.cwd ?? '/tmp'}/.wao/${x.type}--${x.name}.md` })),
      ...((bot.assets ?? []).some((x) => x.type === 'tool')
        ? { notes: ['rtk 不可用：二进制未安装或不在 PATH——绑定保留，装好 rtk 后重跑「重新物化」即可配置'] } : {}),
    }),
  ])),
  // —— v2 设置页（系统信息 section）————————————————————————————————————
  '/healthz': { ok: true, version: '0.1.0' },
  '/api/service/tools': (body) => (body === undefined ? {
        ok: true, platform: 'darwin',
        tools: [
            { id: 'rtk', label: 'rtk', bin: 'rtk', version: '1.2.0', state: 'available', path: '/Users/demo/.local/bin/rtk', detectedVersion: 'rtk 1.1.0', description: 'Token 瘦身 hook：PreToolUse 拦截 Bash 命令输出过滤（实测单轮 -18%）', install: null },
            { id: 'ripgrep', label: 'ripgrep', bin: 'rg', version: '15.2.0', state: 'missing', path: null, detectedVersion: null, description: '代码检索：rg 关键词定位（Bash/Grep 工具的底层引擎）', install: null },
            { id: 'uv', label: 'uv', bin: 'uv', version: '0.6.8', state: 'available', path: '/Users/demo/.local/bin/uv', detectedVersion: 'uv 0.6.8 (c1ef48276 2025-03-18)', description: 'Python 工具链管理器：scope-recall 记忆工具的安装前提（uv tool install 自动落托管 Python，免管理员）', install: null },
          ],
        } : { ok: true, id: body?.id ?? 'ripgrep', state: 'installing', restartRequired: true, message: '后台安装中（下载→校验→解压→PATH）' }),
        '/api/service/network': (body) => (body === undefined ? {
        ok: true,
        proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
        effective: { source: 'config', url: 'http://127.0.0.1:7890', enabled: true },
        } : { ok: true, proxy: { enabled: !!body?.enabled, proxyUrl: body?.url ?? '' }, effective: { source: body?.enabled ? 'config' : 'none', url: body?.url ?? '', enabled: !!body?.enabled } }),
        '/api/service/network/test': (body) => ({ ok: true, ms: 342, via: 'config', message: '✓ GitHub 可达 · 342ms（经配置代理）' }),
        '/api/service/restart': (body) => ({ ok: true, message: '服务重启中（十几秒），页面就绪后自动刷新', restartMode: 'detached' }),
        '/api/service/update': {
    ok: true,
    currentCommit: 'b1f39ba',
    currentVersion: '0.1.0',
    remoteCommit: 'b1f39ba',
    commitMessage: 'feat(lan,autostart): 支持局域网模式与 AI 操作端点自发现',
    commitDate: '2026-11-09T06:00:00Z',
    hasUpdate: false,
    checkedAt: 1794033321000,
  },
  '/api/state': {
    ok: true, uptimeSec: 93725, pid: 4242, dataDir: '/Users/sky/.local/share/wao',
    port: 8792, host: '0.0.0.0', lanMode: true, lanIps: ['192.168.1.100'], hostname: 'office-node-1',
    plugins: FAKE_PLUGINS, uiPlugins: [{ id: 'ui-workbench' }, { id: 'ui-office3d' }],
  },
  // —— v2 AI 操作引导（/api/mcp · /api/mcp/skill，mcp-gateway 提供）————————
  // 23 个工具名与高危标记照抄 plugins/mcp-gateway/tools.js（描述截短——
  // 截图只要看清单形状，不必背全文）；sessions: 2 让引导卡/状态行展示
  // 「已连接」形态（未连接形态在 ?state=error 基线里以 stub 缺席自然出现）。
  '/api/mcp': {
    ok: true, endpoint: '/mcp', port: 8792, lanMode: true, lanIps: ['192.168.1.100'], hostname: 'office-node-1', sessions: 2,
    tools: [
      { name: 'list_bots', description: '查看在线机器人清单：状态/进度/消息统计（只读）' },
      { name: 'get_bot', description: '按机器人 ID 查详情：配置摘要/工作目录/消息统计（只读）' },
      { name: 'create_bot', description: '创建机器人：提交完整 bot 记录（含引擎/渠道配置）' },
      { name: 'update_bot', description: '更新机器人配置（patch 语义：只传要改的字段）' },
      { name: 'delete_bot', description: '删除机器人：收尾断开、清理工作目录、台账保留', dangerous: true },
      { name: 'set_enabled', description: '启停切换：在线↔暂停（配置保留）' },
      { name: 'test_bot', description: '测试运行：直连引擎跑一轮探针（不进引擎链）' },
      { name: 'broadcast', description: '以某机器人身份向指定会话推送消息（真实送达）', dangerous: true },
      { name: 'list_plugins', description: '查看插件清单：id/类型/状态（只读）' },
      { name: 'toggle_plugin', description: '插件启停：四阶段重载，依赖的机器人随之离线/恢复', dangerous: true },
      { name: 'get_ledger', description: '查会话历史（台账）：对话轮次记录，可按会话过滤' },
      { name: 'get_timeline', description: '查活动日志（时间线事件流），可限定窗口' },
      { name: 'get_state', description: '系统状态摘要：运行时长/插件/机器人计数（只读）' },
      { name: 'create_asset', description: '添加工具（skill/memory/mcp/prompt/tool 五类）' },
      { name: 'update_asset', description: '更新工具内容（patch 语义，version 自增）' },
      { name: 'delete_asset', description: '删除工具：解绑共享绑定并重物化清理', dangerous: true },
      { name: 'bind_asset', description: '将工具绑定到 bot（共享/独立），写入磁盘下一轮生效', dangerous: true },
      { name: 'unbind_asset', description: '解绑 bot 的工具，删除盘上产物', dangerous: true },
      { name: 'rematerialize', description: '按当前绑定强制重写全部工具产物文件（幂等）', dangerous: true },
      { name: 'list_assets', description: '盘点工具资产全貌：清单/绑定数/memory 条数（只读）' },
      { name: 'get_asset', description: '读单件工具资产全文与版本历史（只读）' },
      { name: 'curate_bot', description: '知识整理轮：bot 用自己的引擎重整记忆/技能，自动应用留版本可回滚', dangerous: true },
      { name: 'rollback_asset', description: '把资产内容回滚到历史版本（注册表或 bot 独立快照）', dangerous: true },
    ],
  },
  '/api/mcp/skill': {
    ok: true, filename: 'wao-company.md',
    content: '---\nname: wao-company\ndescription: 操作 wecom-agent-office（wao）机器人平台：经 MCP server「wao-company」做日常巡检、创建机器人、改配置、暂停启用、删除、推送、插件启停、查会话历史与活动日志、资产绑定。\n---\n\n（harness 摘录——全文见仓库 docs/skills/wao-company.md）\n\n你是 wao 平台的运维助手。操作面经 MCP server `wao-company` 暴露（23 个工具）。\n\n## 常用意图 → 工具\n\n- 「看看机器人状态」→ list_bots\n- 「帮我暂停 main」→ set_enabled\n- 「给 main 发一条推送」→ broadcast（危险：先复述会话与内容）\n',
  },
};
