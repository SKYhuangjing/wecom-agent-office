// provider-claude (M2 Task 2): the claude-code provider plugin — drives
// `claude -p --output-format stream-json --verbose` with the prompt on stdin.
// The heavy lifting lives next door:
//   runner.js  spawn/stream-json→unified events/code mapping/kill escalation
//   history.js ~/.claude/projects/<slug(realpath cwd)>/<sessionId>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (claude
// needs no side files → null) and the code→中文 describeError copy.
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunner } from './runner.js';

const PORT_ID = 'claude';
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

// —— asset faces (DESIGN-ASSETS §3.3 claude column, W3 T2) ——————————————————
// V1 (§9, verified 2026-11-07): CLAUDE_CONFIG_DIR redirect carries skills/
// AND CLAUDE.md — the dedicated-dir target face is real; cwd/.claude/skills +
// cwd/CLAUDE.md stay the documented fallback (F14).

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

export const ripgrepText = (entry) => [
  RIPGREP_GUIDANCE,
  ...(entry?.content?.options?.extraHints ? [String(entry.content.options.extraHints)] : []),
].join('\n');

// Memory section body (§4.3): 节首标注来源资产名, notes in binding order.
export const memoryMarkdown = (entry) => [
  `## WAO 跨会话记忆：${entry.name}`,
  '',
  ...((entry.content?.notes ?? []).flatMap((n, i) => [...(i > 0 ? [''] : []), n])),
].join('\n');

// mcp translation (§4.2): claude face keeps server shapes as-is (keys land
// sorted via stableStringify downstream of core-engine? No — THIS file owns
// the deterministic bytes), server renamed wao-<serverId>. ${VAR} references
// in env/headers values pass through VERBATIM — V8 (§9, verified): claude
// expands ${VAR} at server spawn from its own env; a missing var stays a
// literal ${VAR} (no error, no empty). Plaintext secrets land only in the
// WAO-owned single file → 0600 (§4.2 ③).
export function claudeMcpDocument(plan) {
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
  // stable key order at the top level too (determinism, §3.5)
  return { mcpServers: Object.fromEntries(Object.keys(servers).sort().map((k) => [k, servers[k]])) };
}

