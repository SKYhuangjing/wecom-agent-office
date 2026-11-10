// provider-codex (M2 Task 4): the codex-cli provider plugin — drives
// `codex exec --json --skip-git-repo-check -` with the prompt on stdin.
// The heavy lifting lives next door:
//   runner.js  spawn/JSONL→unified events (full codex item set)/code mapping/
//             kill escalation; resume = `exec resume <id>` subcommand
//   history.js ~/.codex/sessions/<YYYY/MM/DD>/rollout-*<sessionId>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (codex
// needs no side files → null) and the code→中文 describeError copy.
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunner } from './runner.js';

const PORT_ID = 'codex';
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

// —— asset faces (DESIGN-ASSETS §3.3 codex column, W3 T2) ——————————————————
// V2 (§9, verified 2026-11-07): CODEX_HOME redirect carries skills/ AND
// AGENTS.md — the dedicated-dir target face is real; <cwd>/.agents/skills +
// <cwd>/AGENTS.md stay the documented fallbacks (F3/F9). codex has no
// per-turn append flag (F10) — prompt/memory ride AGENTS.md; mcp rides a
// config.toml marker section (server tables wao- prefixed, quoted keys).

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

export const promptMarkdown = (entry) => [`## WAO 提示词约束：${entry.name}`, '', String(entry.content?.text ?? '')].join('\n');

// W3 T2 review Critical 2: \n \r \t MUST be escaped — a raw newline inside a
// TOML basic string is illegal TOML, and the registration surface legitimately
// admits them (CONTROL_CHARS excludes \n\r\t), so an unescaped value would
// silently poison the host config.toml.
const TOML_ESCAPE = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\t/g, '\\t');
const tomlStr = (s) => `"${TOML_ESCAPE(s)}"`;
const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

