// Provider plugin template (Task 8): a WORKING demo of the provider port —
// copy this dir, rename id/port below, and replace the echo runner with a real
// agent CLI. Comments here are the contract; docs/PLUGIN-DEV.md is the full
// reference. The port id ('template') is what bots.json references; the
// manifest id ('template-provider') is what plugins.json enables/disables.
const PORT_ID = 'template';

export default {
  manifest: {
    id: 'template-provider',
    name: 'Template Provider',
    type: 'provider',
    version: '0.1.0',
    // Four-layer version negotiation (DESIGN §2.4): kernel API + the ports
    // this plugin speaks. Bump the range when you adopt a newer contract.
    requires: { kernel: '^1', ports: { provider: '^1' } },
  },

  activate(ctx) {
    ctx.registerProvider(PORT_ID, {
      // Shape of the providerConfig block a bot carries in bots.json.
      // Types: string | password | enum | bool | list | object.
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
      ],

      // Field-level validation → list of error strings ([] = valid). The
      // engine marks offending bots offline with these messages instead of
      // silently guessing.
      validate(providerConfig) {
        const errors = [];
        if (typeof providerConfig?.cwd !== 'string' || providerConfig.cwd === '') {
          errors.push('cwd is required');
        }
        return errors;
      },

      // Optional hook (dsh-style config file materialization): returning null
      // means "nothing to materialize" — the demo needs no side files. A real
      // one writes tmp+rename atomically and reports { changed }.
      materializeConfig(bot, { log }) {
        void bot; void log;
        return null;
      },

      createRunner({ bot, providerConfig, log }) {
        // Demo-only: touch the arguments so a linter cannot flag them unused
        // while keeping the real signature visible for copying.
        void bot; void providerConfig; void log;
        return {
          // The whole run contract in one demo: always RESOLVE (never reject),
          // machine-readable code, sessionId round-trip, diagnostic detail.
          // A real runner additionally honors `signal` (SIGTERM → escalate to
          // SIGKILL before resolving) and streams ordered events via onEvent.
          async run({ prompt, sessionId, signal }) {
            if (signal?.aborted) {
              return {
                ok: false, code: 'aborted', finalText: '', aborted: true,
                sessionId: sessionId || 'session-template-demo',
                reason: 'signal already aborted', detail: { exitCode: null, stderrTail: '' },
              };
            }
            return {
              ok: true,
              code: 'completed',
              finalText: `template echo: ${prompt}`,
              aborted: false,
              sessionId: sessionId || 'session-template-demo', // first turn mints, later turns pass through
              reason: null,
              detail: { exitCode: 0, stderrTail: '' },
            };
          },

          // Tolerant history reader: missing/corrupt/oversized history is a
          // warning, never a throw.
          async readHistory(providerConfig, sessionId) {
            void providerConfig; void sessionId;
            return { turns: [], truncated: false, warnings: [] };
          },
        };
      },

      // runResult (the object run() resolved with) → human-readable sentence
      // for logs and the diagnostics page.
      describeError(runResult) {
        return String(runResult?.error);
      },
    });
  },
};
