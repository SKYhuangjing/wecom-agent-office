// hr.js — 人事部共享件 (company-metaphor redesign P2): provider 岗位元数据、
// 「头像即化身」的 React 装配、公司话状态标签。UI 主层一律公司话，技术词
// （provider id、status 原值、chatKey…）收进 tooltip/副标题——双层语言，
// 运维不歧义。
import { ensurePageStyle } from './style.js';

// 引擎（provider）——唯一 accent 家族，编码真实身份
export const PROVIDER_META = {
  dsh: {
    label: 'DSH 引擎', color: 'var(--pv-dsh)', varName: '--pv-dsh',
    dept: 'DeepSeek 系', tech: 'dsh · DeepSeek Harness',
    blurb: '稳定耐跑：DeepSeek Harness 擅长长任务，日志详尽，适合日常开发与维护。',
  },
  claude: {
    label: 'Claude 引擎', color: 'var(--pv-claude)', varName: '--pv-claude',
    dept: 'Anthropic 系', tech: 'claude · Claude Code',
    blurb: 'Claude Code 擅长代码理解与重构，适合精修、评审与疑难定位。',
  },
  codex: {
    label: 'Codex 引擎', color: 'var(--pv-codex)', varName: '--pv-codex',
    dept: 'OpenAI 系', tech: 'codex · OpenAI Codex CLI',
    blurb: 'Codex CLI 适合脚本、批量改动与快速验证。',
  },
  pi: {
    label: 'pi 引擎', color: 'var(--pv-pi)', varName: '--pv-pi',
    dept: '轻量系', tech: 'pi · pi coding agent',
    blurb: 'pi CLI 短平快、会话好续接，网关随配随走，适合轻量任务与自由路由。',
  },
};
export const providerMeta = (id) => (PROVIDER_META[id] ?? {
  label: id ? `${id} 引擎` : '未选择引擎', color: 'var(--pv-unknown)', varName: '--pv-unknown',
  dept: '外部来源', tech: id ?? '—', blurb: '来自外部的引擎。',
});

// 状态公司话：工作中 / 待命 / 休假。技术原值与原因进 title。
export const STATUS_LABEL = { working: '工作中', idle: '待命', offline: '离线' };
export const statusTitle = (a) => {
  const tech = a?.status ?? 'offline';
  const reason = a?.reason ? `\n原因：${a.reason}` : '';
  const duty = a?.enabled === false ? '\n当前已暂停（未启用）' : '';
  return `状态：${tech}${reason}${duty}`;
};

// 化身头像：seed=botId，全站同脸；provider 色描边环
export const Avatar = ({ WAO, seed, size = 40, mood, ring, className = '', title }) => {
  const { h } = WAO;
  return h('span', {
    className: `wao-av${ring ? ' wao-av-ring' : ''}${className ? ` ${className}` : ''}`,
    title,
    style: {
      width: `${size}px`, height: `${size}px`,
      ...(ring ? { borderColor: ring } : {}),
    },
    dangerouslySetInnerHTML: { __html: WAO.avatar(seed, { size, mood }) },
  });
};

export const fmtDate = (at) => (Number.isFinite(at) && at > 0
  ? new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  : null);

// 工牌号建议：roll 骰子生成一个可读的小写 id（创建后不可改，化身由它决定）
export const rollBadgeId = (taken) => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let i = 0; i < 64; i++) {
    let s = '';
    for (let k = 0; k < 6; k++) s += abc[Math.floor(Math.random() * abc.length)];
    const id = `hr-${s}`;
    if (!taken?.has?.(id)) return id;
  }
  return `hr-${Date.now().toString(36)}`;
};

export { ensurePageStyle };
