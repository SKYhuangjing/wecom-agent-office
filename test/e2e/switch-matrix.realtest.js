// M2 Task 6: the three-provider switch matrix over REAL CLIs (dsh / claude /
// codex) — the M2 centerpiece proving DESIGN §7 switching semantics end to
// end. NOT part of `npm test` (real CLIs + tokens): run via
//   npm run test:matrix        (or: node --test test/e2e/switch-matrix.realtest.js)
// The `.realtest.js` suffix keeps it out of the `test/**/*.test.js` glob.
//
// Two levels:
//  A. ENGINE-LEVEL (the §7 semantics, one chatKey / 7 real turns):
//     real Engine + real Ledger + real SessionCache in a tmp dataDir, with the
//     REAL provider runners (provider-dsh/-claude/-codex runner.js) wrapped in
//     a recording proxy — the only instrumentation is capturing the prompt +
//     sessionId the runner receives; the CLI below the runner is 100% real.
//       turn 1  dsh    fresh session, told passcode CODE1          (model A profile)
//       turn 2  dsh    SAME session, config REWRITTEN to model B  → S1-dsh: native resume survives the rewrite (prompt is the bare message)
//       turn 3  claude switch away → S2: full handoff prefix (both dsh turns), fresh session, AND claude functionally recalls CODE1 (the prefix actually worked)
//       turn 4  claude SAME session under --model switch          → S1-claude: native resume, bare prompt
//       turn 5  codex  switch away again (full prefix), told CODE2
//       turn 6  codex  SAME thread under -m switch                → S1-codex: native resume, bare prompt
//       turn 7  dsh    switch BACK                                → S3: resumes the ORIGINAL dsh sessionId with a delta-ONLY prefix
//                  (claude+codex rows since dsh's consumedSeq — NOT the old dsh
//                  rounds = counterexample A live on real CLIs) and functionally
//                  recalls CODE2 (the delta actually reached the resumed session).
//  B. API-LEVEL SMOKE: real kernel (createKernel, repo plugins) + three
//     enabled:false bots → POST /api/bots/:id/test round 1 (fresh) → round 2
//     with body {sessionId} (the M2-T6 api.js passthrough) → both rounds
//     completed and the CLI kept the session/thread id, per provider.
//
// Scenario 4 (反例 A/B) stays locked in test/ledger/ledger.test.js — those
// unit pins run in `npm test`; this file re-proves counterexample A BEHAVIOR
// (already-consumed rows never replayed) on the real chain at turn 7.
//
// Machine facts this run relies on (probe baselines + local config): dsh
// profile table carries magpie models; claude routes via ~/.claude/settings
// env (magpie gateway); codex routes via ~/.codex/config.toml
// (openai_base_url). Model switches use ids present in each catalog:
// dsh workbuddy/deepseek-v4.1-flash → auto/glm-5.3-flash; claude default →
// auto/hy3; codex default (auto/gpt-6-luna) → auto/hy3.
// CLIs write their own session stores under $HOME (~/.dsh / ~/.claude /
// ~/.codex) — same as every probe run; tmp cwds and the materialized dsh
// profile are cleaned up in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Engine } from '../../plugins/core-engine/engine.js';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';
import { maskOutbound } from '../../plugins/core-engine/middleware.js';
import { createRunner as createDshRunner } from '../../plugins/provider-dsh/runner.js';
import { writeBotProfile, removeProfile } from '../../plugins/provider-dsh/profiles.js';
import { createRunner as createClaudeRunner } from '../../plugins/provider-claude/runner.js';
import { createRunner as createCodexRunner } from '../../plugins/provider-codex/runner.js';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDOFF_HEADER = '以下是本对话此前的记录（供上下文参考）：';

// Real CLIs are a hard precondition: absent CLI → whole-file skip (probe.sh
// convention — loud, never fatal for CI without the CLIs).
const have = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }).status === 0;
const MISSING = ['dsh', 'claude', 'codex'].filter((b) => !have(b));
const RUN = MISSING.length === 0;
const SKIP_REASON = RUN ? false : `real CLIs not on PATH: ${MISSING.join(', ')}`;

// Fresh passcodes per run: no earlier session/memory can answer this run.
const CODE1 = `M2T6A-${randomUUID().slice(0, 8)}`;
const CODE2 = `M2T6B-${randomUUID().slice(0, 8)}`;
const R1 = `记住暗号${CODE1}，只回复：好的`;
const R2 = '现在只回复两个字：收到';
const R3 = '暗号是什么？只回复暗号本身，不要有任何其他文字';
const R4 = '只回复两个字：收到';
const R5 = `再记住一个新暗号${CODE2}，只回复：好的`;
const R6 = '只回复两个字：收到';
const R7 = '新来的助手刚才记的新暗号是什么？只回复暗号本身，不要有任何其他文字';

