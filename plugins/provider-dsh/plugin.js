// provider-dsh (Task 18): the first REAL provider plugin — DeepSeek Harness
// via `dsh --profile P --json -`. The heavy lifting lives next door:
//   runner.js   spawn/NDJSON→unified events/code mapping/kill escalation
//   profiles.js per-bot dsh profile materialization (atomicWrite, last-good)
//   history.js  zstd multi-frame session history reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook and the
// code→中文 describeError copy (前身 bridge.js _friendly/_describeFailure).
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunner } from './runner.js';
import { buildBotPatch, profilePatchPath, writeBotProfile, removeProfile } from './profiles.js';

const PORT_ID = 'dsh';
const PERMS = ['workspace-write', 'read-only', 'danger-full-access'];

// —— asset faces (DESIGN-ASSETS §3.3 dsh column, W3 T2/T6) ————————————————
// dsh asset surfaces: prompt-like assets (skill index / prompt / memory /
// ripgrep guidance) ride the profile's system-prompt personaPrefix, skills
// additionally land as files in the WAO-namespace .wao/skills/ tree, and —
// W3 T6 — MCP servers ride `mcp-<serverId>` profile rows via
// @deepseek-ai/dsh-mcp-client (dsh 原生 MCP 面; the pre-T6 「无 MCP 面」
// ruling is lifted). rtk stays refused (F27).

// SKILL.md (§4.1): frontmatter name/description + the x-wao-asset annotation
// (claude F14 ignores unknown frontmatter keys; dsh only ever reads this file
// through the personaPrefix index) + body.
export function skillMarkdown(entry) {
  const c = entry.content ?? {};
  const name = c.name ?? entry.name;
  return [
    '---',
    `name: ${name}`,
    ...(c.description !== undefined && c.description !== '' ? [`description: ${JSON.stringify(String(c.description))}`] : []),
    `x-wao-asset: ${entry.assetId}`,
    '---',
    '',
    String(c.body ?? ''),
    '',
  ].join('\n');
}

// rg 安装指引按平台给出（P2 跨平台）：macOS brew / Linux apt / Windows
// winget·scoop。文本在物化时烤进 system prompt，四家 provider 字节一致
//（复制即契约）。
export const rgInstallHint = (platform = process.platform) => platform === 'win32'
  ? 'winget install BurntSushi.ripgrep.MSVC（或 scoop install ripgrep）'
  : platform === 'linux' ? 'sudo apt-get install ripgrep（或你的发行版包管理器）'
    : 'brew install ripgrep';

// Memory distillation footer (DESIGN-TOKEN-OPT §4.3): same copy as the other
// providers — dsh memory rides personaPrefix instead of a file, the marker
// protocol is identical.
export const MEMORY_DISTILL_FOOTER = [
  '',
  '---',
  '沉淀规则：本轮若产生了跨会话有价值的东西，在回复最末尾另起一行输出沉淀标记（同事看不到这行，系统会自动收集进上面的记忆）。最该沉淀的是「操作路径」——用什么工具/命令/参数达成某事：新会话丢失上下文后最需要它，能避免重新摸索（翻历史、找脚本）；其次是业务口径、用户偏好、已确认的事实或决定：',
  '<!--wao-memory:查某业务日志 → 用 MCP 工具 mcp__xxx__sls_execute_sql，project=P、logStore=L、时间范围 now-1h-->',
  '<!--wao-memory:问题关键词 → 结论（≤100字）-->',
  '可以多行多条；没有值得沉淀的就完全不输出，绝不为输出而输出。日常寒暄、一次性的查数结果不要沉淀。',
].join('\n');

export const RIPGREP_GUIDANCE = [
  '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'、rg -n "text" src/。',
  `rg 未安装时先执行：${rgInstallHint()}。`,
].join('\n');

