// code-guard plugin (万物皆插件): registers the outbound middleware that
// strips code blocks (providerConfig.codeGuard) and masks exact internal
// terms (providerConfig.maskTerms) from opted-in bots' final replies
// (guard.js header has the why). Defensive providerConfig reads like
// toolLoopMaxCalls/sessionTtlMin (unknown keys pass validation freely), so
// the switches flip via the ordinary bot PATCH and work for every engine.
import { createGuard } from './guard.js';

const maskListOf = (bot) => {
  const v = bot?.providerConfig?.maskTerms;
  return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t.trim().length >= 2) : [];
};

export default {
  manifest: {
    id: 'code-guard',
    name: '代码内容出站守卫',
    type: 'middleware',
    version: '0.2.0',
    requires: { kernel: '^1' },
  },

  activate(ctx) {
    ctx.registerMiddleware(createGuard({
      isStripOn: (bot) => bot?.providerConfig?.codeGuard === true,
      maskTermsOf: maskListOf,
      log: ctx?.log ?? null,
    }));
    // Registering twice would double-apply nothing (both rewrites are
    // idempotent), and the lifecycle owns teardown — nothing to clean up.
  },
};
