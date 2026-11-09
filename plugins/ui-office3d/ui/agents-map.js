// WAO /api/agents → Magpie AgentOfficeScene agent records.
// Status: working→executing · idle→done · offline→error
// seed 必须稳定（肤色/占座）；缺了会 NaN → 白屏。

const PROVIDER_BRAND = {
  dsh: { name: 'DSH', color: '#3B82F6' },
  claude: { name: 'Claude', color: '#E8794B' },
  codex: { name: 'Codex', color: '#14B8A6' },
};

export const STATUS_LABEL = { working: '工作中', idle: '待命', offline: '离线' };
export const STATUS_DOT = { working: '#3b82f6', idle: '#94a3b8', offline: '#ef4444' };

export function seedOf(key) {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}

export function providerBrand(provider) {
  return PROVIDER_BRAND[provider] ?? {
    name: provider ? String(provider).toUpperCase() : '?',
    color: '#94A3B8',
  };
}

export function mapAgent(a) {
  const brand = providerBrand(a.provider);
  const status = a.status === 'working' ? 'executing'
    : a.status === 'idle' ? 'done'
      : 'error';
  const step = a.status === 'working'
    ? (a.progress?.line || '工作中…')
    : a.status === 'idle'
      ? '待命 · 暂无进行中对话'
      : (a.reason || '已离线');
  return {
    key: a.id,
    agent: a.name || a.id,
    title: a.name || a.id,
    brand,
    status,
    step,
    error: a.status === 'offline' ? (a.reason || 'offline') : undefined,
    idle: a.status === 'idle',
    project: 'wecom-agent-office',
    sub: a.provider || '?',
    seed: seedOf(a.id),
    wao: { status: a.status || 'offline', provider: a.provider },
  };
}

export function mapAgents(agents) {
  return (agents ?? []).map(mapAgent);
}

export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function isOff(a) {
  return a?.status === 'offline' || a?.enabled === false;
}
