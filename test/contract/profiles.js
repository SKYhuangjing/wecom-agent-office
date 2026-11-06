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
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

// Computed locally (not imported from provider.contract.js) to avoid a
// module cycle: the contract suite imports PROFILES from here.
const FAKE_CLAUDE = fileURLToPath(new URL('../fake-bin/fake-claude.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fake-bin/fake-codex.js', import.meta.url));

// claude's project-dir slugging (verified against real sessions — see
// plugins/provider-claude/history.js header): every non-alphanumeric → '-'.
const projectDirName = (cwd) => String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');

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
    // Oversized-history fixture writer — produces the provider's REAL on-disk
    // format: a multi-frame zstd (3 frames; real dsh appends frames, so the
    // decoder path under test is the real one) holding a session.v4-style
    // JSONL with 2500 user/assistant turns. Built with node:zlib
    // zstdCompressSync (Node 24 ships it) — no external zstd dependency.
    hugeHistory: async (path) => {
      const events = [{ type: 'session', createdAt: 1 }];
      for (let i = 0; i < 2500; i++) {
        events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${i}` }] } });
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回答 ${i}` }] } }, time: 100 + i });
      }
      const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const chunk = Math.ceil(jsonl.length / 3);
      writeFileSync(path, Buffer.concat([0, 1, 2].map((i) =>
        zstdCompressSync(Buffer.from(jsonl.slice(i * chunk, (i + 1) * chunk), 'utf8')))));
    },
    makeRunnerArgs: ({ cwd, mode, fakeHome, wrapBin }) => ({ dshBin: wrapBin(mode, fakeHome), cwd }),
  },

  // plugins/provider-claude (M2 Task 2) — all groups, mirroring the dsh
  // profile: fake-claude injected via claudeBin wrapper + claudeConfigDir
  // pointed INSIDE the group's tmp cwd so readHistory never touches the real
  // ~/.claude. Session files use claude's real on-disk layout:
  // <claudeConfigDir>/projects/<projectDirName(cwd)>/<sessionId>.jsonl.
  claude: {
    note: 'full contract against fake-claude via claudeBin wrapper injection',
    // ok-mode final text; claude resumes via --resume (dsh spells it --session-id)
    expect: { okFinalText: () => '答案文本', resumeArg: '--resume' },
    fakeCli: true,
    events: true,
    history: true,
    // which fake CLI the suite's wrapBin execs (M2: claude has its own fake)
    fakeBin: FAKE_CLAUDE,
    // claudeConfigDir is derived the same way makeRunnerArgs derives it, so
    // the corrupt/huge fixtures land exactly where the reader looks.
    historyPath: (cwd, sessionId) =>
      join(cwd, 'claude-home', 'projects', projectDirName(cwd), `${sessionId}.jsonl`),
    // Oversized-history fixture writer — claude's REAL on-disk format: a
    // plain JSONL of user/assistant lines (plus the noise line types real
    // claude interleaves) with 2500 user/assistant turns.
    hugeHistory: async (path) => {
      const lines = [{ type: 'queue-operation', operation: 'enqueue', sessionId: 'huge', content: 'noise' }];
      for (let i = 0; i < 2500; i++) {
        const ts = new Date(100 + i).toISOString();
        lines.push({ type: 'user', isSidechain: false, message: { role: 'user', content: `问题 ${i}` }, timestamp: ts });
        lines.push({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] }, timestamp: ts });
      }
      lines.push({ type: 'cost-state', sessionId: 'huge', totalCostUSD: 0 });
      writeFileSync(path, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
    makeRunnerArgs: ({ cwd, mode, fakeHome, wrapBin }) => ({
      claudeBin: wrapBin(mode, fakeHome),
      cwd,
      claudeConfigDir: join(cwd, 'claude-home'),
    }),
  },

  // plugins/provider-codex (M2 Task 4) — all groups, mirroring the dsh/claude
  // profiles: fake-codex injected via codexBin wrapper + codexHome pointed
  // INSIDE the group's tmp cwd (the runner injects $CODEX_HOME with it, and
  // readHistory walks its sessions/ tree) so history never touches the real
  // ~/.codex. Session files use codex 0.166.0's real rollout layout:
  // <codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl with
  // {timestamp, ordinal, type, payload} lines (format discovered from the
  // files real codex wrote — see plugins/provider-codex/history.js header).
  codex: {
    note: 'full contract against fake-codex via codexBin wrapper injection',
    // ok-mode final text; codex resumes via the `exec resume` SUBCOMMAND (the
    // profile's resumeArg check greps last-argv for '<arg> <sid>')
    expect: { okFinalText: () => '答案文本', resumeArg: 'exec resume' },
    fakeCli: true,
    events: true,
    history: true,
    // which fake CLI the suite's wrapBin execs (codex has its own fake)
    fakeBin: FAKE_CODEX,
    // codexHome is derived the same way makeRunnerArgs derives it, so the
    // corrupt/huge fixtures land exactly where the reader looks.
    historyPath: (cwd, sessionId) =>
      join(cwd, 'codex-home', 'sessions', '2026', '11', '06', `rollout-2026-11-06T00-00-00-${sessionId}.jsonl`),
    // Oversized-history fixture writer — codex's REAL on-disk rollout format:
    // JSONL of {timestamp, ordinal, type, payload} lines with 2500
    // user/assistant response_item/message turns, plus the noise line types
    // real codex interleaves (session_meta / turn_context / event_msg /
    // token_usage_record / reasoning) and the harness-injected first user
    // message (AGENTS.md + environment_context blocks) the reader filters.
    hugeHistory: async (path) => {
      const ts = (o) => new Date(100 + o).toISOString();
      const lines = [
        { timestamp: ts(0), ordinal: 0, type: 'session_meta', payload: { session_id: 'huge', id: 'huge', cwd: '/w' } },
        { timestamp: ts(0), ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] } },
        { timestamp: ts(0), ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions <INSTRUCTIONS>…</INSTRUCTIONS>' }, { type: 'input_text', text: '<environment_context>\n<cwd>/w</cwd>\n</environment_context>' }] } },
      ];
      let ordinal = 3;
      for (let i = 0; i < 2500; i++) {
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'turn_context', payload: { cwd: '/w', sandbox: 'read-only' } });
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `问题 ${i}` }] } });
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gTM-' } });
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'event_msg', payload: { type: 'item_completed', item: { id: `item_${i}`, type: 'agent_message', text: `回答 ${i}` } } });
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `回答 ${i}` }] } });
        lines.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'token_usage_record', payload: { info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } });
      }
      writeFileSync(path, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
    makeRunnerArgs: ({ cwd, mode, fakeHome, wrapBin }) => ({
      codexBin: wrapBin(mode, fakeHome),
      cwd,
      codexHome: join(cwd, 'codex-home'),
    }),
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
