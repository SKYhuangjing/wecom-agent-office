// provider-dsh (Task 18): the first REAL provider plugin — DeepSeek Harness
// via `dsh --profile P --json -`. The heavy lifting lives next door:
//   runner.js   spawn/NDJSON→unified events/code mapping/kill escalation
//   profiles.js per-bot dsh profile materialization (atomicWrite, last-good)
//   history.js  zstd multi-frame session history reader
// This file is the port registration: manifest, configSchema (the bots.json
// providerConfig block), semantic validate, materializeConfig hook and the
// code→中文 describeError copy (前身 bridge.js _friendly/_describeFailure).
import { createRunner } from './runner.js';
import { writeBotProfile, removeProfile } from './profiles.js';

const PORT_ID = 'dsh';
const PERMS = ['workspace-write', 'read-only', 'danger-full-access'];

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
        { key: 'model', label: '模型 {provider, model, baseURL?, api?, apiKeyEnv?, apiKey?, contextWindow?, maxTokens?}', type: 'object' },
        { key: 'permission', label: '权限', type: 'enum', options: PERMS, default: 'workspace-write' },
        { key: 'prompt', label: '人设（多行，写入 profile system-prompt personaPrefix）', type: 'string' },
        { key: 'writableDirs', label: '沙箱额外可写目录（绝对路径列表）', type: 'list' },
        { key: 'compaction', label: '自动压缩 {enabled?, thresholdRatio?, headroomTokens?, retainRatio?}', type: 'object' },
        // progressCoT is consumed by the core-engine progressor wiring (T19)
        // per DESIGN §6.1 (providerConfig.progressCoT 默认 on) — do not remove.
        { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
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
        return errors;
      },

      // dsh-style config file materialization (DESIGN §5): write the per-bot
      // dsh profile atomically before the bot's first run. A throw keeps the
      // last-good file and bubbles to the API as a 400 with this message —
      // writeBotProfile errors name the path they worked from.
      async materializeConfig(bot, { log } = {}) {
        if (typeof bot?.id !== 'string' || bot.id === '') {
          throw new Error('materializeConfig: bot.id is required');
        }
        const pc = bot.providerConfig ?? {};
        if (typeof pc.cwd !== 'string' || pc.cwd === '') {
          throw new Error(`materializeConfig: bot ${bot.id} has no providerConfig.cwd`);
        }
        const profile = pc.profile || `wecom-${bot.id}`;
        const res = writeBotProfile({
          profile,
          model: pc.model,
          permission: pc.permission,
          prompt: pc.prompt,
          writableDirs: pc.writableDirs,
          workspaceRoot: pc.cwd,
          dshBin: pc.dshBin || 'dsh',
          nodeBin: pc.nodeBin || process.execPath,
          compaction: pc.compaction,
        });
        log?.info?.(`provider-dsh: materialized profile ${profile} → ${res.path}`);
        return { changed: true, profile, path: res.path };
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
