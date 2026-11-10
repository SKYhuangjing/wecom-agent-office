// provider-cursor: the Cursor CLI (`agent`, formerly cursor-agent) provider
// plugin — drives `agent -p --output-format stream-json -f` with the prompt
// on stdin. The heavy lifting lives next door:
//   runner.js  spawn/NDJSON→unified events (claude-shaped blocks)/kill
//             escalation/stderr surfacing; resume = `--resume <id>`
//   history.js <cursorHome>/projects/**/<sessionId>.jsonl reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook (cursor
// needs no side files → null; the LOGIN entry stays the CLI's own
// `agent login` — materialize never touches credentials) and the code→中文
// describeError copy.
import { createRunner } from './runner.js';

const PORT_ID = 'cursor';
const MODES = ['agent', 'plan', 'ask'];

export default {
  manifest: {
    id: 'provider-cursor',
    name: 'Cursor Provider',
    type: 'provider',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { provider: '^1' }, plugins: { 'core-engine': '^1' } },
  },

  activate(ctx) {
    ctx.registerProvider(PORT_ID, {
      // Shape of the providerConfig block a bot carries in bots.json
      // (PLUGIN-DEV §8).
      configSchema: [
        { key: 'cwd', label: '工作目录（agent 作业目录，也是会话 projects 归属）', type: 'string', required: true },
        // model：结构化子字段（2026-11-10 UI 治理）。
        { key: 'model', label: '模型', type: 'object',
          hint: '模型名留空=账号默认；密钥留空用 CLI 已登录态（login 入口保留）',
          fields: [
            { key: 'model', label: '模型名（可选）', type: 'string', placeholder: '如 gpt-5、sonnet-4-thinking' },
            { key: 'apiKey', label: 'Cursor API 密钥（可选）', type: 'password' },
            { key: 'apiKeyEnv', label: '密钥环境变量名（可选）', type: 'string', placeholder: 'CURSOR_API_KEY' },
          ] },
        { key: 'mode', label: '模式（agent 默认/plan 只规划/ask 只问答）', type: 'enum', options: MODES },
        { key: 'force', label: '免确认执行工具（-f；机器人无人值守需要，默认开。关掉后工具调用会卡在确认）', type: 'bool', default: true },
        { key: 'cursorArgs', label: '额外 CLI 参数（列表，逐项原样追加；不校验内容）', type: 'list' },
        { key: 'apiKeyEnv', label: '凭证环境变量名（值为 model.apiKey 字面量时注入；cursor 自身读 CURSOR_API_KEY）', type: 'string', default: 'CURSOR_API_KEY' },
        { key: 'cursorBin', label: 'agent 可执行文件（PATH 或绝对路径）', type: 'string', default: 'agent' },
        { key: 'cursorHome', label: 'cursor 配置目录', hint: '默认 ~/.cursor（会话 projects 同源）；登录态不建议重定向——多 bot 共用同一登录', type: 'string' },
        { key: 'env', label: '注入子进程的环境变量（值必须是字符串）', type: 'object' },
        // progressStyle/progressText (2026-11-06 拟人播报)：进度行风格与播报
        // 文案，core-engine 出站面消费。same row as dsh so the UI renders
        // uniformly.
        { key: 'progressStyle', label: '工作汇报风格（拟人播报=polite：只播报「思考中…请稍等」，企微不露思维链；详细汇报=cot：进度行展示思维链/工具摘要）', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressText', label: '播报文案（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数；≤120 字）', type: 'string', default: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' },
      ],

      // Semantic validation on top of the schema types: cwd presence, mode
      // enum, cursorArgs shapes, model completeness, env value types.
      validate(providerConfig) {
        const errors = [];
        const pc = providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') errors.push('providerConfig.cwd is required');
        if (pc.mode != null && !MODES.includes(pc.mode)) {
          errors.push(`providerConfig.mode must be one of ${MODES.join(', ')}`);
        }
        if (pc.force != null && typeof pc.force !== 'boolean') {
          errors.push(`providerConfig.force must be a bool (got ${typeof pc.force})`);
        }
        if (pc.cursorArgs != null) {
          if (!Array.isArray(pc.cursorArgs)) {
            errors.push('providerConfig.cursorArgs must be a list');
          } else {
            pc.cursorArgs.forEach((entry, i) => {
              if (typeof entry !== 'string' || entry === '') {
                errors.push(`providerConfig.cursorArgs[${i}] must be a non-empty string (got ${JSON.stringify(entry)})`);
              }
            });
          }
        }
        const m = pc.model;
        if (m != null) {
          if (typeof m !== 'object' || Array.isArray(m)) {
            errors.push('providerConfig.model must be an object');
          } else if (m.model != null && (typeof m.model !== 'string' || m.model === '')) {
            errors.push('providerConfig.model.model must be a non-empty string when present（缺省时用账号默认模型）');
          }
        }
        if (pc.apiKeyEnv != null && typeof pc.apiKeyEnv !== 'string') {
          errors.push(`providerConfig.apiKeyEnv must be a string (got ${typeof pc.apiKeyEnv})`);
        }
        if (pc.cursorBin != null && typeof pc.cursorBin !== 'string') {
          errors.push(`providerConfig.cursorBin must be a string (got ${typeof pc.cursorBin})`);
        }
        if (pc.cursorHome != null && typeof pc.cursorHome !== 'string') {
          errors.push(`providerConfig.cursorHome must be a string (got ${typeof pc.cursorHome})`);
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

      // cursor needs no dsh-style config file materialization: every knob is
      // a CLI flag or an env var assembled per run, and the LOGIN state
      // (`agent login`, browser) is the CLI's own — materialize never touches
      // credentials. Returning null = "nothing to materialize" (PLUGIN-DEV).
      materializeConfig() {
        return null;
      },

      createRunner({ bot, providerConfig, assets, log }) {
        return createRunner({ bot, providerConfig, assets, log });
      },

      // runResult → human sentence for logs / the diagnostics page / the
      // engine's error branch.
      describeError(runResult) {
        switch (runResult?.code) {
          case 'lock-conflict':
            return '该会话正被另一个 agent 进程使用，机器人暂时无法回复。请稍后重试。';
          case 'missing-credential':
            return 'Cursor 凭证缺失或已失效（未登录 / CURSOR_API_KEY 未配置）。请在本机运行 agent login 重新登录，或在 bot 的 providerConfig.model 中配置 apiKey 后重试。';
          case 'timeout':
            return '任务超时。';
          case 'aborted':
            return '本轮运行已被中止。';
          default: {
            if (runResult?.error) return String(runResult.error);
            const r = runResult?.reason;
            if (r?.kind && r.kind !== 'completed') return `cursor 运行结束：${r.kind}`;
            if (r?.kind) return `运行结束原因=${r.kind}`;
            return '未知错误';
          }
        }
      },
    });
  },
};
