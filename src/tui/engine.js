// W2 T2 keyboard operations (pure, terminal-free testable) — the ENGINE
// module of src/tui/: state transitions and effect descriptors, no ANSI, no
// I/O. handleKey(state, ev, deps) → { state, effects }: ev is the readline
// keypress payload { seq, key: { name, ctrl, meta } }; deps injects the two
// impure bits ({ base } for the e-key URL, { genId } for badge-id rolls).
// Effects are PLAIN DESCRIPTORS ({type:'toggle'|'test'|'ledger'|'send'|
// 'ports'|'createBot'|'openUrl'|'quit', …}) — the attach shell maps them to
// the same /api the Web console uses; tests assert descriptors without a
// terminal or a server. applyResult(state, effect, result) folds an
// operation's outcome ({ok:true,data} | {ok:false,error}) back into state.
//
// Modes: dashboard (↑↓/space/t/b/l/n/e/q) · confirm (y/n) · input (typing)
// · pick (broadcast target) · result (scrollable probation output) ·
// wizard (mini hire). Every mutating operation goes through a confirm row;
// input modes intercept all other keys.

// 工牌号 roll（与 Web 人事部 rollBadgeId 同规则：hr- + 6 位无歧义字符）。
export const genBadgeId = (taken) => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const has = new Set(Array.isArray(taken) ? taken : []);
  for (let i = 0; i < 64; i++) {
    let s = '';
    for (let k = 0; k < 6; k++) s += abc[Math.floor(Math.random() * abc.length)];
    const id = `hr-${s}`;
    if (!has.has(id)) return id;
  }
  return `hr-${Date.now().toString(36)}`;
};

export const DEFAULT_STATE = {
  agents: [], selectedIdx: 0, mode: 'dashboard', busy: 0, notice: null, pendingNotice: null,
  confirm: null, input: null, pick: null, result: null, wizard: null, logZoom: false,
};
const backToDashboard = (state, extra = {}) => {
  // 回仪表盘时把暂存的迟到通知（评审 W2 T3 #5）露面并清位：pendingNotice
  // 优先于旧 notice；调用方 extra.notice（如有）最优先。
  const { pendingNotice, ...rest } = state;
  return {
    ...rest, mode: 'dashboard', confirm: null, input: null, pick: null, result: null, wizard: null,
    notice: pendingNotice ?? state.notice ?? null, ...extra,
  };
};
const selectedAgent = (state) => (state.agents.length === 0
  ? null : state.agents[Math.min(Math.max(0, state.selectedIdx), state.agents.length - 1)]);
const noEmployees = (state) => ({
  state: { ...state, notice: { text: '还没有机器人——按 n 创建机器人', kind: 'error' } },
  effects: [],
});

// Each confirm kind → the effect its 'y' produces.
const confirmEffect = (confirm) => {
  const p = confirm.payload ?? {};
  switch (confirm.kind) {
    case 'toggle': return { type: 'toggle', botId: p.botId, name: p.name, toEnabled: p.toEnabled !== false };
    case 'send': return { type: 'send', botId: p.botId, name: p.name, chatKey: p.chatKey, content: p.content };
    case 'hire': return { type: 'createBot', bot: p.bot };
    default: return null;
  }
};

const INPUT_CAPS = { test: 2000, 'bcast-content': 3500 };
const WIZARD_CAPS = { name: 30, cwd: 512, botId: 128, secret: 512 };

// Wizard step → editable field (step 1 is the provider PICK, step 5 the
// summary confirm; render's wizardPane walks the same map for its labels).
export const WIZARD_FIELD_OF_STEP = { 0: 'name', 2: 'cwd', 3: 'botId', 4: 'secret' };