const DSH_PROFILE = 'wecom-m2t6-matrix';
const DSH_MODEL_A = { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' };
const DSH_MODEL_B = { provider: 'magpie', model: 'auto/glm-5.3-flash' };
const CLAUDE_MODEL_B = 'auto/hy3'; // round-2 --model switch (default route on round 1)
const CODEX_MODEL_B = 'auto/hy3'; // round-2 -m switch (config.toml default on round 1)

// Real-run timescales: 4min hard cap per turn (smoke-dsh uses 180s), warn
// phase effectively off, ms throttling irrelevant (reply-only fake adapter).
const LIMITS = {
  concurrency: 1, minIntervalMs: 0, heartbeatMs: 3_600_000, maxContentChars: 3500,
  streamDeadlineMs: 3_600_000, hardTimeoutMs: 240_000, warnLeadMs: 90_000,
  outboundBudgetPerMin: 28,
};

const K = 'wecom:group:m2t6';
const mkMsg = (text) => ({
  chatKey: K, chatKind: 'group', chatid: 'm2t6', userid: 'm2t6-user',
  text, reqId: `m2t6-${randomUUID()}`,
});

// Reply-only recording adapter (no stream frames → no throttle/heartbeat
// machinery in the way; the matrix cares about prompts/cache/ledger, not frames).
const recordingAdapter = () => {
  const frames = [];
  return {
    capabilities: { stream: false, push: true },
    frames,
    ack: async (reqId, streamId, text) => { frames.push({ m: 'ack', reqId, text }); },
    progress: async (reqId, streamId, text, finish) => { frames.push({ m: 'progress', reqId, text, finish: !!finish }); },
    reply: async (reqId, text) => { frames.push({ m: 'reply', reqId, text }); },
    push: async (chatRef, text) => { frames.push({ m: 'push', chatRef, text }); },
  };
};

// —— shared chain state (tests run in declaration order; node:test is sequential)
let dataDir;
let workDir;
let ledger;
let cache;
let engine;
let bot;
let adapter;
let runners; // provider → recording runner over the REAL runner
const recorded = []; // { provider, prompt, sessionId } per REAL runner.run
let dshSid = null;
let claudeSid = null;
let codexSid = null;

const REAL_FACTORIES = {
  dsh: createDshRunner,
  claude: createClaudeRunner,
  codex: createCodexRunner,
};

// The provider port's makeRunner equivalent, wrapped in the recording proxy:
// everything the engine hands the runner reaches the REAL runner untouched.
const runnerFor = (provider, providerConfig) => {
  const real = REAL_FACTORIES[provider]({ bot: { id: bot.id, provider }, providerConfig, log: console });
  return {
    async run(args) {
      recorded.push({ provider, prompt: args.prompt, sessionId: args.sessionId ?? null });
      return real.run(args);
    },
    ...(typeof real.readHistory === 'function' ? { readHistory: (...a) => real.readHistory(...a) } : {}),
  };
};

// A provider/model switch, the engine-level equivalent of PATCH provider/
// providerConfig: mutate the shared bot record and swap the live runner.
const setProvider = (provider, providerConfig) => {
  bot.provider = provider;
  bot.providerConfig = providerConfig;
  runners.set(provider, runnerFor(provider, providerConfig));
};

const turn = async (text) => {
  engine.onMessage(bot, mkMsg(text));
  await engine.chains.get(K);
  await new Promise((r) => setImmediate(r));
};

const rows = () => ledger.turns({ chatKey: K });
const lastRow = () => rows().at(-1);

// node:test quirk: before({skip:false}, fn) silently DROPS the fn — register
// the hooks in the plain form only when the suite actually runs; when CLIs
// are missing the tests self-skip and the hooks (and their tmp state) are
// never needed.
if (RUN) {
  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wao-m2t6-data-'));
    workDir = mkdtempSync(join(tmpdir(), 'wao-m2t6-cwd-'));
    ledger = new Ledger({ file: join(dataDir, 'ledger', 'm2t6-matrix.jsonl'), log: console });
    cache = new SessionCache({ file: join(dataDir, 'sessions', 'm2t6-matrix.json'), log: console, ledger });
    bot = { id: 'm2t6-matrix', name: 'M2T6 矩阵', provider: 'dsh', channel: 'wecom', allowedUsers: [] };
    runners = new Map();
    adapter = recordingAdapter();

    engine = new Engine({
      log: console,
      getRunner: (b) => runners.get(b.provider),
      getAdapter: () => adapter,
      ledgerFactory: () => ({ ledger, cache }),
      middleware: { maskOutbound },
      limits: LIMITS,
    });
    setProvider('dsh', { cwd: workDir, profile: DSH_PROFILE, dshBin: 'dsh', nodeBin: process.execPath, permission: 'workspace-write' });
    // Materialize the dsh profile with model A (exactly what POST/PATCH →
    // materializeConfig would do for this providerConfig).
    writeBotProfile({
      profile: DSH_PROFILE, model: DSH_MODEL_A, permission: 'workspace-write',
      workspaceRoot: workDir, dshBin: 'dsh', nodeBin: process.execPath,
    });
    engine.attachBot(bot, { adapter, runner: runners.get('dsh') });
  });

  after(async () => {
    try { removeProfile(DSH_PROFILE); } catch { /* best-effort cleanup */ }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
}

// —— S1a: dsh 同 provider 换模型（config 重写）原生续会话 ———————————————————
test('S1a dsh: config rewrite to model B → round 2 resumes the SAME session with the BARE prompt', { skip: SKIP_REASON }, async () => {
  await turn(R1);
  const r1 = lastRow();
  assert.equal(r1.reason, 'completed', `turn 1 completed: ${r1.assistant}`);
  dshSid = r1.sessionId;
  assert.ok(dshSid, 'turn 1 minted a dsh sessionId');
  assert.equal(recorded[0].sessionId, null, 'fresh turn passes sessionId:null');
  let rec = cache.get(K);
  assert.equal(rec.current, 'dsh');
  assert.equal(rec.cache.dsh.sessionId, dshSid);
  assert.equal(rec.cache.dsh.consumedAtBuild, 0, 'first turn consumed nothing before it');
  assert.equal(rec.cache.dsh.consumedSeq, 1, 'rule 2 advanced past its own row');

  // "换模型" for dsh = rewrite the materialized profile (the model knob lives
  // there, not on the CLI line) — a REAL value change A → B.
  writeBotProfile({
    profile: DSH_PROFILE, model: DSH_MODEL_B, permission: 'workspace-write',
    workspaceRoot: workDir, dshBin: 'dsh', nodeBin: process.execPath,
  });
  setProvider('dsh', { cwd: workDir, profile: DSH_PROFILE, dshBin: 'dsh', nodeBin: process.execPath, permission: 'workspace-write' });

  await turn(R2);
  const r2 = lastRow();
  assert.equal(r2.reason, 'completed', `turn 2 completed under the rewritten profile: ${r2.assistant}`);
  assert.equal(recorded[1].sessionId, dshSid, 'round 2 NATIVELY resumed the same dsh sessionId');
  assert.equal(recorded[1].prompt, R2, 'native resume carries NO handoff prefix (bare message)');
  rec = cache.get(K);
  assert.equal(rec.cache.dsh.sessionId, dshSid, 'cache session unchanged by the config rewrite');
  assert.equal(rec.current, 'dsh');
  assert.deepEqual(rows().map((r) => r.provider), ['dsh', 'dsh']);
});

// —— S2: 跨 provider 去（dsh → claude 全量交接）———————————————————————————
test('S2 dsh→claude: full handoff prefix + functional recall + cache upsert (consumedAtBuild = maxSeq, no provider filter)', { skip: SKIP_REASON }, async () => {
  assert.equal(ledger.maxSeq({ chatKey: K }), 2, 'two dsh rows exist before the switch');
  setProvider('claude', { cwd: workDir });
  await turn(R3);
  const r3 = lastRow();
  assert.equal(r3.reason, 'completed', `claude turn completed: ${r3.assistant}`);
  claudeSid = r3.sessionId;
  assert.ok(claudeSid && claudeSid !== dshSid, 'claude minted its own session');

  const call = recorded[2];
  assert.equal(call.sessionId, null, 'cross-provider turn starts a FRESH claude session');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER), `prompt starts with the handoff header: ${call.prompt.slice(0, 40)}`);
  assert.ok(call.prompt.includes(R1), 'prefix carries dsh round 1 (the passcode turn)');
  assert.ok(call.prompt.includes(R2), 'prefix carries dsh round 2');
  assert.ok(call.prompt.endsWith(R3), 'the new message is appended after the prefix');

  // Functional proof the prefix WORKED: CODE1 exists only inside the dsh
  // session — a fresh claude session can only know it from the handoff text.
  assert.ok(r3.assistant.includes(CODE1), `claude recalled the passcode from the handoff prefix: ${r3.assistant}`);

  const rec = cache.get(K);
  assert.equal(rec.current, 'claude');
  assert.equal(rec.cache.claude.sessionId, claudeSid);
  assert.equal(rec.cache.claude.consumedAtBuild, 2, 'rule 1: consumedAtBuild = maxSeq(chatKey) BEFORE this turn');
  assert.equal(rec.cache.claude.consumedSeq, 3, 'rule 2 advanced past the claude row');
  assert.equal(rec.cache.dsh.sessionId, dshSid, 'the dsh entry survives the switch away');
  assert.equal(rec.cache.dsh.dirty, false, 'switching away does NOT dirty the old session');
});

