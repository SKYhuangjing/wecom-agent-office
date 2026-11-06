const now = Date.now();
const minAgo = (m) => now - m * 60_000;

export const FAKE_TIMELINE = [
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'tool', text: '抢占升级 · latest-wins', at: minAgo(1) },
  { botId: 'main-bot', chatKey: 'wecom:group:G1', kind: 'step', text: '屏内进度 · edit api.js 62%', at: minAgo(2) },
  { botId: 'bot-claude', chatKey: 'wecom:group:ops', kind: 'turn', text: '企微入站 · wecom:group:ops', at: minAgo(6) },
  { botId: 'bot-codex', chatKey: 'wecom:single:x', kind: 'run_end', text: '夜班进入休眠', at: minAgo(19) },
].sort((a, b) => a.at - b.at);

export const FAKE = {
  agents: [
    {
      id: 'main-bot', name: '主号机器人', enabled: true, status: 'working',
      provider: 'dsh', channel: 'wecom', createdAt: now - 86400_000 * 30,
      progress: { line: '正在修 api.js 测试', startedAt: now - 47_000, updatedAt: now - 3000 },
      todayTurns: 12, users: 3, chats: 2, reason: null,
    },
    {
      id: 'bot-claude', name: '克劳德助手', enabled: true, status: 'working',
      provider: 'claude', channel: 'wecom', createdAt: now - 86400_000 * 20,
      progress: { line: '图表复盘中', startedAt: now - 120_000, updatedAt: now - 5000 },
      todayTurns: 5, users: 2, chats: 1, reason: null,
    },
    {
      id: 'bot-codex', name: 'Codex 值班', enabled: true, status: 'offline',
      provider: 'codex', channel: 'wecom', createdAt: now - 86400_000 * 10,
      progress: null, todayTurns: 0, users: 0, chats: 0,
      reason: '休眠至定时任务',
    },
  ],
};
