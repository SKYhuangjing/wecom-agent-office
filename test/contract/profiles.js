// Per-plugin expectations for the provider port contract suite (Task 16).
// The suite verifies DESIGN §5's port contract; a few of its groups only make
// sense against a provider that actually spawns a CLI (kill escalation, exit
// codes, lock stderr) or streams events. Profiles keep the suite HONEST for
// both ends: the template's demo runner (spawns nothing) skips process groups
// instead of failing them, while provider-dsh (Task 18) runs everything.
//
// Keyed by the PORT id the plugin registers (ctx.registerProvider('<id>', …)),
// not the manifest id. A port without an entry runs the FULL contract via
// defaultProfile() — loud failure over silent skipping when someone forgets
// to declare capabilities.
import { join } from 'node:path';

export const PROFILES = {
  // plugins/_template/provider — the reference implementation the suite must
  // stay green against until provider-dsh lands (Task 18). Its runner is a
  // pure in-process echo: no child, no event stream, no real history reader.
  template: {
    note: 'demo runner spawns nothing — process/event/history groups skipped; result-shape groups still enforced',
    // The demo echoes the prompt; the ok group's finalText assertion uses this.
    expect: { okFinalText: (prompt) => `template echo: ${prompt}` },
    fakeCli: false, // cannot run the fake-dsh binary → groups 4-8 and argv/prompt probes skipped
    events: false, // emits no unified events → thinking/tool/timing event checks skipped
    // 'deferred' is the ONLY way the history group skips — a suite-side
    // declaration that the real reader is still pending (the demo stub would
    // lie about dsh-format fixtures). Plugin-side opt-outs do not exist.
    history: 'deferred',
    makeRunnerArgs: ({ cwd }) => ({ cwd }), // the template validates cwd only
  },

  // plugins/provider-dsh (Task 18) — expected to run ALL groups. Mode control
  // is injected via wrapper bins (test/contract/provider.contract.js wrapBin):
  // a tiny /bin/sh script exporting FAKE_MODE/FAKE_HOME before exec'ing
  // fake-dsh.js, so the provider needs no env-passthrough support — it only
  // has to honor providerConfig.dshBin and spawn it dsh-style.
  dsh: {
    note: 'full contract against fake-dsh via dshBin wrapper injection',
    expect: { okFinalText: () => '答案文本' }, // fake-dsh ok mode always finalizes with this
    fakeCli: true,
    events: true,
    history: true,
    // Where readHistory looks for a session file, relative to providerConfig
    // cwd. THE CONVENTION the suite and provider-dsh share (see README).
    historyPath: (cwd, sessionId) => join(cwd, 'sessions', `${sessionId}.zst`),
    // Oversized-history fixture writer (2500 turns) — deliberately a hook:
    // it must produce the provider's REAL on-disk format (zstd multi-frame
    // for dsh), which only the provider task can encode. null → the huge
    // case reports SKIP; Task 18 implements it (generate via dsh itself, or
    // check in a compressed fixture). missing/corrupt cases are
    // format-agnostic and always run.
    hugeHistory: null,
    makeRunnerArgs: ({ cwd, mode, fakeHome, wrapBin }) => ({ dshBin: wrapBin(mode, fakeHome), cwd }),
  },
};

// Unknown port → assume the full contract. A provider that cannot satisfy a
// group declares so in ITS profile entry here — never plugin-side (no
// capabilities flag, missing method, or "not implemented" throw buys a skip).
export const defaultProfile = (portId) => ({
  note: `no profile entry for port '${portId}' — running the FULL contract (declare one in test/contract/profiles.js if a group is genuinely out of scope)`,
  expect: {},
  fakeCli: true,
  events: true,
  history: true,
  // LOUD ASSUMPTION: without a profile we can only GUESS the dsh history
  // layout (<cwd>/sessions/<sessionId>.zst). A non-dsh provider with a
  // different layout never reads the suite's corrupt fixture and would
  // answer with missing-file semantics — the suite pairs this flag with a
  // corrupt≠missing warnings check so such providers FAIL loudly instead of
  // accidentally passing. Declare a profile with the real historyPath.
  assumedHistoryPath: true,
  historyPath: (cwd, sessionId) => join(cwd, 'sessions', `${sessionId}.zst`),
  hugeHistory: null,
  makeRunnerArgs: PROFILES.dsh.makeRunnerArgs,
});