// —— S1b: claude 同 provider 换模型（--model）原生续 ————————————————————————
test('S1b claude: --model switch round 2 → same session, bare prompt; then switch away to codex (full prefix)', { skip: SKIP_REASON }, async () => {
  setProvider('claude', { cwd: workDir, model: { model: CLAUDE_MODEL_B } });
  await turn(R4);
  const r4 = lastRow();
  assert.equal(r4.reason, 'completed', `claude model-B round completed: ${r4.assistant}`);
  assert.equal(recorded[3].sessionId, claudeSid, 'claude NATIVELY resumed the same session across the model switch');
  assert.equal(recorded[3].prompt, R4, 'native resume carries NO handoff prefix');
  assert.equal(cache.get(K).cache.claude.sessionId, claudeSid, 'cache claude session unchanged');

  // switch away again — codex gets a FRESH session with the full prefix
  setProvider('codex', { cwd: workDir });
  await turn(R5);
  const r5 = lastRow();
  assert.equal(r5.reason, 'completed', `codex turn completed: ${r5.assistant}`);
  codexSid = r5.sessionId;
  assert.ok(codexSid, 'codex minted a thread id');
  const call = recorded[4];
  assert.equal(call.sessionId, null, 'fresh codex thread');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER), 'codex handoff prefix present');
  assert.ok(call.prompt.includes(R1) && call.prompt.includes(R3) && call.prompt.includes(R5),
    'prefix carries history across BOTH prior providers');
  const rec = cache.get(K);
  assert.equal(rec.current, 'codex');
  assert.equal(rec.cache.codex.consumedAtBuild, 4, 'rule 1 pin on the codex upsert');
  assert.equal(rec.cache.claude.dirty, false, 'claude entry stays clean after the second switch away');
});