// §7.2 ripgrep 预检（spawn 探测 3s，不失败绑定）：结论随 tools 进 manifest，
// 缺失时 notes 指引安装（personaPrefix 指引节仍注入——装上即生效）。
const probeRg = () => {
  try {
    const r = spawnSync('rg', ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.error != null || r.status !== 0) return { available: false, version: null };
    return { available: true, version: (r.stdout ?? '').trim().split('\n')[0] || null };
  } catch {
    return { available: false, version: null };
  }
};

// §3.3 单一组合器 (P0-4): the personaPrefix line is generated ONLY here —
// `providerConfig.prompt`（运营者人设，永远在前）→ plan 资产节（skill 索引 /
// prompt / memory / ripgrep 指引，按绑定序）. materializeConfig (providerConfig
// path) and materializeAssets (asset path) BOTH rebuild through this one
// function — 「dsh 改模型丢资产节」cannot happen. Empty plan ⇒ operator prompt
// alone (byte-identical to the pre-asset era).
export function combinePersonaPrefix(operatorPrompt, plan = []) {
  const sections = [];
  for (const entry of Array.isArray(plan) ? plan : []) {
    const c = entry?.content ?? {};
    switch (entry?.type) {
      case 'skill': {
        const name = c.name ?? entry.name;
        sections.push([
          `【WAO 技能：${name}】`,
          String(c.description ?? `技能 ${name}`),
          `技能正文在 .wao/skills/${name}/SKILL.md——需要时先读该文件再执行。`,
        ].join('\n'));
        break;
      }
      case 'prompt':
        sections.push([`【WAO 提示词约束：${entry.name}】`, String(c.text ?? '')].join('\n'));
        break;
      case 'memory':
        sections.push([
          `【WAO 跨会话记忆：${entry.name}】`,
          ...(Array.isArray(c.notes) && c.notes.length > 0 ? c.notes : ['（暂无条目）']),
          MEMORY_DISTILL_FOOTER,
        ].join('\n'));
        break;
      case 'tool':
        if (c.kind === 'ripgrep') {
          sections.push(['【WAO 工具指引：ripgrep】', RIPGREP_GUIDANCE, ...(c.options?.extraHints ? [String(c.options.extraHints)] : [])].join('\n'));
        }
        break; // rtk never reaches (§2.3 bind refusal)
      default:
        break; // mcp never reaches the PREFIX — it rides mcp-<serverId> profile rows (§3.3, W3 T6)
    }
  }
  const operator = String(operatorPrompt ?? '').trim();
  if (sections.length === 0) return operator;
  return [operator, sections.join('\n\n')].filter(Boolean).join('\n\n');
}

