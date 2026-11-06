// provider-codex (M2 Task 4): the codex-cli provider plugin — drives
// `codex exec --json --skip-git-repo-check -` with the prompt on stdin.
// The heavy lifting lives next door:
//   runner.js  spawn/JSONL→unified events (full codex item set)/code mapping/
//             kill escalation; resume = `exec resume <id>` subcommand
//   history.js ~/.codex/sessions/<YYYY/MM/DD>/rollout-*<sessionId>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (codex
// needs no side files → null) and the code→中文 describeError copy.
import { createRunner } from './runner.js';

const PORT_ID = 'codex';
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

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
        // progressCoT is consumed by the core-engine progressor wiring (T19)
        // per DESIGN §6.1 (providerConfig.progressCoT 默认 on) — do not remove;
        // same row as dsh so the M3 UI renders the switch uniformly.
        { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
        { key: 'codexBin', label: 'codex 可执行文件（PATH 或绝对路径）', type: 'string', default: 'codex' },
        { key: 'codexHome', label: 'codex 配置目录（默认 ~/.codex；注入 $CODEX_HOME，会话 rollout 也在其 sessions/ 下——readHistory 同源）', type: 'string' },
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
        return errors;
      },

      // codex needs no dsh-style config file materialization: every knob is
      // a CLI flag (-m/-s), a -c override or an env var assembled per run.
      // Returning null = "nothing to materialize" (PLUGIN-DEV).
      materializeConfig() {
        return null;
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
