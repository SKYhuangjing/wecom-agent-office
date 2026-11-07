// 入职向导 (company-metaphor redesign P2; W3 T4 增第 3.5 步; v2 渠道化+装备必选):
// 五步把一位新同事办进公司——①名片（姓名+化身 roll 骰子）②技能岗位（部门卡片）
// ③配发装备（必选：推荐装备包按类型一键整包 + 逐件精挑，至少一件；公司还没
// 登记过资产或所选岗位不支持装备时放行并说明）④工位与权限（cwd+门禁名单）
// ⑤通信渠道（IM 渠道卡片 → 选中渠道的 accountSchema 凭证动态渲染）。
// 「办理入职」→ POST /api/bots →（选了装备则逐件 POST /api/bots/:id/assets，
// 失败不回滚入职，成功页点名补配）→成功页（工牌预览 + 去办公室看看）。
// enabled 概念后置：入职即上岗，调休/返岗在花名册上随时可办。化身由工牌号
// （botId）决定——同一张脸跟它一生。
import { Avatar, PROVIDER_META, providerMeta, rollBadgeId, fmtDate, ensurePageStyle } from './hr.js';
import { fieldsFromSchema, SchemaFields, serializeSchema } from './form.js';
import { TYPE_LABEL } from './assets.js';

const STEPS = [
  { key: 'card', title: '名片', sub: '先认识一下：叫什么、长什么样' },
  { key: 'dept', title: '技能岗位', sub: '它会哪家手艺？' },
  { key: 'equip', title: '配发装备', sub: '至少配发一件——推荐装备包可一键整包带走' },
  { key: 'desk', title: '工位与权限', sub: '在哪个目录干活、听谁的' },
  { key: 'channel', title: '通信渠道', sub: '选择机器人接入哪个 IM 平台' },
];
const NAME_MAX = 30;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// 通信渠道（channel）卡片元数据：/api/ports 的 channels 只有 {id, owner,
// accountSchema}（没有展示名），公司话标签在这里维护；未登记的渠道退回 id
// 原文（双层语言：技术词收进副标题，运维不歧义）。
const CHANNEL_META = {
  wecom: {
    label: '企业微信', color: '#0082EF', tech: 'wecom · 企业微信机器人',
    blurb: '公司群里 @ 它或私聊它都能接单——填上机器人凭证，工牌就激活了。',
  },
};
const channelMeta = (id) => (CHANNEL_META[id] ?? {
  label: id || '未选渠道', color: 'var(--pv-unknown)', tech: id ?? '—',
  blurb: '来自外部部门的通信渠道。',
});

// 推荐装备包（v2）：按资产类型分组一键整包勾选。前三类是主力装备（产品口径）；
// 其余类型（memory/prompt/…）退回资产科口径 TYPE_LABEL + 通用图标——分组覆盖
// 全部在册类型，不静默漏掉谁。
const EQUIP_PACKS = [
  { type: 'skill', icon: '📘', label: '技能' },
  { type: 'mcp', icon: '🔌', label: '工具连接' },
  { type: 'tool', icon: '🛠️', label: '效率装备' },
];
const packMeta = (type) => EQUIP_PACKS.find((p) => p.type === type)
  ?? { type, icon: '📦', label: TYPE_LABEL[type] ?? type };

const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');