// One mcp server → TOML table block (§4.2 translation; F8 shapes). stdio →
// command/args/env(+env_vars for ${VAR} references — V8 verified: env_vars
// forwards the named variable from codex's own process environment; the
// literal ${VAR} does NOT belong in env for codex); http → url/http_headers
// (a ${VAR} header value rides env_http_headers, F8's reference face).
// Emission order is load-bearing TOML: scalars first, subtables LAST (a
// subtable header captures every key after it), no duplicate headers.
export function mcpTomlBlock(serverId, server) {
  const table = (name) => `[mcp_servers."wao-${serverId}"${name !== '' ? `.${name}` : ''}]`;
  const lines = [];
  const envVars = [];
  if (server.type === 'http') {
    lines.push(table(''));
    lines.push(`url = ${tomlStr(server.url)}`);
    const headers = server.headers ?? {};
    const literal = {};
    const refs = {};
    for (const h of Object.keys(headers).sort()) {
      const ref = ENV_REF.exec(headers[h]);
      if (ref) refs[h] = ref[1]; else literal[h] = headers[h];
    }
    if (Object.keys(literal).length > 0) {
      lines.push('', table('http_headers'));
      for (const [h, v] of Object.entries(literal)) lines.push(`${h} = ${tomlStr(v)}`);
    }
    if (Object.keys(refs).length > 0) {
      lines.push('', table('env_http_headers'));
      for (const [h, name] of Object.entries(refs)) lines.push(`${h} = ${tomlStr(name)}`);
    }
    return lines.join('\n');
  }
  const env = server.env ?? {};
  const literalEnv = {};
  for (const k of Object.keys(env).sort()) {
    const ref = ENV_REF.exec(env[k]);
    if (ref) envVars.push(ref[1]); else literalEnv[k] = env[k];
  }
  lines.push(table(''));
  lines.push(`command = ${tomlStr(server.command)}`);
  if (Array.isArray(server.args) && server.args.length > 0) {
    lines.push(`args = [${server.args.map((a) => tomlStr(a)).join(', ')}]`);
  }
  if (envVars.length > 0) lines.push(`env_vars = [${envVars.map((v) => tomlStr(v)).join(', ')}]`);
  if (Object.keys(literalEnv).length > 0) {
    lines.push('', table('env'));
    for (const [k, v] of Object.entries(literalEnv)) lines.push(`${k} = ${tomlStr(v)}`);
  }
  return lines.join('\n');
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
    id: 'provider-codex',
    name: 'Codex Provider',
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
        { key: 'cwd', label: '工作目录（codex 作业目录，也是会话 rollout 的归属）', type: 'string', required: true },
        { key: 'model', label: '模型 {model}（→ -m；网关 baseURL 走 configOverrides 的 openai_base_url=…，apiKey 走 apiKeyEnv）', type: 'object' },
        // No `default`: omitting the flag keeps codex's own config default —
        // `codex exec --help` (0.166.0) declares no -s default, the effective
        // default lives in $CODEX_HOME/config.toml.
        { key: 'sandbox', label: '沙箱模式（新会话传 -s；续接轮 resume 子命令不支持 -s，自动改传 -c sandbox_mode=…——实测事实）', type: 'enum', options: SANDBOX_MODES },
        { key: 'configOverrides', label: '运行时配置覆盖（列表，每项 key=value 形如 openai_base_url=https://gw.example/v1，逐项传 -c；字符串值自动加 TOML 引号）', type: 'list' },
        { key: 'apiKeyEnv', label: '凭证环境变量名（值为 model.apiKey 字面量时注入；codex 自身读 CODEX_API_KEY）', type: 'string', default: 'CODEX_API_KEY' },
        { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
        // progressStyle/progressText (2026-11-06 拟人播报)：进度行风格与播报
        // 文案，core-engine 出站面消费（polite=企微只播报一句「思考中…请稍
        // 等」，不露思维链/工具内容；cot=旧 §6.1 详细汇报）。
        { key: 'progressStyle', label: '工作汇报风格（拟人播报=polite：只播报「思考中…请稍等」，企微不露思维链；详细汇报=cot：进度行展示思维链/工具摘要）', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressText', label: '播报文案（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字）', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
        // progressCoT 已废弃（2026-11-06，被 progressStyle 取代，保留兼容）：
        // 仅在 cot 风格内抑制 💭 行，不再能把进度行变回详细汇报——默认已
        // 翻转为 polite（owner 决策）。same row as dsh so the M3 UI renders uniformly.
        { key: 'progressCoT', label: '进度行展示思维链摘要（已废弃，改用工作汇报风格）', type: 'bool', default: true },
        { key: 'codexBin', label: 'codex 可执行文件（PATH 或绝对路径）', type: 'string', default: 'codex' },
        { key: 'codexHome', label: 'codex 配置目录（默认 ~/.codex；注入 $CODEX_HOME，会话 rollout 也在其 sessions/ 下——readHistory 同源）', type: 'string' },
        // visionInput（DESIGN-MULTIMODAL Phase 2）：图片输入总开关，默认关。
        // 开启后图片以 codex exec -i <path> 附带（fresh/resume 两腿）；模型
        // 必须具备视觉能力，图片按视觉 token 计费。
        { key: 'visionInput', label: '图片输入（允许用户发图；需模型具备视觉能力，图片按视觉 token 计费）', type: 'bool', default: false },
      ],

      // Semantic validation on top of the schema types: cwd presence, sandbox
      // enum, configOverrides shape (a bare 'foo' would silently pass nothing
      // to codex), model completeness, env value types.
      validate(providerConfig) {
        const errors = [];
        const pc = providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') errors.push('providerConfig.cwd is required');
        if (pc.sandbox != null && !SANDBOX_MODES.includes(pc.sandbox)) {
          errors.push(`providerConfig.sandbox must be one of ${SANDBOX_MODES.join(', ')}`);
        }
        if (pc.configOverrides != null) {
          if (!Array.isArray(pc.configOverrides)) {
            errors.push('providerConfig.configOverrides must be a list');
          } else {
            pc.configOverrides.forEach((entry, i) => {
              if (typeof entry !== 'string' || !entry.includes('=') || entry.split('=')[0].trim() === '') {
                errors.push(`providerConfig.configOverrides[${i}] must look like key=value with a non-empty key (got ${JSON.stringify(entry)})`);
              }
            });
          }
        }
        const m = pc.model;
        if (m != null) {
          if (typeof m !== 'object' || Array.isArray(m)) {
            errors.push('providerConfig.model must be an object');
          } else if (typeof m.model !== 'string' || m.model === '') {
            errors.push('providerConfig.model.model is required when model is set（缺省时 codex 用其默认路由）');
          }
        }
        if (pc.apiKeyEnv != null && typeof pc.apiKeyEnv !== 'string') {
          errors.push(`providerConfig.apiKeyEnv must be a string (got ${typeof pc.apiKeyEnv})`);
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

      // codex needs no dsh-style config file materialization: every knob is
      // a CLI flag (-m/-s), a -c override or an env var assembled per run.
      // Returning null = "nothing to materialize" (PLUGIN-DEV). (Asset
      // products have their own hook below.)
      materializeConfig() {
        return null;
      },

      // 资产物化 (§3.3 codex column): PURE PLANNER. skill → skills/ under
      // CODEX_HOME (V2) or <cwd>/.agents/skills (F3); prompt/memory → ONE
      // AGENTS.md marker section, 与 prompt 分节 (§3.3 memory row); mcp →
      // config.toml marker section at file end (§3.4 TOML — 节内=完整 table
      // 定义, server 名 wao-<serverId> 防与用户自有条目同名 TOML 重复表);
      // ripgrep → guidance 分节; rtk → note only (T3, F25/V5).
      async materializeAssets(bot, plan, { log } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') throw new Error('materializeAssets: bot.id is required');
        const pc = bot.providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') throw new Error(`materializeAssets: bot ${bot.id} has no providerConfig.cwd`);
        const home = typeof pc.codexHome === 'string' && pc.codexHome !== '' ? pc.codexHome : null;
        const skillsRoot = home ? join(home, 'skills') : join(pc.cwd, '.agents', 'skills');
        const agentsMd = home ? join(home, 'AGENTS.md') : join(pc.cwd, 'AGENTS.md');
        const configToml = home ? join(home, 'config.toml') : join(pc.cwd, '.codex', 'config.toml');
        const writes = [];
        const notes = [];
        const tools = [];
        const mdSections = [];
        const tomlBlocks = [];
        for (const entry of plan ?? []) {
          switch (entry.type) {
            case 'skill': {
              const name = entry.content?.name ?? entry.name;
              writes.push({ kind: 'file-create', target: join(skillsRoot, name, 'SKILL.md'), content: skillMarkdown(entry), for: entry.assetId });
              notes.push({ assetId: entry.assetId, detail: `技能 ${name} → ${home ? '$CODEX_HOME/skills' : '<cwd>/.agents/skills'}/${name}/SKILL.md（V2 已验证发现）` });
              break;
            }
            case 'prompt':
              mdSections.push(promptMarkdown(entry));
              break;
            case 'memory':
              mdSections.push(memoryMarkdown(entry));
              break;
            case 'mcp': {
              const servers = entry.content?.servers ?? {};
              for (const serverId of Object.keys(servers).sort()) {
                tomlBlocks.push(mcpTomlBlock(serverId, servers[serverId]));
              }
              break;
            }
            case 'tool':
              if (entry.content?.kind === 'ripgrep') {
                mdSections.push(['## WAO 工具指引：ripgrep', '', RIPGREP_GUIDANCE, ...(entry.content.options?.extraHints ? [String(entry.content.options.extraHints)] : [])].join('\n'));
                const rg = probeRg();
                tools.push({ assetId: entry.assetId, kind: 'ripgrep', state: rg.available ? 'available' : 'unavailable', version: rg.version });
                if (!rg.available) {
                  notes.push({ assetId: entry.assetId, detail: `rg 未安装：ripgrep 指引已注入但本机无效（预检不失败）——${rgInstallHint()} 后生效` });
                }
              } else if (entry.content?.kind === 'rtk') {
                // §7.1 (W3 T3): plan the rtk-init write — core-engine's
                // materializer executes（V5 实证 rtk 1.1.0 尊重 CODEX_HOME：
                // RTK.md + AGENTS.md 引用 + hooks.json PreToolUse 条目）。
                // 无 codexHome 的 bot 绑定面已拒（§7.1 硬红线）——防御性注记。
                if (home) {
                  writes.push({ kind: 'rtk-init', target: home, flavor: 'codex', for: entry.assetId, owned: false });
                } else {
                  notes.push({ assetId: entry.assetId, detail: 'rtk 要求 codexHome（绑定面应已拒绝共享目录 bot）——本轮未装备' });
                }
              }
              break;
            default:
              break;
          }
        }
        if (mdSections.length > 0 || tomlBlocks.length > 0) {
          notes.push({ detail: `提示词/记忆 → ${agentsMd} 标记节（V2 已验证 CODEX_HOME/AGENTS.md 装载）` });
        }
        if (mdSections.length > 0) {
          writes.push({ kind: 'marker-section', target: agentsMd, format: 'markdown', content: mdSections.join('\n\n') });
        }
        if (tomlBlocks.length > 0) {
          // §3.4: 节永在文件末尾，节内=完整 table 定义；core 的标记节替换
          // 剥旧节后于文件末尾重建，用户自有条目一字不动。
          writes.push({ kind: 'marker-section', target: configToml, format: 'toml', content: tomlBlocks.join('\n\n') });
          notes.push({ detail: `MCP → ${configToml} 标记节（server 名 wao- 前缀 + 引号键；\${VAR} 引用走 env_vars，V8 已验证转发）` });
        }
        log?.info?.(`provider-codex: asset plan for ${bot.id} → ${writes.length} writes`);
        return { writes, notes, entries: [], tools };
      },

      createRunner({ bot, providerConfig, log }) {
        return createRunner({ bot, providerConfig, log });
      },

      // runResult → human sentence for logs / the diagnostics page / the
      // engine's error branch.
      describeError(runResult) {
        switch (runResult?.code) {
          case 'lock-conflict':
            return '该会话正被另一个 codex 进程使用（线程锁定），机器人暂时无法回复。请稍后重试。';
          case 'missing-credential':
            return '模型凭证缺失（CODEX_API_KEY 未配置）。请在服务环境或 bot 的 providerConfig.env / model 中配置后重试。';
          case 'timeout':
            return '任务超时。';
          case 'aborted':
            return '本轮运行已被中止。';
          default: {
            if (runResult?.error) return String(runResult.error);
            const r = runResult?.reason;
            if (r?.kind && r.kind !== 'completed') return `codex 运行结束：${r.kind}`;
            if (r?.kind) return `运行结束原因=${r.kind}`;
            return '未知错误';
          }
        }
      },
    });
  },
};
