// Harness fake data (M3 T4 截图工作流): the shapes ui/office.js consumes —
// /api/agents summaries (3 bots covering every worker state) + the
// /api/timeline rows (all bots, oldest-first, every kind) that drive the
// desk monitor tickers. Screens want per-bot variety: main-bot(dsh) working
// with a 🔧 progress line + busy stream; bot-claude idle lounging; bot-codex
// offline with a reason (grayed, napping in the corner).
const now = Date.now();
const minAgo = (m) => now - m * 60_000;

export const FAKE_TIMELINE = [
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'run_start', text: '', at: minAgo(3) },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'thinking', text: '先读 test/ui/ofscene.test.js 的失败断言，再对照投影公式的改动。', at: minAgo(3) + 4000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'tool', text: '编辑 plugins/ui-office3d/ui/office.js 第 212 行', at: minAgo(2) + 2000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'step', text: '', at: minAgo(1) + 30000 },
  { botId: 'bot-claude', chatKey: 'wecom:single:lisi', kind: 'turn', text: '周报已总结完毕，共 6 页，重点标注了盲评两条例外。', at: minAgo(9) },
  { botId: 'bot-claude', chatKey: 'wecom:single:lisi', kind: 'run_end', text: '', at: minAgo(9) + 2000 },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'tool', text: '重跑 node --test test/ui/ofscene.test.js', at: minAgo(0) + 20000 },
].sort((a, b) => a.at - b.at);

export const FAKE = {
  agents: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, status: 'working',
      provider: 'dsh', channel: 'wecom',
      progress: { line: '🔧 正在修复 ofscene 投影的单测断言（第 3/5 项）', startedAt: now - 47_000, updatedAt: now - 3000 },
      todayTurns: 12, users: 3, chats: 2, reason: null,
    },
    {
      id: 'bot-claude', name: '克劳德助手', enabled: true, status: 'idle',
      provider: 'claude', channel: 'wecom',
      progress: null, todayTurns: 3, users: 1, chats: 1, reason: null,
    },
    {
      id: 'bot-codex', name: 'Codex 值班', enabled: true, status: 'offline',
      provider: 'codex', channel: 'wecom',
      progress: null, todayTurns: 0, users: 0, chats: 0,
      reason: 'provider codex 已禁用（插件停用或加载失败）',
    },
  ],
};
