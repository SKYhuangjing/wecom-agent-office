// provider-pi: the pi coding agent provider plugin — drives
// `pi -p --mode json` (@earendil-works/pi-coding-agent) with the prompt on
// stdin. The heavy lifting lives next door:
//   runner.js  spawn/NDJSON→unified events (pi 1.5.0 shapes, live-probed)/
//             kill escalation/exit-0-is-not-success mapping; resume =
//             `--session <id>`
//   history.js <piAgentDir>/sessions/<cwdSlug>/<ts>_<id>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (writes
// the per-bot models.json declaring the magpie gateway with an $ENV apiKey
// reference — no secret on disk) and the code→中文 describeError copy.
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRunner } from './runner.js';
import { writeBotModels, removeBotModels, piAgentDirFor, writeShellGuard, shellGuardSeconds } from './models.js';

const PORT_ID = 'pi';
const APIS = ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// —— asset faces (DESIGN-ASSETS §3.3 pi column, W3 T2) ————————————————————
// Everything rides EXPLICIT flags (F19: --skill repeatable, --append-system-
// prompt repeatable) or the WAO-namespaced agent dir — no cwd discovery.

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

export const RIPGREP_GUIDANCE = [
  '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'、rg -n "text" src/。',
  `rg 未安装时先执行：${rgInstallHint()}。`,
].join('\n');

export const MEMORY_DISTILL_FOOTER = [
  '',
  '---',
  '沉淀规则：本轮若产生了跨会话有价值的东西，在回复最末尾另起一行输出沉淀标记（同事看不到这行，系统会自动收集进上面的记忆）。最该沉淀的是「操作路径」——用什么工具/命令/参数达成某事：新会话丢失上下文后最需要它，能避免重新摸索（翻历史、找脚本）；其次是业务口径、用户偏好、已确认的事实或决定：',
  '<!--wao-memory:查某业务日志 → 用 MCP 工具 mcp__xxx__sls_execute_sql，project=P、logStore=L、时间范围 now-1h-->',
  '<!--wao-memory:问题关键词 → 结论（≤100字）-->',
  '可以多行多条；没有值得沉淀的就完全不输出，绝不为输出而输出。日常寒暄、一次性的查数结果不要沉淀。',
].join('\n');

export const memoryMarkdown = (entry) => [
  `## WAO 跨会话记忆：${entry.name}`,
  '',
  ...((entry.content?.notes ?? []).flatMap((n, i) => [...(i > 0 ? [''] : []), n])),
  MEMORY_DISTILL_FOOTER,
].join('\n');