export function handleKey(state = {}, ev = {}, deps = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  if (ev?.key?.ctrl && (ev.key.name === 'c' || ev.key.name === 'd')) {
    return { state: st, effects: [{ type: 'quit' }] };
  }
  const name = ev?.key?.name ?? '';
  const seq = typeof ev?.seq === 'string' ? ev.seq : '';
  const printable = !ev?.key?.ctrl && !ev?.key?.meta && seq.length === 1 ? seq : '';
  const enter = name === 'return' || name === 'enter' || seq === '\r' || seq === '\n';
  const none = { state: st, effects: [] };

  // —— dashboard：导航与操作入口 ————————————————————————————————————————
  if (st.mode === 'dashboard') {
    const sel = selectedAgent(st);
    const move = (delta) => {
      if (st.agents.length === 0) return none;
      const cur = Math.min(Math.max(0, st.selectedIdx), st.agents.length - 1);
      return { state: { ...st, selectedIdx: Math.min(st.agents.length - 1, Math.max(0, cur + delta)) }, effects: [] };
    };
    if (name === 'up') return move(-1);
    if (name === 'down') return move(1);
    if (name === 'escape') return { state: { ...st, notice: null }, effects: [] };
    if (printable === ' ') {
      if (sel == null) return noEmployees(st);
      const goingOff = sel.enabled !== false;
      return {
        state: {
          ...st, mode: 'confirm', notice: null,
          confirm: {
            text: `确认将 ${sel.name} ${goingOff ? '暂停' : '启用'}？(y/n)`,
            kind: 'toggle',
            payload: { botId: sel.id, name: sel.name, toEnabled: !goingOff },
          },
        },
        effects: [],
      };
    }
    if (printable === 't') {
      if (sel == null) return noEmployees(st);
      return {
        state: {
          ...st, mode: 'input', notice: null,
          input: {
            kind: 'test',
            prompt: `测试运行 · ${sel.name}——测试问题（空=默认探针「回复：收到」）：`,
            value: '', secret: false, botId: sel.id, name: sel.name, err: null,
          },
        },
        effects: [],
      };
    }
    if (printable === 'b') {
      if (sel == null) return noEmployees(st);
      return { state: { ...st, notice: null }, effects: [{ type: 'ledger', botId: sel.id, name: sel.name }] };
    }
    if (printable === 'l') return { state: { ...st, logZoom: !st.logZoom }, effects: [] };
    if (printable === 'n') return { state: { ...st, notice: null }, effects: [{ type: 'ports' }] };
    if (printable === 'e') {
      return { state: st, effects: [{ type: 'openUrl', url: `${deps.base ?? 'http://127.0.0.1:8792'}/` }] };
    }
    if (printable === 'q') return { state: st, effects: [{ type: 'quit' }] };
    return none;
  }

  // —— confirm：y 执行 / n·esc 取消（其余键吞掉，防误触）————————————————
  if (st.mode === 'confirm') {
    if (printable === 'y' || printable === 'Y') {
      const effect = confirmEffect(st.confirm ?? {});
      if (effect == null) return { state: backToDashboard(st), effects: [] };
      return { state: backToDashboard(st), effects: [effect] };
    }
    if (printable === 'n' || printable === 'N' || name === 'escape') {
      return { state: backToDashboard(st), effects: [] };
    }
    return none;
  }

  // —— input：可打印字符累积 / 退格 / 回车提交 / esc 取消 ————————————————
  if (st.mode === 'input' && st.input != null) {
    const input = st.input;
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (name === 'backspace') {
      return { state: { ...st, input: { ...input, value: String(input.value ?? '').slice(0, -1), err: null } }, effects: [] };
    }
    if (enter) {
      const value = String(input.value ?? '');
      if (input.kind === 'test') {
        return {
          state: backToDashboard(st),
          effects: [{ type: 'test', botId: input.botId, name: input.name, prompt: value.trim() === '' ? null : value }],
        };
      }
      if (input.kind === 'bcast-content') {
        if (value.trim() === '') {
          return { state: { ...st, input: { ...input, err: '消息内容不能为空' } }, effects: [] };
        }
        return {
          state: {
            ...st, mode: 'confirm', input: null,
            confirm: {
              text: '将真实发送到该机器人的渠道会话，确认？(y/n)',
              kind: 'send',
              payload: { botId: input.botId, name: input.name, chatKey: input.chatKey, content: value },
            },
          },
          effects: [],
        };
      }
      return none;
    }
    if (printable !== '') {
      const cap = INPUT_CAPS[input.kind] ?? 512;
      if (String(input.value ?? '').length >= cap) return none;
      return { state: { ...st, input: { ...input, value: String(input.value ?? '') + printable, err: null } }, effects: [] };
    }
    return none;
  }

  // —— pick：广播目标会话选择 ————————————————————————————————————————————
  if (st.mode === 'pick' && st.pick != null) {
    const pick = st.pick;
    const n = (pick.items ?? []).length;
    if (name === 'up' || name === 'down') {
      if (n === 0) return none;
      const cur = Math.min(Math.max(0, pick.idx ?? 0), n - 1);
      const idx = name === 'up' ? Math.max(0, cur - 1) : Math.min(n - 1, cur + 1);
      return { state: { ...st, pick: { ...pick, idx } }, effects: [] };
    }
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (enter) {
      if (n === 0) return none;
      const chosen = pick.items[Math.min(Math.max(0, pick.idx ?? 0), n - 1)];
      if (pick.kind === 'bcast-chat') {
        return {
          state: {
            ...st, mode: 'input', pick: null,
            input: {
              kind: 'bcast-content',
              prompt: `推送到 ${chosen.value}——内容：`,
              value: '', secret: false, botId: pick.botId, name: pick.name, chatKey: chosen.value, err: null,
            },
          },
          effects: [],
        };
      }
      return none;
    }
    return none;
  }

  // —— result：岗前测试结果窗滚动 / 关闭 ————————————————————————————————
  if (st.mode === 'result') {
    if (name === 'up') return { state: { ...st, result: { ...st.result, scroll: Math.max(0, (st.result.scroll ?? 0) - 1) } }, effects: [] };
    if (name === 'down') return { state: { ...st, result: { ...st.result, scroll: (st.result.scroll ?? 0) + 1 } }, effects: [] }; // clamped at render
    if (name === 'escape' || enter) return { state: backToDashboard(st), effects: [] };
    return none;
  }

  // —— wizard：简版入职向导 ——————————————————————————————————————————————
  if (st.mode === 'wizard' && st.wizard != null) {
    const w = st.wizard;
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (w.step === 1) { // 岗位选择（/api/ports providers 枚举）
      const n = (w.ports?.providers ?? []).length;
      if (name === 'up' || name === 'down') {
        if (n === 0) return none;
        const cur = Math.min(Math.max(0, w.pickIdx ?? 0), n - 1);
        const pickIdx = name === 'up' ? Math.max(0, cur - 1) : Math.min(n - 1, cur + 1);
        return { state: { ...st, wizard: { ...w, pickIdx } }, effects: [] };
      }
      if (enter && n > 0) {
        const provider = w.ports.providers[Math.min(Math.max(0, w.pickIdx ?? 0), n - 1)].id;
        return { state: { ...st, wizard: { ...w, step: 2, fields: { ...w.fields, provider }, err: null } }, effects: [] };
      }
      return none;
    }
    if (w.step === 5) { // 摘要确认
      if (printable === 'y' || printable === 'Y') {
        return { state: backToDashboard(st), effects: [{ type: 'createBot', bot: w.bot }] };
      }
      if (printable === 'n' || printable === 'N') return { state: backToDashboard(st), effects: [] };
      return none;
    }
    // 字段行编辑（0 名 / 2 cwd / 3 botId / 4 secret）
    const field = WIZARD_FIELD_OF_STEP[w.step];
    if (field == null) return none;
    if (name === 'backspace') {
      return { state: { ...st, wizard: { ...w, fields: { ...w.fields, [field]: String(w.fields[field] ?? '').slice(0, -1) }, err: null } }, effects: [] };
    }
    if (enter) {
      const value = String(w.fields[field] ?? '').trim();
      if (field !== 'secret' && value === '') {
        const label = { name: '姓名', cwd: '工作目录', botId: '机器人 ID' }[field] ?? '该字段';
        return { state: { ...st, wizard: { ...w, err: `${label}不能为空` } }, effects: [] };
      }
      if (field === 'name' && value.length > 30) {
        return { state: { ...st, wizard: { ...w, err: '姓名太长（≤30 字）' } }, effects: [] };
      }
      if (w.step === 4) { // secret 完成 → 组装入职档案，进入摘要
        const f = { ...w.fields, name: String(w.fields.name ?? '').trim(), cwd: String(w.fields.cwd ?? '').trim(), botId: String(w.fields.botId ?? '').trim() };
        const account = {};
        if (w.channelKeys?.has('botId') && f.botId !== '') account.botId = f.botId;
        if (w.channelKeys?.has('secret') && f.secret !== '') account.secret = f.secret;
        const bot = {
          id: w.id, name: f.name, enabled: false, channel: w.channel,
          account, provider: f.provider, providerConfig: { cwd: f.cwd }, allowedUsers: [],
        };
        return { state: { ...st, wizard: { ...w, fields: f, step: 5, err: null, bot } }, effects: [] };
      }
      return { state: { ...st, wizard: { ...w, step: w.step + 1, err: null } }, effects: [] };
    }
    if (printable !== '') {
      const cur = String(w.fields[field] ?? '');
      if (cur.length >= (WIZARD_CAPS[field] ?? 512)) return none;
      return { state: { ...st, wizard: { ...w, fields: { ...w.fields, [field]: cur + printable }, err: null } }, effects: [] };
    }
    return none;
  }

  return none;
}