export const Wizard = ({ WAO, ports, existingIds, onDone, onOpenFile, onCreated, initialStep = 0 }) => {
  const { h, useState, useEffect, api } = WAO;
  ensurePageStyle();
  // initialStep：?select=new&step=N 直达第 N 步（截图基线用；越界回第 1 步）
  const [step, setStep] = useState(() => (
    Number.isInteger(initialStep) && initialStep >= 0 && initialStep < STEPS.length ? initialStep : 0
  ));
  const [done, setDone] = useState(null); // created bot record (sanitized echo)
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState(null);
  const [bindFailures, setBindFailures] = useState([]); // 入职后配发失败清单（不阻断入职）
  const [assets, setAssets] = useState(null); // null=读取中 []=空清单
  useEffect(() => {
    let alive = true;
    api('/api/assets')
      .then((data) => { if (alive) setAssets(Array.isArray(data?.assets) ? data.assets : []); })
      .catch(() => { if (alive) setAssets([]); }); // 资产面不可用不拦入职——这步可跳过
    return () => { alive = false; };
  }, []);
  const [draft, setDraft] = useState(() => {
    const channel = ports?.channels?.[0]?.id ?? '';
    const provider = ports?.providers?.[0]?.id ?? '';
    return {
      id: rollBadgeId(existingIds), name: '',
      channel, provider,
      account: fieldsFromSchema(ports?.channels?.[0]?.accountSchema),
      providerConfig: fieldsFromSchema(ports?.providers?.[0]?.configSchema),
      allowedUsers: '',
      equip: [], // 选中的资产 id（第 3.5 步）
      equipMode: 'shared', // 默认配发（跟源更新）——与装备台口径一致（盲评 P2-4）
    };
  });
  const channelSchema = ports?.channels?.find((c) => c.id === draft.channel)?.accountSchema ?? [];
  const providerSchema = ports?.providers?.find((p) => p.id === draft.provider)?.configSchema ?? [];
  // 所选岗位是否支持装备（/api/ports assets:false = provider 无 materializeAssets）
  const providerSupportsAssets = ports?.providers?.find((p) => p.id === draft.provider)?.assets !== false;

  // 换渠道即换凭证面：account 表单按新渠道的 accountSchema 重建。
  const pickChannel = (id) => setDraft((d) => ({
    ...d,
    channel: id,
    account: fieldsFromSchema(ports?.channels?.find((c) => c.id === id)?.accountSchema),
  }));

  const pickProvider = (id) => {
    setDraft((d) => ({
      ...d,
      provider: id,
      providerConfig: fieldsFromSchema(ports?.providers?.find((p) => p.id === id)?.configSchema),
      // 换到不支持装备的岗位（provider 无 materializeAssets，/api/ports
      // assets:false）：清掉已勾选——留着只会在入职后逐件绑定失败。
      ...(ports?.providers?.find((p) => p.id === id)?.assets === false ? { equip: [] } : {}),
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
      // v2 必选：至少一件。两种「无装备可配」放行——公司一件资产都没登记过
      // （新部署；资产面故障同样回空清单，不能拦入职），或所选岗位不支持装
      // 备（整面已禁勾，不能卡死入职）。
      if (assets != null && assets.length > 0 && providerSupportsAssets && draft.equip.length === 0) {
        errs.push('请至少配发一件装备——新同事不能什么都不会');
      }
    }
    if (which === 3) {
      const required = (providerSchema ?? []).filter((it) => it?.required === true);
      const { errors } = serializeSchema(required, draft.providerConfig);
      errs.push(...errors);
    }
    if (which === 4) {
      if (draft.channel === '') errs.push('请选择一个通信渠道');
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
      // 第 3.5 步装备：入职成功后逐件配发——失败不回滚入职（人已办进来了），
      // 成功页点名哪些没配上、到资产科装备台补配。Agent 自建资产（origin:mcp）
      // 固定私发——服务端 §8.1 分级拒 shared（盲评 P2-4：默认改配发后这里不能
      // 让 Agent 资产踩 400）。
      const failures = [];
      for (const assetId of draft.equip) {
        const asset = (assets ?? []).find((a) => a.id === assetId);
        const mode = asset?.origin === 'mcp' ? 'exclusive' : draft.equipMode;
        try {
          await WAO.api(`/api/bots/${encodeURIComponent(draft.id.trim())}/assets`, { assetId, mode });
        } catch (err) {
          failures.push(`${asset?.name ?? assetId}：${err?.message ?? err}`);
        }
      }
      setBindFailures(failures);
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
      bindFailures.length > 0 ? h('div', { className: 'wb-notice' },
        h('div', null, `${bindFailures.length} 件装备未配成——同事已入职，可稍后到资产科装备台补配：`),
        h('ul', { className: 'wb-offboard-list' }, bindFailures.map((f, i) => h('li', { key: i }, f)))) : null,
      draft.equip.length > 0 && bindFailures.length === 0
        ? h('p', { className: 'wb-hint' }, `已随入职配发 ${draft.equip.length} 件装备（${draft.equipMode === 'exclusive' ? '私发' : '配发'}）。`)
        : null,
      h('div', { className: 'wb-toolbar' },
        h('a', { className: 'wb-btn wb-btn-primary', href: '#/office3d' }, '去办公室看看'),
        h('button', { className: 'wb-btn', onClick: () => onOpenFile(done.id) }, '查看员工档案'),
        h('button', {
          className: 'wb-btn', onClick: () => { onDone(); },
        }, '回人事部')),
      h('p', { className: 'wb-hint' },
        '它已经在办公室里了——若渠道凭证有误，它会先显示休假并在原因里说明，改好凭证即可返岗。'));
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
    // 第 3 步（v2 必选）：配发装备。推荐装备包按类型分组一键整包勾选，逐件
    // 清单仍可精挑（默认配发·跟源更新，与装备台口径一致）。至少一件才能下一
    // 步——例外见 stepErrors。所选岗位不支持装备（provider 无 materializeAssets）
    // 时整面禁勾（/api/ports assets:false——判定源同绑定校验面 checkBind）。
    const toggleEquip = (id, on) => setDraft((d) => ({
      ...d,
      equip: on ? [...d.equip, id] : d.equip.filter((x) => x !== id),
    }));
    // 整包开关：全在→整包收起，否则整包勾选（并保留已勾的其他类型）。
    const togglePack = (type) => setDraft((d) => {
      const ids = (assets ?? []).filter((a) => a.type === type).map((a) => a.id);
      const allOn = ids.length > 0 && ids.every((id) => d.equip.includes(id));
      return { ...d, equip: allOn ? d.equip.filter((id) => !ids.includes(id)) : [...new Set([...d.equip, ...ids])] };
    });
    const packOrder = EQUIP_PACKS.map((p) => p.type);
    for (const a of assets ?? []) if (!packOrder.includes(a.type)) packOrder.push(a.type);
    const packGroups = packOrder
      .map((type) => ({ ...packMeta(type), list: (assets ?? []).filter((a) => a.type === type) }))
      .filter((g) => g.list.length > 0);
    const mcpOnly = (a) => a.origin === 'mcp'; // Agent 自建资产仅可私发
    body = h('div', { className: 'wb-form', style: { maxWidth: 620 } },
      assets == null
        ? h('p', { className: 'muted' }, '盘点资产清单中…')
        : assets.length === 0
          ? h('div', { className: 'wb-notice' },
              '平台暂无可配装备，可直接入职，之后到资产科登记')
          : h('div', null,
              !providerSupportsAssets ? h('div', { className: 'wb-notice', style: { marginBottom: 8 } },
                `该岗位暂不支持装备（${draft.provider} 未实现资产物化）——这步先过，入职后转岗或到资产科处理。`) : null,
              providerSupportsAssets ? h('div', { className: 'wb-field' },
                h('label', null, '推荐装备包', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '按类型一键整包勾选 / 收起')),
                h('div', { className: 'wb-toolbar', style: { flexWrap: 'wrap' } },
                  packGroups.map((g) => {
                    const allOn = g.list.every((a) => draft.equip.includes(a.id));
                    return h('button', {
                      key: g.type, className: 'wb-btn',
                      onClick: () => togglePack(g.type),
                      title: allOn ? `取消整包：${g.label}（${g.list.length} 件）` : `一键勾选全部${g.label}（${g.list.length} 件）`,
                    }, `${allOn ? '✓ ' : ''}${g.icon} ${g.label} · ${g.list.length} 件`);
                  }))) : null,
              h('div', { className: 'wb-group open' },
                h('div', { className: 'wb-group-body' },
                  assets.map((a) => {
                    const disabled = !providerSupportsAssets;
                    return h('label', {
                      key: a.id, className: 'wb-check', style: { alignItems: 'flex-start', ...(disabled ? { opacity: 0.55 } : {}) },
                      title: disabled ? '该岗位暂不支持装备'
                        : `${a.type} · ${a.name}${a.description ? ` · ${a.description}` : ''}`,
                    },
                      h('input', {
                        type: 'checkbox', checked: draft.equip.includes(a.id), disabled,
                        onChange: (e) => toggleEquip(a.id, e.target.checked),
                      }),
                      h('span', null,
                        h('span', { className: `badge wb-atype-${a.type}` }, TYPE_LABEL[a.type] ?? a.type), ' ',
                        h('span', { className: 'wb-mono' }, a.name),
                        disabled ? h('span', { className: 'wb-hint' }, '（该岗位暂不支持装备）')
                          : mcpOnly(a) ? h('span', { className: 'wb-hint' }, '（Agent 自建·仅可私发）') : null,
                        a.description ? h('div', { className: 'wb-hint' }, a.description) : null));
                  })),
                h('div', { className: 'wb-field', style: { maxWidth: 360 } },
                  h('label', null, '配发方式', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '对上面勾选的每件资产生效（Agent 自建资产固定私发）')),
                  h('select', {
                    className: 'wb-select', value: draft.equipMode,
                    onChange: (e) => setDraft((d) => ({ ...d, equipMode: e.target.value })),
                  },
                    h('option', { value: 'shared' }, '配发（默认·跟源更新）'),
                    h('option', { value: 'exclusive' }, '私发（快照独立，不随源改动漂移）')))),
              h('p', { className: 'wb-hint' },
                '装备会写进它的工位（技能文件/配置/钩子），下一轮接单即可用；至少配发一件——整包配发后仍可逐件微调。')));
  } else if (step === 3) {
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
    // 第 5 步（v2 渠道化）：先选 IM 渠道（卡片，同技能岗位样式），选中后在其
    // 下方按该渠道 accountSchema 动态渲染凭证字段（/api/ports channels——目前
    // 只有企微一家）。仅一个渠道时默认已选（draft 初始化取 channels[0]）。
    const channels = ports?.channels ?? [];
    const channelCards = channels.map((c) => {
      const meta = channelMeta(c.id);
      const active = draft.channel === c.id;
      return h('button', {
        key: c.id,
        className: `wb-dept-card${active ? ' active' : ''}`,
        style: { '--pv': meta.color },
        onClick: () => pickChannel(c.id),
      },
        h('span', { className: 'wb-dept-bar' }),
        h('span', { className: 'wb-dept-name' }, meta.label),
        h('span', { className: 'wb-dept-blurb' }, meta.blurb),
        h('span', { className: 'wb-dept-tech' }, meta.tech));
    });
    const chosen = channelMeta(draft.channel);
    body = h('div', { className: 'wb-form', style: { maxWidth: 560 } },
      h('div', { className: 'wb-dept-grid' }, channelCards.length > 0 ? channelCards
        : h('div', { className: 'wb-notice' }, '没有可用的通信渠道（channel 插件）——请先到后勤部门启用至少一个渠道。')),
      channels.length > 1 ? h('p', { className: 'wb-hint' }, '换渠道会按新渠道的凭证表单重新填写。') : null,
      draft.channel !== '' ? h('p', { className: 'wb-hint' },
        `${chosen.label}机器人凭证（channel-${draft.channel} 账号）——这是它的工牌，刷开${chosen.label}的门。`) : null,
      draft.channel !== '' ? h(SchemaFields, {
        WAO, schema: channelSchema, state: draft.account, editingExisting: false,
        onChange: (account) => setDraft({ ...draft, account }),
      }) : null,
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
    errs.length > 0 && step !== STEPS.length - 1 ? h('div', { className: 'wb-field-error' }, errs[0]) : null,
    h('div', { className: 'wb-wizard-nav' },
      h('button', { className: 'wb-btn', disabled: step === 0, onClick: () => setStep(step - 1) }, '上一步'),
      step < STEPS.length - 1
        ? h('button', {
          className: 'wb-btn wb-btn-primary',
          disabled: !canNext || (ports?.providers?.length ?? 0) === 0 || (ports?.channels?.length ?? 0) === 0,
          onClick: () => setStep(step + 1),
        }, '下一步')
        : h('button', {
          className: 'wb-btn wb-btn-primary', disabled: submitting || errs.length > 0,
          onClick: () => void submit(),
        }, submitting ? '办理中…' : '办理入职')));
};

export default Wizard;
