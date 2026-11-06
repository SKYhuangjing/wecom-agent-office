// provider-claude (M2 Task 2): the claude-code provider plugin — drives
// `claude -p --output-format stream-json --verbose` with the prompt on stdin.
// The heavy lifting lives next door:
//   runner.js  spawn/stream-json→unified events/code mapping/kill escalation
//   history.js ~/.claude/projects/<slug(realpath cwd)>/<sessionId>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (claude
// needs no side files → null) and the code→中文 describeError copy.
import { createRunner } from './runner.js';

const PORT_ID = 'claude';
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

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
        { key: 'claudeBin', label: 'claude 可执行文件（PATH 或绝对路径）', type: 'string', default: 'claude' },
        { key: 'claudeConfigDir', label: 'claude 配置目录（默认 ~/.claude，会话历史所在；可用 $CLAUDE_CONFIG_DIR 重定向）', type: 'string' },
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
        return errors;
      },

      // claude needs no dsh-style config file materialization: every knob is
      // a CLI flag or env var assembled per run. Returning null = "nothing
      // to materialize" (PLUGIN-DEV).
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
