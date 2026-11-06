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
