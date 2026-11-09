// 席位与热区标定（OFFICE-STUDIO-SPEC §2.6）。百分比相对舞台。
// 适配自制 3D 白棚 16:9 渲染母带（2x3 工位阵列）。

export const STATUS_LABEL = {
  working: '工作中',
  idle: '待命',
  offline: '离线',
};

export const PROVIDER_COLOR = {
  dsh: '#2563EB',
  claude: '#EA580C',
  codex: '#0D9488',
  pi: '#7C3AED',
};

export const SEATS = [
  // 后排 (Top Row: y ≈ 15%, h ≈ 32%)
  { left: 19.5, top: 15, w: 19, h: 32 }, // Seat 0: Pi (休眠/待命)
  { left: 40.5, top: 15, w: 19, h: 32 }, // Seat 1: DeepSeek (代码走查)
  { left: 61.5, top: 15, w: 19, h: 32 }, // Seat 2: Claude (方案架构)

  // 前排 (Bottom Row: y ≈ 48%, h ≈ 44%)
  { left: 17.0, top: 48, w: 21, h: 44 }, // Seat 3: DeepSeek (单元测试)
  { left: 39.5, top: 48, w: 21, h: 44 }, // Seat 4: Claude (故障排查)
  { left: 62.5, top: 48, w: 21, h: 44 }, // Seat 5: Codex (特性开发)
];

/** Stable seat assignment: sort by createdAt then id; >6 → last seat is +N aggregate. */
export function assignSeats(agents) {
  const list = [...(agents ?? [])].sort((a, b) => {
    const ca = a.createdAt ?? 0;
    const cb = b.createdAt ?? 0;
    if (ca !== cb) return ca - cb;
    return String(a.id).localeCompare(String(b.id));
  });
  if (list.length <= 6) {
    return SEATS.map((seat, i) => ({
      seat,
      index: i,
      agent: list[i] ?? null,
      overflow: null,
    }));
  }
  const head = list.slice(0, 5);
  const rest = list.slice(5);
  return SEATS.map((seat, i) => {
    if (i < 5) return { seat, index: i, agent: head[i], overflow: null };
    return { seat, index: i, agent: rest[0], overflow: rest };
  });
}

export function providerColor(provider) {
  return PROVIDER_COLOR[provider] ?? '#94A3B8';
}

export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