// —— S1c: codex 同 provider 换模型（-m）原生续同 thread —————————————————————
test('S1c codex: -m switch round 2 → same thread, bare prompt', { skip: SKIP_REASON }, async () => {
  setProvider('codex', { cwd: workDir, model: { model: CODEX_MODEL_B } });
  await turn(R6);
  const r6 = lastRow();
  assert.equal(r6.reason, 'completed', `codex model-B round completed: ${r6.assistant}`);
  assert.equal(recorded[5].sessionId, codexSid, 'codex NATIVELY resumed the same thread across the model switch');
  assert.equal(recorded[5].prompt, R6, 'native resume carries NO handoff prefix');
  assert.equal(cache.get(K).cache.codex.sessionId, codexSid, 'cache codex thread unchanged');
});

// —— S3: 跨 provider 回（claude→codex 之后切回 dsh，delta-only 重放）——————————
test('S3 back to dsh: ORIGINAL sessionId resumed, delta-ONLY prefix (counterexample A live), consumedSeq advanced, functional recall', { skip: SKIP_REASON }, async () => {
  const dshConsumedBefore = cache.get(K).cache.dsh.consumedSeq; // 2
  setProvider('dsh', { cwd: workDir, profile: DSH_PROFILE, dshBin: 'dsh', nodeBin: process.execPath, permission: 'workspace-write' });
  await turn(R7);
  const r7 = lastRow();
  assert.equal(r7.reason, 'completed', `switch-back turn completed: ${r7.assistant}`);

  const call = recorded[6];
  assert.equal(call.sessionId, dshSid, 'switch-back resumes the ORIGINAL dsh sessionId');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER), 'delta replay carries the header');
  // counterexample A, real chain: ONLY the rows dsh had not consumed —
  // the claude/codex turns — never the already-consumed dsh rounds.
  assert.ok(!call.prompt.includes(R1), `already-consumed dsh round 1 NOT replayed (consumedSeq=${dshConsumedBefore})`);
  assert.ok(!call.prompt.includes(R2), 'already-consumed dsh round 2 NOT replayed');
  assert.ok(call.prompt.includes(R3) && call.prompt.includes(R4), 'claude delta rows replayed');
  assert.ok(call.prompt.includes(R5) && call.prompt.includes(R6), 'codex delta rows replayed');
  assert.ok(call.prompt.endsWith(R7), 'the new message appended after the delta');

  // Functional proof the delta reached the resumed session: CODE2 was told
  // ONLY to codex (turn 5) — the original dsh session never saw it natively.
  assert.ok(r7.assistant.includes(CODE2), `dsh recalled CODE2 from the replayed delta: ${r7.assistant}`);

  const rec = cache.get(K);
  assert.equal(rec.current, 'dsh', 'current flipped back to dsh');
  assert.equal(rec.cache.dsh.sessionId, dshSid, 'dsh session id unchanged by the round trip');
  assert.ok(rec.cache.dsh.consumedSeq >= 7, `consumedSeq advanced past the whole delta window (${rec.cache.dsh.consumedSeq})`);
  assert.deepEqual(rows().map((r) => r.provider), ['dsh', 'dsh', 'claude', 'claude', 'codex', 'codex', 'dsh'],
    'ledger journal spans all three providers on one chatKey');
  assert.equal(rows()[6].sessionId, dshSid, 'the switch-back row journals the resumed dsh session');
});