// V9 (§9, verified 2026-11-07): pi TOLERATES unknown top-level keys in
// mcp.json AND preserves them through its own rewrites (pi mcp add kept
// x-wao-managed) — the marker is both the foreign-file judgement (custom
// piAgentDir, F22 guard twin) and survives pi editing the file. The manifest
// fallback judgement is NOT needed.
export function piMcpDocument(botId, plan) {
  const servers = {};
  for (const entry of plan) {
    if (entry.type !== 'mcp') continue;
    const contentServers = entry.content?.servers ?? {};
    for (const serverId of Object.keys(contentServers).sort()) {
      const s = contentServers[serverId];
      const out = {};
      for (const key of ['command', 'args', 'env', 'type', 'url', 'headers']) {
        if (s[key] === undefined) continue;
        out[key] = key === 'env' || key === 'headers'
          ? Object.fromEntries(Object.keys(s[key]).sort().map((k) => [k, s[key][k]]))
          : s[key];
      }
      servers[`wao-${serverId}`] = out;
    }
  }
  return {
    'x-wao-managed': true,
    'x-wao-bot-id': botId,
    mcpServers: Object.fromEntries(Object.keys(servers).sort().map((k) => [k, servers[k]])),
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// §7.2 ripgrep 预检（spawn 探测 3s，不失败绑定）：结论随 tools 进 manifest，
// 缺失时 notes 指引安装（指引段本身仍注入——装上即生效）。
const probeRg = () => {
  try {
    const r = spawnSync('rg', ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.error != null || r.status !== 0) return { available: false, version: null };
    return { available: true, version: (r.stdout ?? '').trim().split('\n')[0] || null };
  } catch {
    return { available: false, version: null };
  }
};

export default {
  manifest: {
    id: 'provider-pi',
    name: 'Pi Provider',
    type: 'provider',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { provider: '^1' }, plugins: { 'core-engine': '^1' } },
  },

  activate(ctx) {
    ctx.registerProvider(PORT_ID, {
      // 能力声明（DESIGN-MULTIMODAL §4.4）：附件放行与文案分级的依据
      // （botFeatures().visionSupported）；dsh 不声明（无视觉）。
      features: { vision: true },
      // Shape of the providerConfig block a bot carries in bots.json
      // (PLUGIN-DEV §8).
      configSchema: [
        { key: 'cwd', label: '工作目录（pi 作业目录，决定会话文件的 cwd slug 归属）', type: 'string', required: true },
        // model：结构化子字段（2026-11-10 UI 治理）。
        { key: 'model', label: '模型', type: 'object', required: true,
          hint: '模型名必填（models.json 里的 id）；其余可选——密钥留空走登录态，上下文/输出上限一般用模型默认',
          fields: [
            { key: 'model', label: '模型名', type: 'string', placeholder: '如 workbuddy、auto/glm-5.3-flash' },
            { key: 'apiKey', label: '网关密钥（可选）', type: 'password' },
            { key: 'apiKeyEnv', label: '密钥环境变量名（可选）', type: 'string', placeholder: 'PI_MAGPIE_API_KEY' },
            { key: 'contextWindow', label: '上下文窗口（可选）', type: 'string', placeholder: '如 1000000' },
            { key: 'maxTokens', label: '单次输出上限（可选）', type: 'string', placeholder: '如 32000' },
          ] },
        { key: 'provider', label: 'models.json 里的 provider 键名（→ --provider）', type: 'string', default: 'magpie' },
        { key: 'baseUrl', label: '网关地址（写入 models.json；默认本机 magpie）', type: 'string', default: 'http://127.0.0.1:3425' },
        { key: 'api', label: '网关协议（写入 models.json）', type: 'enum', options: APIS, default: 'anthropic-messages' },
        { key: 'thinking', label: '思维档位（→ --thinking；off 时省略该 flag）', type: 'enum', options: THINKING_LEVELS },
        { key: 'piArgs', label: '额外 CLI 参数（列表，逐项原样追加；不校验内容）', type: 'list' },
        { key: 'bashTimeoutSec', label: 'shell 命令超时上限秒数（bash/powershell 工具缺省 timeout 的注入值，默认 90；物化 wao-shell-guard 扩展经 -e 加载）', type: 'string', placeholder: '90' },
        { key: 'apiKeyEnv', label: '凭证环境变量名（models.json 写 $该名字，值来自 model.apiKey 字面量注入；默认 PI_MAGPIE_API_KEY）', type: 'string', default: 'PI_MAGPIE_API_KEY' },
        { key: 'piBin', label: 'pi 可执行文件（PATH 或绝对路径）', type: 'string', default: 'pi' },
        { key: 'piAgentDir', label: 'pi agent 目录', hint: '默认 ~/.pi/agent-wao-<botId>；models.json 与会话数据都在其下，删除机器人保留会话', type: 'string' },
        { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
        // progressStyle/progressText (2026-11-06 拟人播报)：进度行风格与播报
        // 文案，core-engine 出站面消费（polite=企微只播报一句「思考中…请稍
        // 等」，不露思维链/工具内容；cot=旧 §6.1 详细汇报）。same row as
        // dsh so the M3 UI renders uniformly.
        { key: 'progressStyle', label: '工作汇报风格（拟人播报=polite：只播报「思考中…请稍等」，企微不露思维链；详细汇报=cot：进度行展示思维链/工具摘要）', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressText', label: '播报文案（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字）', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
        // progressCoT 已废弃（2026-11-06，被 progressStyle 取代，保留兼容）：
        // 仅在 cot 风格内抑制 💭 行，不再能把进度行变回详细汇报——默认已
        // 翻转为 polite（owner 决策）。
        // visionInput（DESIGN-MULTIMODAL Phase 2）：图片输入总开关，默认关。
        // 开启后图片以位置参数 @<path> 挂进首提示（print 模式实证）；模型
        // 必须具备视觉能力，图片按视觉 token 计费。
        { key: 'visionInput', label: '图片输入（允许用户发图；需模型具备视觉能力，图片按视觉 token 计费）', type: 'bool', default: false },
      ],

      // Semantic validation on top of the schema types: cwd/model presence,
      // enum membership, piArgs shapes (a non-string entry would corrupt the
      // argv), model completeness, env value types.
      validate(providerConfig) {
        const errors = [];
        const pc = providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') errors.push('providerConfig.cwd is required');
        if (pc.model == null || typeof pc.model !== 'object' || Array.isArray(pc.model)) {
          errors.push('providerConfig.model is required and must be an object');
        } else if (typeof pc.model.model !== 'string' || pc.model.model === '') {
          errors.push('providerConfig.model.model is required（models.json 需要具体模型 id）');
        }
        if (pc.provider != null && (typeof pc.provider !== 'string' || pc.provider === '')) {
          errors.push('providerConfig.provider must be a non-empty string');
        }
        if (pc.baseUrl != null && (typeof pc.baseUrl !== 'string' || pc.baseUrl === '')) {
          errors.push('providerConfig.baseUrl must be a non-empty string');
        }
        if (pc.api != null && !APIS.includes(pc.api)) {
          errors.push(`providerConfig.api must be one of ${APIS.join(', ')}`);
        }
        if (pc.thinking != null && !THINKING_LEVELS.includes(pc.thinking)) {
          errors.push(`providerConfig.thinking must be one of ${THINKING_LEVELS.join(', ')}`);
        }
        if (pc.piArgs != null) {
          if (!Array.isArray(pc.piArgs)) {
            errors.push('providerConfig.piArgs must be a list');
          } else {
            pc.piArgs.forEach((entry, i) => {
              if (typeof entry !== 'string' || entry === '') {
                errors.push(`providerConfig.piArgs[${i}] must be a non-empty string (got ${JSON.stringify(entry)})`);
              }
            });
          }
        }
        if (pc.apiKeyEnv != null && typeof pc.apiKeyEnv !== 'string') {
          errors.push(`providerConfig.apiKeyEnv must be a string (got ${typeof pc.apiKeyEnv})`);
        }
        if (pc.piBin != null && typeof pc.piBin !== 'string') {
          errors.push(`providerConfig.piBin must be a string (got ${typeof pc.piBin})`);
        }
        if (pc.piAgentDir != null && typeof pc.piAgentDir !== 'string') {
          errors.push(`providerConfig.piAgentDir must be a string (got ${typeof pc.piAgentDir})`);
        }
        if (pc.env != null) {
          if (typeof pc.env !== 'object' || Array.isArray(pc.env)) {
            errors.push('providerConfig.env must be an object');
          } else {
            for (const [k, v] of Object.entries(pc.env)) {
              if (typeof v !== 'string') errors.push(`providerConfig.env.${k} must be a string (got ${typeof v})`);
            }
          }
        }
        // 播报文案模板上限（超长即 400，拒绝优于静默截断）
        if (typeof pc.progressText === 'string' && pc.progressText.length > 120) {
          errors.push(`providerConfig.progressText 播报文案最长 120 字（当前 ${pc.progressText.length}）`);
        }
        return errors;
      },

      // pi-style config file materialization (DESIGN §5, dsh precedent):
      // write the per-bot models.json atomically before the bot's first run.
      // The file declares the gateway (baseUrl/api) and references the API
      // key as "$<apiKeyEnv>" — pi resolves it from the environment the
      // runner injects, so no secret lands on disk. A throw keeps the
      // last-good file and bubbles to the API as a 400 with this message —
      // writeBotModels errors name the path they worked from.
      //
      // The SHELL TIMEOUT GUARD extension rides the same hook (2026-11-11
      // live incident): pi's bash/powershell tools have NO default timeout —
      // a model-chosen `find /` hung a WeCom turn 13+ min. The runner loads
      // the file via -e and injects WAO_BASH_TIMEOUT_SEC (pc.bashTimeoutSec,
      // default 90). WAO-owned namespaced path, deterministic bytes, always
      // overwritten — no foreign-file concern (same stance as models.json in
      // the default dir; a custom piAgentDir is equally per-bot owned).
      async materializeConfig(bot, { log } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') {
          throw new Error('materializeConfig: bot.id is required');
        }
        const pc = bot.providerConfig ?? {};
        const res = writeBotModels({
          botId: bot.id,
          piAgentDir: pc.piAgentDir,
          provider: pc.provider,
          baseUrl: pc.baseUrl,
          api: pc.api,
          apiKeyEnv: pc.apiKeyEnv,
          model: pc.model,
          thinking: pc.thinking,
        });
        const guardPath = writeShellGuard(piAgentDirFor({ botId: bot.id, piAgentDir: pc.piAgentDir }));
        log?.info?.(`provider-pi: materialized models.json → ${res.path}`);
        log?.info?.(`provider-pi: shell timeout guard → ${guardPath} (-e, WAO_BASH_TIMEOUT_SEC=${shellGuardSeconds(pc)})`);
        return { changed: true, path: res.path };
      },

      // materializeConfig's counterpart: DELETE /api/bots/:id takes the bot's
      // materialized models.json with it — but sessions/ (会话数据
      // conversation history) stays on disk, unlike the dsh profile which has
      // no side artifacts. Best-effort by contract; removeBotModels returns
      // removed:false when nothing was there (never an error).
      async removeConfig(bot, { log } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') {
          return { removed: false };
        }
        const removed = removeBotModels({ botId: bot.id, piAgentDir: bot?.providerConfig?.piAgentDir });
        log?.info?.(`provider-pi: removeConfig models.json (${bot.id}) → ${removed ? 'removed' : 'absent'}`);
        return { removed };
      },

      // 知识呈现面（DESIGN-KNOWLEDGE §4.2）：pi 的人设/资产走显式旗标
      //（--append-system-prompt 可重复），记忆正文物化 wao-memory.md 后由
      // runner 读文件拼文本传参，技能走 --skill 旗标 + 盘面。
      knowledgeFace(bot, { plan }) {
        const pc = bot.providerConfig ?? {};
        const agentDir = piAgentDirFor({ botId: bot.id, piAgentDir: pc.piAgentDir });
        const entries = Array.isArray(plan) ? plan : [];
        const argvTexts = [];
        if (typeof pc.prompt === 'string' && pc.prompt.trim() !== '') argvTexts.push(pc.prompt);
        for (const entry of entries) {
          if (entry?.type === 'prompt') argvTexts.push(String(entry.content?.text ?? ''));
          if (entry?.type === 'tool' && entry.content?.kind === 'ripgrep') {
            argvTexts.push([RIPGREP_GUIDANCE, ...(entry.content.options?.extraHints ? [String(entry.content.options.extraHints)] : [])].join('\n'));
          }
        }
        const sections = [{
          kind: 'argv', title: '--append-system-prompt · 每轮追加的系统提示词（可重复）',
          text: argvTexts.join('\n\n') || '（空——未配置人设，也未绑定 prompt/ripgrep 资产）',
        }];
        if (entries.some((e) => e?.type === 'memory')) {
          sections.push({
            kind: 'file', title: '跨会话记忆（wao-memory.md，runner 读文件拼文本传参）',
            paths: [join(agentDir, 'wao-memory.md')],
          });
        }
        const skillPaths = entries.filter((e) => e?.type === 'skill')
          .map((e) => join(agentDir, 'skills', e.content?.name ?? e.name, 'SKILL.md'));
        if (skillPaths.length > 0) {
          sections.push({ kind: 'file', title: '技能文档（skills/*/SKILL.md，另经 --skill 旗标显式传入）', paths: skillPaths });
        }
        if (entries.some((e) => e?.type === 'mcp')) {
          sections.push({ kind: 'file', title: 'MCP 服务配置（mcp.json 整文件，含密钥不预览内容）', paths: [join(agentDir, 'mcp.json')], secret: true });
        }
        sections.push({
          kind: 'stdin', title: '任务信封（stdin）',
          text: '每轮任务 = [会话自愈 handoff 前缀] + 用户消息 + [附件段] + [失败注记段]，以 \n\n---\n\n 连接后经 stdin 传入；人设/资产不在这里（走上面的旗标与盘面文件）。',
        });
        return {
          delivery: 'pi：人设/prompt/ripgrep 走 --append-system-prompt 旗标；记忆物化 wao-memory.md 后读文件传参；技能走 --skill 旗标 + agent 目录盘面；MCP 走 mcp.json。',
          sections,
        };
      },

      createRunner({ bot, providerConfig, assets, log }) {
        return createRunner({ bot, providerConfig, assets, log });
      },

      // 资产物化 (§3.3 pi column): PURE PLANNER. skill → <agentDir>/skills/
      // + runner --skill (F19 显式旗标，不依赖发现); memory → <agentDir>/
      // wao-memory.md (runner reads it and appends the TEXT — the design's
      // V3 fallback, zero dependence on pi's file-form flag semantics);
      // prompt/ripgrep → runner --append-system-prompt; mcp → <agentDir>/
      // mcp.json 整文件重写 (default dir = WAO 命名空间；custom dir 遇外来
      // 文件拒写, V9 marker judgement), 0600, server 名 wao- 前缀.
      async materializeAssets(bot, plan, { log } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') throw new Error('materializeAssets: bot.id is required');
        const pc = bot.providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') throw new Error(`materializeAssets: bot ${bot.id} has no providerConfig.cwd`);
        const agentDir = piAgentDirFor({ botId: bot.id, piAgentDir: pc.piAgentDir });
        const customDir = typeof pc.piAgentDir === 'string' && pc.piAgentDir !== '';
        const writes = [];
        const notes = [];
        const tools = [];
        for (const entry of plan ?? []) {
          switch (entry.type) {
            case 'skill': {
              const name = entry.content?.name ?? entry.name;
              writes.push({ kind: 'file-create', target: join(agentDir, 'skills', name, 'SKILL.md'), content: skillMarkdown(entry), for: entry.assetId });
              writes.push({ kind: 'argv', flags: ['--skill', join(agentDir, 'skills', name, 'SKILL.md')], for: entry.assetId });
              notes.push({ assetId: entry.assetId, detail: `技能 ${name} → ${agentDir}/skills/${name}/SKILL.md + runner --skill（F19 显式旗标）` });
              break;
            }
            case 'prompt':
              writes.push({ kind: 'argv', flags: ['--append-system-prompt', String(entry.content?.text ?? '')], for: entry.assetId });
              break;
            case 'memory': {
              const target = join(agentDir, 'wao-memory.md');
              writes.push({ kind: 'file-create', target, content: `${memoryMarkdown(entry)}\n`, for: entry.assetId });
              writes.push({ kind: 'argv', flags: ['--append-system-prompt', target], for: entry.assetId });
              notes.push({ assetId: entry.assetId, detail: `记忆 → ${target}（runner 读文件拼文本传参——设计回退形态，不依赖 V3）` });
              break;
            }
            case 'mcp':
              break; // aggregated below
            case 'tool':
              if (entry.content?.kind === 'ripgrep') {
                writes.push({ kind: 'argv', flags: ['--append-system-prompt', [RIPGREP_GUIDANCE, ...(entry.content.options?.extraHints ? [String(entry.content.options.extraHints)] : [])].join('\n')], for: entry.assetId });
                const rg = probeRg();
                tools.push({ assetId: entry.assetId, kind: 'ripgrep', state: rg.available ? 'available' : 'unavailable', version: rg.version });
                if (!rg.available) {
                  notes.push({ assetId: entry.assetId, detail: `rg 未安装：ripgrep 指引已注入但本机无效（预检不失败）——${rgInstallHint()} 后生效` });
                }
              } else if (entry.content?.kind === 'rtk') {
                // §7.1 (W3 T3): plan the rtk-init write — core-engine's
                // materializer executes（V5 实证 rtk 1.1.0 `--agent pi` 尊重
                // PI_CODING_AGENT_DIR：extensions/rtk.ts + .rtk-agents）。目标
                // 取 agentDir（自定义或 WAO 默认目录——pi 的装备面本就是 per-bot
                // 命名空间，非共享主目录，checkBind 同判）。
                writes.push({ kind: 'rtk-init', target: agentDir, flavor: 'pi', for: entry.assetId, owned: false });
              }
              break;
            default:
              break;
          }
        }
        const mcpEntries = (plan ?? []).filter((e) => e.type === 'mcp');
        if (mcpEntries.length > 0) {
          const target = join(agentDir, 'mcp.json');
          if (customDir && existsSync(target)) {
            // F22 guard twin: a foreign mcp.json (no x-wao-managed) refuses —
            // same trade as writeBotModels' models.json guard.
            let existing = null;
            try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch { /* unparsable = foreign */ }
            if (existing?.['x-wao-managed'] !== true) {
              throw new Error(`目标已有非 WAO mcp.json：${target}（如需接管请先手动迁移或改 piAgentDir）`);
            }
          }
          writes.push({ kind: 'file-create', target, content: `${stableJson(piMcpDocument(bot.id, plan))}\n`, mode: 0o600, appliesTo: 'mcp', owned: true });
          notes.push({ detail: `MCP → ${target} 整文件重写（x-wao-managed 注记，V9 已验证 pi 容忍且重写保留；0600）` });
        }
        log?.info?.(`provider-pi: asset plan for ${bot.id} → ${writes.length} writes`);
        return { writes, notes, entries: [], tools };
      },

      // runResult → human sentence for logs / the diagnostics page / the
      // engine's error branch.
      describeError(runResult) {
        switch (runResult?.code) {
          case 'lock-conflict':
            return '该会话正被另一个 pi 进程使用，机器人暂时无法回复。请稍后重试。';
          case 'missing-credential':
            return '模型凭证缺失或被网关拒绝（PI_MAGPIE_API_KEY 未配置/无效）。请在服务环境或 bot 的 providerConfig.env / model 中配置后重试。';
          case 'timeout':
            return '任务超时。';
          case 'aborted':
            return '本轮运行已被中止。';
          default: {
            if (runResult?.error) return String(runResult.error);
            const r = runResult?.reason;
            if (r?.kind && r.kind !== 'completed') return `pi 运行结束：${r.kind}`;
            if (r?.kind) return `运行结束原因=${r.kind}`;
            return '未知错误';
          }
        }
      },
    });
  },
};
