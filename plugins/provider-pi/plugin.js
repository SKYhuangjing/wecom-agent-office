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
import { writeBotModels, removeBotModels, piAgentDirFor } from './models.js';

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

export const RIPGREP_GUIDANCE = [
  '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'、rg -n "text" src/。',
  'rg 未安装时先执行：brew install ripgrep。',
].join('\n');

export const memoryMarkdown = (entry) => [
  `## WAO 跨会话记忆：${entry.name}`,
  '',
  ...((entry.content?.notes ?? []).flatMap((n, i) => [...(i > 0 ? [''] : []), n])),
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

const hasBin = (name) => {
  try {
    return spawnSync(name, ['--version'], { timeout: 3000 }).error == null;
  } catch { return false; }
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
      // Shape of the providerConfig block a bot carries in bots.json
      // (PLUGIN-DEV §8).
      configSchema: [
        { key: 'cwd', label: '工作目录（pi 作业目录，决定会话文件的 cwd slug 归属）', type: 'string', required: true },
        { key: 'model', label: '模型 {model 必填（models.json 里的模型 id）, apiKey?, apiKeyEnv?, contextWindow?, maxTokens?}', type: 'object', required: true },
        { key: 'provider', label: 'models.json 里的 provider 键名（→ --provider）', type: 'string', default: 'magpie' },
        { key: 'baseUrl', label: '网关地址（写入 models.json；默认本机 magpie）', type: 'string', default: 'http://127.0.0.1:3425' },
        { key: 'api', label: '网关协议（写入 models.json）', type: 'enum', options: APIS, default: 'anthropic-messages' },
        { key: 'thinking', label: '思维档位（→ --thinking；off 时省略该 flag）', type: 'enum', options: THINKING_LEVELS },
        { key: 'piArgs', label: '额外 CLI 参数（列表，逐项原样追加；不校验内容）', type: 'list' },
        { key: 'apiKeyEnv', label: '凭证环境变量名（models.json 写 $该名字，值来自 model.apiKey 字面量注入；默认 PI_MAGPIE_API_KEY）', type: 'string', default: 'PI_MAGPIE_API_KEY' },
        { key: 'piBin', label: 'pi 可执行文件（PATH 或绝对路径）', type: 'string', default: 'pi' },
        { key: 'piAgentDir', label: 'pi agent 目录（注入 $PI_CODING_AGENT_DIR；models.json 与 sessions/ 都在其下。默认 ~/.pi/agent-wao-<botId>，离职只清 models.json、保留会话档案）', type: 'string' },
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
        { key: 'progressCoT', label: '进度行展示思维链摘要（已废弃，改用工作汇报风格）', type: 'bool', default: true },
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
        log?.info?.(`provider-pi: materialized models.json → ${res.path}`);
        return { changed: true, path: res.path };
      },

      // materializeConfig's counterpart: DELETE /api/bots/:id takes the bot's
      // materialized models.json with it — but sessions/ (the 员工档案's
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
              } else if (entry.content?.kind === 'rtk') {
                notes.push(hasBin('rtk')
                  ? { assetId: entry.assetId, detail: 'rtk 已安装但 hook 形状待 T3 实证——本轮未写 hook' }
                  : { assetId: entry.assetId, detail: 'rtk 未安装（unavailable）：brew install rtk 后经 rematerialize-assets 装备' });
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
        return { writes, notes, entries: [] };
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
