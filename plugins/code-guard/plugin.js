// code-guard plugin (万物皆插件): registers the outbound middleware that
// strips code blocks from opted-in bots' final replies (guard.js header has
// the why). The per-bot toggle is providerConfig.codeGuard === true — a
// defensive providerConfig read like toolLoopMaxCalls/sessionTtlMin (unknown
// keys pass validation freely; core-engine consumes its own knobs), so the
// switch flips via the ordinary bot PATCH and works for every engine.
import { createGuard } from './guard.js';

export default {
  manifest: {
    id: 'code-guard',
    name: '代码内容出站守卫',
    type: 'middleware',
    version: '0.1.0',
    requires: { kernel: '^1' },
  },

  activate(ctx) {
    ctx.registerMiddleware(createGuard({
      isOn: (bot) => bot?.providerConfig?.codeGuard === true,
      log: ctx?.log ?? null,
    }));
    // Registering twice would double-strip nothing (the rewrite is
    // idempotent), and the lifecycle owns teardown — nothing to clean up.
  },
};