// Fold an operation outcome back into state. result: {ok:true, data} |
// {ok:false, error, status?}. Failures land as a red notice carrying the
// API's own message (透传), success as a green notice / result window /
// pick list / wizard per effect type.
const OP_LABELS = {
  toggle: '暂停/启用', send: '推送', createBot: '创建机器人', test: '测试运行',
  ledger: '会话查询', ports: '引擎查询', openUrl: '打开浏览器',
};
export function applyResult(state = {}, effect = {}, result = {}, deps = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  const label = OP_LABELS[effect.type] ?? '操作';
  // 迟到回执（评审 W2 T3 #5）：操作在途时用户可能已进入别的模式（如正看
  // 上一轮结果窗）——不许把人拽回仪表盘。仅当前就在仪表盘才即时弹通知，
  // 否则暂存为 pendingNotice，下次回仪表盘（backToDashboard）时露面。
  const noticeState = (text, kind) => (st.mode === 'dashboard'
    ? { ...backToDashboard(st), notice: { text, kind } }
    : { ...st, pendingNotice: { text, kind } });
  if (result?.ok !== true) {
    return noticeState(`${label}失败：${result?.error ?? '未知错误'}`, 'error');
  }
  const data = result.data;
  switch (effect.type) {
    case 'toggle': {
      const on = data?.bot?.enabled !== false;
      return noticeState(
        on ? `▶️ 已启用：${effect.name}（恢复上线）` : `⏸️ 已暂停：${effect.name}（在途消息收尾后离线）`,
        'ok',
      );
    }
    case 'test':
      return {
        ...backToDashboard(st),
        mode: 'result',
        result: {
          title: `测试运行 · ${effect.name}`,
          code: data?.code ?? 'error',
          finalText: data?.finalText ?? '',
          sessionId: data?.sessionId ?? null,
          events: data?.events ?? 0,
          errorText: data?.errorText ?? data?.reason ?? null,
          scroll: 0,
        },
      };
    case 'send':
      return noticeState(`📢 已推送：${effect.name} → ${effect.chatKey}`, 'ok');
    case 'createBot': {
      // 允许用户警示同步到回执（评审 W2 T3 #3）：TUI 向导恒以 allowedUsers: []
      // 创建——按服务端返回核对，空名单必须与摘要页同文案警示。
      const gateOpen = (Array.isArray(data?.bot?.allowedUsers) ? data.bot.allowedUsers : []).length === 0;
      return noticeState(
        `🎉 已创建：${data?.bot?.name ?? '?'}（机器人 ID ${data?.bot?.id ?? '?'}，暂停态）`
        + `${gateOpen ? '——允许用户：未配置=接受任何企微用户发消息' : ''}`
        + '——到 Web 机器人管理完善资料，或选中按空格启用',
        'ok',
      );
    }
    case 'ledger': {
      const rows = Array.isArray(data) ? data : [];
      const counts = new Map();
      for (const r of rows) {
        if (typeof r?.chatKey === 'string' && r.chatKey !== '') counts.set(r.chatKey, (counts.get(r.chatKey) ?? 0) + 1);
      }
      if (counts.size === 0) return noticeState(`${effect.name} 还没有会话记录——没有可推送的目标`, 'error');
      const items = [...counts.entries()].map(([k, n]) => ({ label: `${k}（${n} 轮）`, value: k }));
      return {
        ...backToDashboard(st),
        mode: 'pick',
        pick: { kind: 'bcast-chat', title: `推送 · 选择目标会话（${effect.name}）`, items, idx: 0, botId: effect.botId, name: effect.name },
      };
    }
    case 'ports': {
      const channels = Array.isArray(data?.channels) ? data.channels : [];
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      if (providers.length === 0) return noticeState('没有可用引擎（先启用 provider 插件）——无法创建机器人', 'error');
      if (channels.length === 0) return noticeState('没有可用渠道（先启用 channel 插件）——无法创建机器人', 'error');
      const channel = channels[0]; // Web 人事部同款默认：第一个通道
      const genId = deps.genId ?? genBadgeId;
      return {
        ...backToDashboard(st),
        mode: 'wizard',
        wizard: {
          step: 0, pickIdx: 0,
          ports: { channels, providers },
          channel: channel.id,
          channelKeys: new Set((Array.isArray(channel.accountSchema) ? channel.accountSchema : [])
            .map((s) => s?.key).filter(Boolean)),
          id: genId(st.agents.map((a) => a?.id)),
          fields: { name: '', provider: null, cwd: '', botId: '', secret: '' },
          err: null, bot: null,
        },
      };
    }
    case 'openUrl':
      return noticeState(
        result.degraded ? `无法调起浏览器——请手动访问 ${effect.url}` : `已在浏览器打开 ${effect.url}`,
        'ok',
      );
    default:
      return st;
  }
}