// —— S4 note: 反例 A/B 的单元级锁定在 test/ledger/ledger.test.js（npm test 内）
//    恒绿；本文件 turn 7 在真实链路上复证了反例 A 的行为（旧轮不再重放）。

// —— S5: API 级冒烟（真内核 × 三家 × /test sessionId 透传两轮）————————————————
test('S5 API smoke: real kernel, three enabled:false bots, /test round 2 {sessionId} resumes per provider', { skip: SKIP_REASON }, async () => {
  const apiData = mkdtempSync(join(tmpdir(), 'wao-m2t6-api-'));
  // The bots' cwds must EXIST before any runner spawns in them (spawn in a
  // missing cwd fails with a bare ENOENT — first-run lesson of this suite).
  for (const p of ['dsh', 'claude', 'codex']) mkdirSync(join(apiData, p), { recursive: true });
  const kernel = await createKernel({ port: 0, dataDir: apiData, pluginsDirs: [join(repoRoot, 'plugins')] });
  const base = `http://127.0.0.1:${kernel.http.port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    // profile omitted for the dsh bot → the plugin default wecom-<botId>
    const DSH_API_ID = ['m2t6-api-dsh', 'dsh'].join('-');
    const cases = [
      { id: DSH_API_ID, provider: 'dsh', providerConfig: { cwd: join(apiData, 'dsh'), dshBin: 'dsh', nodeBin: process.execPath, permission: 'workspace-write' } },
      { id: 'm2t6-api-claude', provider: 'claude', providerConfig: { cwd: join(apiData, 'claude') } },
      { id: 'm2t6-api-codex', provider: 'codex', providerConfig: { cwd: join(apiData, 'codex') } },
    ];
    for (const { id, provider, providerConfig } of cases) {
      const create = await post('/api/bots', {
        id, name: `M2T6 ${provider}`, enabled: false, channel: 'wecom',
        account: { botId: 'm2t6', secret: 'x' }, provider, providerConfig,
      });
      assert.equal(create.status, 200, `${provider}: bot created (${await create.text()})`);

      const r1 = await (await post(`/api/bots/${id}/test`)).json();
      assert.equal(r1.code, 'completed', `${provider}: probe round 1 completed: ${JSON.stringify(r1)}`);
      assert.ok(r1.sessionId, `${provider}: round 1 returned a sessionId`);

      const r2resp = await post(`/api/bots/${id}/test`, { sessionId: r1.sessionId });
      assert.equal(r2resp.status, 200);
      const r2 = await r2resp.json();
      assert.equal(r2.code, 'completed', `${provider}: probe round 2 (resume ${r1.sessionId}) completed: ${JSON.stringify(r2)}`);
      assert.equal(r2.sessionId, r1.sessionId, `${provider}: the resumed session id survived the round trip`);

      assert.equal((await fetch(`${base}/api/bots/${id}`, { method: 'DELETE' })).status, 200, `${provider}: cleanup delete`);
    }
  } finally {
    await kernel.stop();
    rmSync(apiData, { recursive: true, force: true });
    try { removeProfile(`wecom-${DSH_API_ID}`); } catch { /* belt: DELETE already removeConfig'd it */ }
  }
});
