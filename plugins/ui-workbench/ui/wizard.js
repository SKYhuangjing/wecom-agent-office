// 入职向导 (company-metaphor redesign P2): 四步把一位新同事办进公司——
// ①名片（姓名+化身 roll 骰子）②技能岗位（三部门卡片）③工位与权限（cwd+
// 门禁名单）④工牌激活（企微凭证）。「办理入职」→ POST /api/bots → 成功页
// （工牌预览 + 去办公室看看）。enabled 概念后置：入职即上岗，调休/返岗在
// 花名册上随时可办。化身由工牌号（botId）决定——同一张脸跟它一生。
import { Avatar, PROVIDER_META, providerMeta, rollBadgeId, fmtDate, ensurePageStyle } from './hr.js';
import { fieldsFromSchema, SchemaFields, serializeSchema } from './form.js';

const STEPS = [
  { key: 'card', title: '名片', sub: '先认识一下：叫什么、长什么样' },
  { key: 'dept', title: '技能岗位', sub: '它会哪家手艺？' },
  { key: 'desk', title: '工位与权限', sub: '在哪个目录干活、听谁的' },
  { key: 'badge', title: '工牌激活', sub: '填上企微凭证就能上班' },
];
const NAME_MAX = 30;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');

export const Wizard = ({ WAO, ports, existingIds, onDone, onOpenFile, onCreated }) => {
  const { h, useState } = WAO;
  ensurePageStyle();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(null); // created bot record (sanitized echo)
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState(null);
  const [draft, setDraft] = useState(() => {
    const channel = ports?.channels?.[0]?.id ?? '';
    const provider = ports?.providers?.[0]?.id ?? '';
    return {
      id: rollBadgeId(existingIds), name: '',
      channel, provider,
      account: fieldsFromSchema(ports?.channels?.[0]?.accountSchema),
      providerConfig: fieldsFromSchema(ports?.providers?.[0]?.configSchema),
      allowedUsers: '',
    };
  });
  const channelSchema = ports?.channels?.find((c) => c.id === draft.channel)?.accountSchema ?? [];
  const providerSchema = ports?.providers?.find((p) => p.id === draft.provider)?.configSchema ?? [];

  const pickProvider = (id) => {
    setDraft((d) => ({
      ...d,
      provider: id,
      providerConfig: fieldsFromSchema(ports?.providers?.find((p) => p.id === id)?.configSchema),
    }));
  };

  // —— 每步校验（拒绝优于静默纠正）———————————————————————————————
  const stepErrors = (which = step) => {
    const errs = [];
    if (which === 0) {
      if (draft.name.trim() === '') errs.push('姓名必填');
      else if (draft.name.length > NAME_MAX) errs.push(`姓名过长（≤${NAME_MAX} 字）`);
      if (draft.id.trim() === '') errs.push('工牌号必填');
      else if (!ID_RE.test(draft.id.trim())) errs.push('工牌号仅限小写字母/数字/连字符，且以字母或数字开头');
      else if (existingIds.has(draft.id.trim())) errs.push(`工牌号已被占用：${draft.id.trim()}`);
    }
    if (which === 1 && draft.provider === '') errs.push('请选择一个技能岗位');
    if (which === 2) {
      const required = (providerSchema ?? []).filter((it) => it?.required === true);
      const { errors } = serializeSchema(required, draft.providerConfig);
      errs.push(...errors);
    }
    if (which === 3) {
      const { errors } = serializeSchema(channelSchema, draft.account);
      errs.push(...errors);
    }
    return errs;
  };

  const submit = async () => {
    setSubmitErrors(null);
    const account = serializeSchema(channelSchema, draft.account);
    const providerConfig = serializeSchema(providerSchema, draft.providerConfig);
    const allowed = draft.allowedUsers.split('\n').map((s) => s.trim()).filter(Boolean);
    setSubmitting(true);
    try {
      const resp = await WAO.api('/api/bots', {
        id: draft.id.trim(), name: draft.name.trim(), enabled: true,
        channel: draft.channel, account: account.values,
        allowedUsers: allowed, provider: draft.provider, providerConfig: providerConfig.values,
      });
      setDone(resp?.bot ?? { ...draft });
      onCreated?.(); // refresh the roster behind the success page
    } catch (err) {
      setSubmitErrors(errorLines(err?.message).length > 0 ? errorLines(err.message) : [String(err?.message ?? err)]);
    } finally {
      setSubmitting(false);
    }
  };

  // —— 成功页：工牌预览 + 去办公室看看 ————————————————————————————
  if (done != null) {
    const meta = providerMeta(done.provider);
    const joined = fmtDate(done.createdAt);
    return h('div', { className: 'wb-wizard-done' },
      h('div', { className: 'wb-badgecard' },
        h(Avatar, { WAO, seed: done.id, size: 96, ring: meta.color, mood: 'neutral' }),
        h('div', { className: 'wb-badgecard-body' },
          h('div', { className: 'wb-badgecard-name' }, done.name || done.id),
          h('div', { className: 'wb-sub' }, `${meta.label} · ${meta.dept}`),
          h('div', { className: 'wb-badgecard-rows' },
            h('div', null, h('span', { className: 'wb-sub' }, '工牌号 '), h('span', { className: 'wb-mono' }, done.id)),
            h('div', null, h('span', { className: 'wb-sub' }, '入职日期 '), h('span', null, joined ?? '今天')),
            h('div', null, h('span', { className: 'wb-sub' }, '状态 '), h('span', null, '已上岗，工牌激活成功'))),
          h('div', { className: 'wb-hint' },
            done.createdAt == null ? '（老数据没有入职日期记录，从今天开始记）' : null))),
      h('div', { className: 'wb-toolbar' },
        h('a', { className: 'wb-btn wb-btn-primary', href: '#/office3d' }, '去办公室看看'),
        h('button', { className: 'wb-btn', onClick: () => onOpenFile(done.id) }, '查看员工档案'),
        h('button', {
          className: 'wb-btn', onClick: () => { onDone(); },
        }, '回人事部')),
      h('p', { className: 'wb-hint' },
        '它已经在办公室里了——若企微凭证有误，它会先显示休假并在原因里说明，改好凭证即可返岗。'));
  }

  const errs = stepErrors();
  const canNext = errs.length === 0;
  const providerCards = (ports?.providers ?? []).map((p) => {
    const meta = PROVIDER_META[p.id] ?? providerMeta(p.id);
    const active = draft.provider === p.id;
    return h('button', {
      key: p.id,
      className: `wb-dept-card${active ? ' active' : ''}`,
      style: { '--pv': `var(${meta.varName})` },
      onClick: () => pickProvider(p.id),
    },
      h('span', { className: 'wb-dept-bar' }),
      h('span', { className: 'wb-dept-name' }, meta.label),
      h('span', { className: 'wb-dept-blurb' }, meta.blurb),
      h('span', { className: 'wb-dept-tech' }, meta.tech));
  });

  let body = null;
  if (step === 0) {
    body = h('div', { className: 'wb-form', style: { maxWidth: 520 } },
      h('div', { className: 'wb-wizard-card-row' },
        h(Avatar, { WAO, seed: draft.id || 'preview', size: 88, ring: 'var(--pv-unknown)', title: '这副面孔由工牌号决定，跟着它一生' }),
        h('div', { className: 'wb-field', style: { flex: 1 } },
          h('label', null, '姓名', h('span', { className: 'wb-req' }, ' *')),
          h('input', {
            className: 'wb-input', value: draft.name, maxLength: NAME_MAX,
            placeholder: '同事们怎么称呼它，如「阿澈」',
            onChange: (e) => setDraft({ ...draft, name: e.target.value }),
          }),
          h('span', { className: `wb-counter${draft.name.length > NAME_MAX ? ' over' : ''}` }, `${draft.name.length} / ${NAME_MAX}`)),
        h('button', {
          className: 'wb-btn', title: '换一副面孔（会换一个未占用的工牌号）',
          onClick: () => setDraft({ ...draft, id: rollBadgeId(existingIds) }),
        }, '🎲 换一副面孔')),
      h('div', { className: 'wb-field' },
        h('label', null, '工牌号', h('span', { className: 'wb-req' }, ' *'),
          h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '技术标识 bot id，创建后不可修改，也决定它的长相')),
        h('input', {
          className: 'wb-input wb-mono', value: draft.id,
          placeholder: '如 hr-mc3f9k', spellCheck: false,
          onChange: (e) => setDraft({ ...draft, id: e.target.value.toLowerCase() }),
        })));
  } else if (step === 1) {
    body = h('div', null,
      h('div', { className: 'wb-dept-grid' }, providerCards.length > 0 ? providerCards
        : h('div', { className: 'wb-notice' }, '没有可用的技能岗位（provider 插件）——请先到后勤部门启用至少一个岗位部门。')),
      h('p', { className: 'wb-hint' }, '岗位=provider：决定它用什么工具干活。入职后可转岗（历史对话仅文本问答对迁移）。'));
  } else if (step === 2) {
    const required = (providerSchema ?? []).filter((it) => it?.required === true);
    body = h('div', { className: 'wb-form', style: { maxWidth: 560 } },
      h(SchemaFields, {
        WAO, schema: required, state: draft.providerConfig, editingExisting: false,
        onChange: (providerConfig) => setDraft({ ...draft, providerConfig }),
      }),
      h('div', { className: 'wb-field' },
        h('label', null, '门禁名单（allowedUsers）', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '每行一个企微 userid；留空＝公司群里所有人都可以找它')),
        h('textarea', {
          className: 'wb-textarea', rows: 3, value: draft.allowedUsers,
          placeholder: '每行一个 userid，如\nzhangsan\nlisi',
          onChange: (e) => setDraft({ ...draft, allowedUsers: e.target.value }),
        })),
      h('p', { className: 'wb-hint' }, '其余岗位参数按默认值入职，之后可在员工档案里细调。'));
  } else {
    body = h('div', { className: 'wb-form', style: { maxWidth: 520 } },
      h('p', { className: 'wb-hint' }, '企微机器人凭证（channel-wecom 账号）——这是它的工牌，刷开企微的门。'),
      h(SchemaFields, {
        WAO, schema: channelSchema, state: draft.account, editingExisting: false,
        onChange: (account) => setDraft({ ...draft, account }),
      }),
      submitErrors != null ? h('div', { className: 'wb-error-box' },
        h('div', null, '办理入职未通过：'),
        h('ul', null, submitErrors.map((e, i) => h('li', { key: i }, e)))) : null);
  }

  return h('div', { className: 'wb-wizard' },
    h('div', { className: 'wb-steps' },
      STEPS.map((s, i) => h('button', {
        key: s.key,
        className: `wb-step${i === step ? ' active' : ''}${i < step ? ' visited' : ''}`,
        disabled: i > step,
        onClick: () => setStep(i),
      },
        h('span', { className: 'wb-step-num' }, i + 1),
        h('span', null, s.title))),
      h('span', { className: 'wb-step-sub' }, STEPS[step].sub)),
    body,
    errs.length > 0 && step !== 3 ? h('div', { className: 'wb-field-error' }, errs[0]) : null,
    h('div', { className: 'wb-wizard-nav' },
      h('button', { className: 'wb-btn', disabled: step === 0, onClick: () => setStep(step - 1) }, '上一步'),
      step < STEPS.length - 1
        ? h('button', {
          className: 'wb-btn wb-btn-primary', disabled: !canNext || (ports?.providers?.length ?? 0) === 0,
          onClick: () => setStep(step + 1),
        }, '下一步')
        : h('button', {
          className: 'wb-btn wb-btn-primary', disabled: submitting || errs.length > 0,
          onClick: () => void submit(),
        }, submitting ? '办理中…' : '办理入职')));
};

export default Wizard;