// The stable-JSON serializer providers share with core-engine's expectations:
// sorted keys, no whitespace variance — idempotence anchor (§3.5).
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
    id: 'provider-claude',
    name: 'Claude Provider',
    type: 'provider',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { provider: '^1' }, plugins: { 'core-engine': '^1' } },
  },

  activate(ctx) {
    ctx.registerProvider(PORT_ID, {
      // Shape of the providerConfig block a bot carries in bots.json
      // (PLUGIN-DEV §8).
      configSchema: [
        { key: 'cwd', label: '工作目录（claude 按其 realpath 定位会话历史）', type: 'string', required: true },
        { key: 'model', label: '模型 {model, baseURL?, apiKey?, apiKeyEnv?}（baseURL→ANTHROPIC_BASE_URL，apiKey→ANTHROPIC_AUTH_TOKEN 或 apiKeyEnv）', type: 'object' },
        { key: 'permissionMode', label: '权限模式（--permission-mode）', type: 'enum', options: PERMISSION_MODES, default: 'default' },
        { key: 'allowedTools', label: '允许的工具（列表，逗号拼接传 --allowedTools）', type: 'list' },
        { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
        { key: 'prompt', label: '人设（多行，--append-system-prompt）', type: 'string' },
        // progressStyle/progressText (2026-11-06 拟人播报)：进度行风格与播报
        // 文案，core-engine 出站面消费（polite=企微只播报一句「思考中…请稍
        // 等」，不露思维链/工具内容；cot=旧 §6.1 详细汇报）。
        { key: 'progressStyle', label: '工作汇报风格（拟人播报=polite：只播报「思考中…请稍等」，企微不露思维链；详细汇报=cot：进度行展示思维链/工具摘要）', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressText', label: '播报文案（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字）', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
        // progressCoT 已废弃（2026-11-06，被 progressStyle 取代，保留兼容）：
        // 仅在 cot 风格内抑制 💭 行，不再能把进度行变回详细汇报——默认已
        // 翻转为 polite（owner 决策）。same row as dsh so the M3 UI renders uniformly.
        { key: 'progressCoT', label: '进度行展示思维链摘要（已废弃，改用工作汇报风格）', type: 'bool', default: true },
        { key: 'claudeBin', label: 'claude 可执行文件（PATH 或绝对路径）', type: 'string', default: 'claude' },
        { key: 'claudeConfigDir', label: 'claude 配置目录（默认 ~/.claude，会话历史所在；重定向时注入子进程 $CLAUDE_CONFIG_DIR——readHistory 同源）', type: 'string' },
      ],

      // Semantic validation on top of the schema types: cwd presence, model
      // completeness (a model object without .model would silently spawn an
      // unconfigured CLI), permission enum, env value types.
      validate(providerConfig) {
        const errors = [];
        const pc = providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') errors.push('providerConfig.cwd is required');
        if (pc.permissionMode != null && !PERMISSION_MODES.includes(pc.permissionMode)) {
          errors.push(`providerConfig.permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
        }
        const m = pc.model;
        if (m != null) {
          if (typeof m !== 'object' || Array.isArray(m)) {
            errors.push('providerConfig.model must be an object');
          } else if (typeof m.model !== 'string' || m.model === '') {
            errors.push('providerConfig.model.model is required when model is set（缺省时 claude 用其默认路由）');
          }
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
        if (pc.allowedTools != null && !Array.isArray(pc.allowedTools)) {
          errors.push('providerConfig.allowedTools must be a list');
        }
        // 播报文案模板上限（超长即 400，拒绝优于静默截断）
        if (typeof pc.progressText === 'string' && pc.progressText.length > 120) {
          errors.push(`providerConfig.progressText 播报文案最长 120 字（当前 ${pc.progressText.length}）`);
        }
        return errors;
      },

      // claude needs no dsh-style config file materialization: every knob is
      // a CLI flag or env var assembled per run. Returning null = "nothing
      // to materialize" (PLUGIN-DEV). (Asset products have their own hook
      // below — materializeConfig stays the providerConfig-only face.)
      materializeConfig() {
        return null;
      },

      // 资产物化 (§3.3 claude column): PURE PLANNER — returns the write plan;
      // core-engine's materializer owns disk mutations (jail guard/atomicity/
      // manifest). Faces: skills → <configDir>/skills or <cwd>/.claude/skills
      // (V1); memory → CLAUDE.md marker section; mcp → ONE WAO-owned file in
      // the data domain + runner --mcp-config (V7 verified: the flag OVERRIDES
      // same-named user-scope servers — wao- 前缀 + 旗标即权威面); prompt/
      // ripgrep → runner --append-system-prompt (F11, ephemeral per turn).
      async materializeAssets(bot, plan, { log, assetsDir } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') throw new Error('materializeAssets: bot.id is required');
        const pc = bot.providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') throw new Error(`materializeAssets: bot ${bot.id} has no providerConfig.cwd`);
        const dir = typeof pc.claudeConfigDir === 'string' && pc.claudeConfigDir !== '' ? pc.claudeConfigDir : pc.cwd;
        const redirected = dir === pc.claudeConfigDir;
        const skillsRoot = redirected ? join(dir, 'skills') : join(dir, '.claude', 'skills');
        const claudeMd = join(dir, 'CLAUDE.md');
        const writes = [];
        const notes = [];
        const tools = [];
        let memorySection = [];
        for (const entry of plan ?? []) {
          switch (entry.type) {
            case 'skill': {
              const name = entry.content?.name ?? entry.name;
              writes.push({ kind: 'file-create', target: join(skillsRoot, name, 'SKILL.md'), content: skillMarkdown(entry), for: entry.assetId });
              notes.push({ assetId: entry.assetId, detail: `技能 ${name} → ${redirected ? '$CLAUDE_CONFIG_DIR/skills' : '<cwd>/.claude/skills'}/${name}/SKILL.md（V1 已验证装载）` });
              break;
            }
            case 'memory':
              memorySection.push(memoryMarkdown(entry));
              break;
            case 'prompt':
              writes.push({ kind: 'argv', flags: ['--append-system-prompt', String(entry.content?.text ?? '')], for: entry.assetId });
              break;
            case 'mcp':
              break; // aggregated below into the single owned file
            case 'tool':
              if (entry.content?.kind === 'ripgrep') {
                writes.push({ kind: 'argv', flags: ['--append-system-prompt', ripgrepText(entry)], for: entry.assetId });
                const rg = probeRg();
                tools.push({ assetId: entry.assetId, kind: 'ripgrep', state: rg.available ? 'available' : 'unavailable', version: rg.version });
                if (!rg.available) {
                  notes.push({ assetId: entry.assetId, detail: `rg 未安装：ripgrep 指引已注入但本机无效（预检不失败）——${rgInstallHint()} 后生效` });
                }
              } else if (entry.content?.kind === 'rtk') {
                // §7.1 (W3 T3): plan the rtk-init write; core-engine's
                // materializer owns the external-command execution (probe →
                // dry-run 前缀校验 → 真跑 → 回读断言；unavailable/armed/
                // failed 三态记 manifest.tools）。V5 已实证 rtk 1.1.0 尊重
                // CLAUDE_CONFIG_DIR 重定向；无 claudeConfigDir 的 bot 在绑定面
                // 已被拒（checkBind §7.1 硬红线）——此处防御性注记。
                if (redirected) {
                  writes.push({ kind: 'rtk-init', target: dir, flavor: 'claude', for: entry.assetId, owned: false });
                } else {
                  notes.push({ assetId: entry.assetId, detail: 'rtk 要求 claudeConfigDir（绑定面应已拒绝共享目录 bot）——本轮未装备' });
                }
              }
              break;
            default:
              break;
          }
        }
        if (memorySection.length > 0) {
          writes.push({ kind: 'marker-section', target: claudeMd, format: 'markdown', content: memorySection.join('\n\n') });
          notes.push({ detail: `记忆 → ${claudeMd} 标记节（V1 已验证 CLAUDE_CONFIG_DIR 重定向装载）` });
        }
        const mcpEntries = (plan ?? []).filter((e) => e.type === 'mcp');
        if (mcpEntries.length > 0) {
          if (typeof assetsDir !== 'string' || assetsDir === '') throw new Error('materializeAssets: assetsDir is required for mcp assets');
          const target = join(assetsDir, bot.id, 'claude-mcp.json');
          writes.push({ kind: 'file-create', target, content: `${stableJson(claudeMcpDocument(plan))}\n`, mode: 0o600, appliesTo: 'mcp', owned: true });
          writes.push({ kind: 'argv', flags: ['--mcp-config', target], appliesTo: 'mcp' });
          notes.push({ detail: `MCP → ${target}（WAO 独立文件 0600，runner 加 --mcp-config；V7 实证旗标覆盖用户 scope 同名）` });
        }
        log?.info?.(`provider-claude: asset plan for ${bot.id} → ${writes.length} writes`);
        return { writes, notes, entries: [], tools };
      },

      createRunner({ bot, providerConfig, assets, log }) {
        return createRunner({ bot, providerConfig, assets, log });
      },

      // runResult → human sentence for logs / the diagnostics page / the
      // engine's error branch.
      describeError(runResult) {
        switch (runResult?.code) {
          case 'lock-conflict':
            return '该会话正被另一个 claude 进程使用（会话锁定），机器人暂时无法回复。请稍后重试。';
          case 'missing-credential':
            return '模型凭证缺失（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 未配置）。请在服务环境或 bot 的 providerConfig.env / model 中配置后重试。';
          case 'timeout':
            return '任务超时。';
          case 'aborted':
            return '本轮运行已被中止。';
          default: {
            if (runResult?.error) return String(runResult.error);
            const r = runResult?.reason;
            if (r?.kind && r.kind !== 'completed') return `claude 运行结束：${r.kind}`;
            if (r?.kind) return `运行结束原因=${r.kind}`;
            return '未知错误';
          }
        }
      },
    });
  },
};
