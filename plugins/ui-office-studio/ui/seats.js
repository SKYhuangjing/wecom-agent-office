// 席位与热区标定（OFFICE-STUDIO-SPEC §2.6）。百分比相对舞台。

export const STATUS_LABEL = { working: '工作中', idle: '待命', offline: '休假' };

export const PROVIDER_COLOR = {
  dsh: '#3B82F6',
  claude: '#E8794B',
  codex: '#14B8A6',
};

export const SEATS = [
  { left: 28.4, top: 8, w: 6, h: 24 },
  { left: 46.8, top: 8, w: 6, h: 24 },
  { left: 65.0, top: 8, w: 6, h: 24 },
  { left: 28.4, top: 48, w: 6, h: 24 },
  { left: 46.8, top: 48, w: 6, h: 24 },
  { left: 65.0, top: 48, w: 6, h: 24 },
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