export default {
  manifest: {
    id: 'provider-dsh',
    name: 'DSH Provider',
    type: 'provider',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { provider: '^1' }, plugins: { 'core-engine': '^1' } },
  },

  activate(ctx) {
    ctx.registerProvider(PORT_ID, {
      // Shape of the providerConfig block a bot carries in bots.json
      // (PLUGIN-DEV §8). The profile default is dynamic (wecom-<botId>), so
      // it lives in the label, not in a static `default`.
      configSchema: [
        { key: 'cwd', label: '工作目录（agent 作业目录，也是沙箱 workspaceRoot）', type: 'string', required: true },
        { key: 'profile', label: 'dsh profile 名（默认 wecom-<botId>）', type: 'string' },
        // model：结构化子字段（2026-11-10 UI 治理）。
        { key: 'model', label: '模型', type: 'object',
          hint: '提供方+模型名即可（默认 magpie 网关）；其余可选',
          fields: [
            { key: 'provider', label: '提供方', type: 'string', placeholder: '如 magpie' },
            { key: 'model', label: '模型名', type: 'string', placeholder: '如 workbuddy/deepseek-v4.1-flash' },
            { key: 'baseURL', label: '网关地址（可选）', type: 'string' },
            { key: 'apiKey', label: '网关密钥（可选）', type: 'password' },
            { key: 'apiKeyEnv', label: '密钥环境变量名（可选）', type: 'string' },
          ] },
        { key: 'permission', label: '权限', type: 'enum', options: PERMS, default: 'workspace-write' },
        { key: 'prompt', label: '人设（多行，写入 profile system-prompt personaPrefix）', type: 'string', multiline: true, rows: 5 },
        { key: 'writableDirs', label: '沙箱额外可写目录（绝对路径列表）', type: 'list' },
        { key: 'compaction', label: '自动压缩 {enabled?, thresholdRatio?, headroomTokens?, retainRatio?}', type: 'object' },
        // progressStyle/progressText (2026-11-06 拟人播报)：进度行风格与播报
        // 文案，core-engine 出站面消费（polite=企微只播报一句「思考中…请稍
        // 等」，不露思维链/工具内容；cot=旧 §6.1 详细汇报）。
        { key: 'progressStyle', label: '工作汇报风格（拟人播报=polite：只播报「思考中…请稍等」，企微不露思维链；详细汇报=cot：进度行展示思维链/工具摘要）', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressText', label: '播报文案（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字）', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
        // progressCoT 已废弃（2026-11-06，被 progressStyle 取代，保留兼容）：
        // 仅在 cot 风格内抑制 💭 行，不再能把进度行变回详细汇报——默认已
        // 翻转为 polite（owner 决策）。consumed by the core-engine wiring.
        { key: 'dshBin', label: 'dsh 可执行文件（PATH 或绝对路径）', type: 'string', default: 'dsh' },
        { key: 'nodeBin', label: 'node 可执行文件（profile 引导 PATH 用）', type: 'string' },
      ],

      // Semantic validation on top of the schema types: enum membership,
      // custom-model completeness, and the 前身教训 — a hand-declared model
      // without contextWindow makes compaction silently skip ("no context
      // capacity"), so it is rejected instead of silently corrected.
      validate(providerConfig) {
        const errors = [];
        const pc = providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') errors.push('providerConfig.cwd is required');
        if (pc.permission != null && !PERMS.includes(pc.permission)) {
          errors.push(`providerConfig.permission must be one of ${PERMS.join(', ')}`);
        }
        const m = pc.model;
        if (m != null && typeof m === 'object' && !Array.isArray(m)) {
          if ((m.baseURL || m.api) && !(m.baseURL && m.api)) {
            errors.push('自定义模型需同时提供 baseURL 和 api（缺一不可）');
          }
          if (m.baseURL && !(Number(m.contextWindow) > 0)) {
            errors.push('自定义模型需提供 contextWindow > 0（前身教训：缺省时 compaction 报 no context capacity 并静默跳过）');
          }
        }
        // 播报文案模板上限（超长即 400，拒绝优于静默截断）
        if (typeof pc.progressText === 'string' && pc.progressText.length > 120) {
          errors.push(`providerConfig.progressText 播报文案最长 120 字（当前 ${pc.progressText.length}）`);
        }
        return errors;
      },

      // dsh-style config file materialization (DESIGN §5): write the per-bot
      // dsh profile atomically before the bot's first run. A throw keeps the
      // last-good file and bubbles to the API as a 400 with this message —
      // writeBotProfile errors name the path they worked from.
      // §3.3 单一组合器: `assets` is the core-engine effective plan (§3.1
      // materializeConfig extension) — a providerConfig change rebuilds the
      // FULL personaPrefix (operator prompt + asset sections), so 「改模型丢
      // 资产节」cannot happen. Absent/empty plan = operator prompt alone.
      // W3 T6: the SAME plan flows as assetsPlan so the mcp-<serverId> rows
      // ride this rebuild too — a bot PATCH can never drop MCP rows (P0-4
      // 同型防线: the patch is a whole-file REPLACE).
      async materializeConfig(bot, { log, assets } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') {
          throw new Error('materializeConfig: bot.id is required');
        }
        const pc = bot.providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') {
          throw new Error(`materializeConfig: bot ${bot.id} has no providerConfig.cwd`);
        }
        const profile = pc.profile || `wecom-${bot.id}`;
        const prompt = combinePersonaPrefix(pc.prompt, assets);
        const res = writeBotProfile({
          profile,
          model: pc.model,
          permission: pc.permission,
          prompt,
          assetsPlan: assets,
          writableDirs: pc.writableDirs,
          workspaceRoot: pc.cwd,
          dshBin: pc.dshBin || 'dsh',
          nodeBin: pc.nodeBin || process.execPath,
          compaction: pc.compaction,
        });
        log?.info?.(`provider-dsh: materialized profile ${profile} → ${res.path}`);
        return { changed: true, profile, path: res.path };
      },

      // 资产物化 (DESIGN-ASSETS §3.1/§3.3, W3 T2/T6): PURE PLANNER — returns the
      // write plan, core-engine's materializer owns every disk mutation (jail
      // guard, atomicity, manifest). dsh = whole-file profile rewrite (the
      // personaPrefix is a single config row, YAML 整文件重写纪律 §3.4) +
      // .wao/skills/ SKILL.md files. mcp 资产 (W3 T6) 不另落文件——每 server 一
      // 条 mcp-<serverId> 行随同一 patch 重建（REPLACE 语义下只有单一组合器能
      // 保住它们）。plan 是只读引用：一切变形在副本上 (§3.1).
      async materializeAssets(bot, plan, { log } = {}) {
        const pc = bot?.providerConfig ?? {};
        if (typeof bot?.id !== 'string' || bot.id === '') throw new Error('materializeAssets: bot.id is required');
        if (typeof pc.cwd !== 'string' || pc.cwd === '') throw new Error(`materializeAssets: bot ${bot.id} has no providerConfig.cwd`);
        for (const entry of plan ?? []) {
          if (entry?.type === 'tool' && entry?.content?.kind === 'rtk') throw new Error('dsh 引擎不支持 rtk 工具资产（rtk 支持列表不含 dsh，F27）');
        }
        const profile = pc.profile || `wecom-${bot.id}`;
        const writes = [{
          kind: 'file-create',
          target: profilePatchPath(profile),
          // the SAME combiner as materializeConfig — both paths produce the
          // complete personaPrefix (契约用例「dsh 改模型→资产节逐字节仍在」)
          // AND the mcp-<serverId> rows (assetsPlan, W3 T6 — bot PATCH 重物
          // 化不掉 MCP 行). Env/headers values ride the 0600 patch verbatim
          // (dsh-mcp-client 无引用语义, 明文即契约).
          content: buildBotPatch({
            profile,
            model: pc.model,
            permission: pc.permission,
            prompt: combinePersonaPrefix(pc.prompt, plan),
            assetsPlan: plan,
            writableDirs: pc.writableDirs,
            workspaceRoot: pc.cwd,
            sourceProfile: 'headless',
            compaction: pc.compaction,
          }),
        }];
        const notes = [];
        const tools = [];
        for (const entry of plan ?? []) {
          if (entry.type === 'tool' && entry.content?.kind === 'ripgrep') {
            const rg = probeRg();
            tools.push({ assetId: entry.assetId, kind: 'ripgrep', state: rg.available ? 'available' : 'unavailable', version: rg.version });
            if (!rg.available) {
              notes.push({ assetId: entry.assetId, detail: `rg 未安装：ripgrep 指引已注入但本机无效（预检不失败）——${rgInstallHint()} 后生效` });
            }
          }
          if (entry.type === 'mcp') {
            const servers = Object.keys(entry.content?.servers ?? {}).sort();
            if (servers.length > 0) {
              notes.push({ assetId: entry.assetId, detail: `MCP → profile 行 mcp-{${servers.join(',')}}（@deepseek-ai/dsh-mcp-client，dsh 启动即连；env/headers 明文随 0600 patch 落盘）` });
            }
          }
          if (entry.type !== 'skill') continue;
          const name = entry.content?.name ?? entry.name;
          writes.push({
            kind: 'file-create',
            target: join(pc.cwd, '.wao', 'skills', name, 'SKILL.md'),
            content: skillMarkdown(entry),
            for: entry.assetId,
          });
          notes.push({ assetId: entry.assetId, detail: `技能 ${name} → .wao/skills/${name}/SKILL.md（WAO 命名空间目录）` });
        }
        log?.info?.(`provider-dsh: asset plan for ${bot.id} → ${writes.length} writes（personaPrefix 与 MCP 行经单一组合器重建）`);
        return { writes, notes, entries: [], tools };
      },

      // materializeConfig's counterpart: DELETE /api/bots/:id takes the bot's
      // materialized profile with it — no orphaned ~/.dsh/profiles/wecom-<botId>
      // outlives the bot record. Best-effort by contract; removeProfile returns
      // false when nothing was there (never an error).
      removeConfig(bot, { log } = {}) {
        const profile = bot?.providerConfig?.profile || `wecom-${bot?.id}`;
        const removed = removeProfile(profile);
        log?.info?.(`provider-dsh: removeConfig profile ${profile} → ${removed ? 'removed' : 'absent'}`);
        return { removed };
      },

      // 知识呈现面（DESIGN-KNOWLEDGE §4.2）：dsh 的知识面就是 profile 的
      // system-prompt personaPrefix（单一组合器全文）——技能另有盘面索引文件。
      knowledgeFace(bot, { plan }) {
        const pc = bot.providerConfig ?? {};
        const entries = Array.isArray(plan) ? plan : [];
        const prefix = combinePersonaPrefix(pc.prompt, entries);
        const sections = [{
          kind: 'profile', title: 'dsh profile system-prompt · personaPrefix（完整系统提示词）',
          text: prefix || '（空——未配置人设，也未绑定资产）',
        }];
        const skillPaths = entries.filter((e) => e?.type === 'skill')
          .map((e) => join(pc.cwd, '.wao', 'skills', e.content?.name ?? e.name, 'SKILL.md'));
        if (skillPaths.length > 0) sections.push({ kind: 'file', title: '技能正文（.wao/skills/*/SKILL.md）', paths: skillPaths });
        if (entries.some((e) => e?.type === 'mcp')) {
          sections.push({
            kind: 'file', title: 'MCP 行（mcp-<serverId> profile 行，含密钥不预览内容）',
            paths: [profilePatchPath(pc.profile || `wecom-${bot.id}`)], secret: true,
          });
        }
        sections.push({
          kind: 'stdin', title: '任务信封（stdin）',
          text: '每轮任务 = [会话自愈 handoff 前缀] + 用户消息 + [附件段] + [失败注记段]，以 \n\n---\n\n 连接后经 stdin 传入；上面的人设/记忆/技能索引已在 profile system-prompt 里。',
        });
        return {
          delivery: 'dsh：人设+记忆+提示词约束+技能索引全部拼进 profile 的 system-prompt personaPrefix（单一组合器）；技能正文落 .wao/skills/；MCP 走 mcp-<serverId> profile 行。',
          sections,
        };
      },

      createRunner({ bot, providerConfig, log }) {
        return createRunner({ bot, providerConfig, log });
      },

      // runResult → human sentence for logs / the diagnostics page / the
      // engine's error branch (前身 bridge.js _friendly + _describeFailure).
      describeError(runResult) {
        switch (runResult?.code) {
          case 'lock-conflict':
            return '该会话的写锁被另一个进程占用（可能是别的 dsh 实例），机器人暂时无法回复。请稍后重试。';
          case 'missing-credential':
            return '模型凭证缺失（DEEPSEEK_API_KEY 未配置）。请在服务环境中配置后重试。';
          case 'timeout':
            return '任务超时。';
          default: {
            if (runResult?.error) return String(runResult.error);
            const r = runResult?.reason;
            if (r?.error?.message) return String(r.error.message);
            if (r?.kind) return `运行结束原因=${r.kind}`;
            return '未知错误';
          }
        }
      },
    });
  },
};
