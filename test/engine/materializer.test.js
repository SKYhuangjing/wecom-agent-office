// W3 T2 unit tests: plugins/core-engine/materializer.js — the REAL pipeline
// executor in isolation (stub provider, no real CLIs). Covers §3.4 marker
// surgery (fresh/replace/orphan 四态/foreign/unknown-version), §3.6 JSON
// entry precise delete + unload semantics, §8.3 jail guard, §3.7 snapshot
// rollback, §3.8 manifest (all fields, failed keeps last-good), stale
// cleanup incl. the skill foreign-rewrite guard, §3.5 dryRun drift, the
// bind-time detection hooks (foreign skill / cross-bot manifest conflict /
// provider-without-materializeAssets refusal), targetsFor enrichment and the
// startupSweep (T1 migration once + read-only drift report).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaterializer, spliceMarkerSection, removeJsonEntry, planFingerprint } from '../../plugins/core-engine/materializer.js';

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'wao-mat-unit-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

const botDir = (id) => {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// A stub provider speaking the write-plan dialect: skills as SKILL.md with
// the x-wao-asset annotation, memory as a markdown marker section, an
// optional hook entry, an optional throw injection.
const stubPort = (id, extra = {}) => ({
  async materializeAssets(bot, plan, { assetsDir } = {}) {
    if (extra.throwAt === 'plan') throw new Error('plan exploded');
    const writes = [];
    const notes = [];
    const entries = [];
    for (const e of plan ?? []) {
      if (e.type === 'skill') {
        writes.push({
          kind: 'file-create',
          target: join(bot.providerConfig.cwd, 'skills', e.content.name, 'SKILL.md'),
          content: `---\nname: ${e.content.name}\nx-wao-asset: ${e.assetId}\n---\n\n${e.content.body}\n`,
          for: e.assetId,
        });
      } else if (e.type === 'memory') {
        writes.push({
          kind: 'marker-section',
          target: join(bot.providerConfig.cwd, 'NOTES.md'),
          format: 'markdown',
          content: `记忆：${e.content.notes.join('|')}`,
        });
      } else if (e.type === 'mcp') {
        writes.push({
          kind: 'file-create',
          target: join(assetsDir, bot.id, 'mcp.json'),
          content: `${JSON.stringify({ mcpServers: { [`wao-${Object.keys(e.content.servers)[0]}`]: e.content.servers[Object.keys(e.content.servers)[0]] } })}\n`,
          mode: 0o600,
          appliesTo: 'mcp',
        });
      }
    }
    if (extra.hookEntry) {
      writes.push({ kind: 'hook-entry', target: extra.hookEntry.file, pointer: '/hooks/PreToolUse', content: extra.hookEntry.entry });
      entries.push({ file: extra.hookEntry.file, pointer: '/hooks/PreToolUse', entry: extra.hookEntry.entry });
    }
    if (extra.throwAt === 'section' && writes.some((w) => w.kind === 'marker-section')) {
      // sabotage: a marker-section whose surgery must throw mid-execution
      writes.push({ kind: 'marker-section', target: join(bot.providerConfig.cwd, 'POISON.md'), format: 'markdown', content: 'x' });
      notes.push({ detail: 'poison section appended after the real writes' });
    }
    return { writes, notes, entries };
  },
});

const portsOf = (impl) => ({ getProvider: () => impl });
const mkMat = (impl, dataDir) => createMaterializer({ ports: portsOf(impl), dataDir: dataDir ?? join(root, 'data'), log: { info() {}, warn() {}, error() {} } });

const SKILL_ENTRY = { assetId: 'ast-s1', type: 'skill', name: 'wao-company', mode: 'shared', content: { name: 'wao-company', description: 'd', body: '正文' } };
const MEM_ENTRY = { assetId: 'ast-m1', type: 'memory', name: 'mem', mode: 'shared', content: { notes: ['n1', 'n2'] } };
const MCP_ENTRY = { assetId: 'ast-c1', type: 'mcp', name: 'mcp-x', mode: 'shared', content: { servers: { company: { command: 'node' } } } };

// —— §3.4 marker surgery ————————————————————————————————————————————————————

test('spliceMarkerSection: fresh append, replace-in-place, determinism', () => {
  const first = spliceMarkerSection('# 用户自己的文件\n', { botId: 'b1', format: 'markdown', content: '资产节 A' });
  assert.match(first.text, /用户自己的文件/);
  assert.match(first.text, /<!-- wao:assets:begin:v1:bot=b1 -->\n资产节 A\n<!-- wao:assets:end:v1:bot=b1 -->\n$/);
  const again = spliceMarkerSection(first.text, { botId: 'b1', format: 'markdown', content: '资产节 B' });
  assert.ok(!again.text.includes('资产节 A'), 'old section replaced');
  assert.equal(again.text.match(/wao:assets:begin/g).length, 1, 'exactly one section pair');
  const again2 = spliceMarkerSection(again.text, { botId: 'b1', format: 'markdown', content: '资产节 B' });
  assert.equal(again2.text, again.text, 'idempotent: same input+content → same bytes');
});

test('spliceMarkerSection: orphan states — single begin / single end / both deleted with remnants', () => {
  const mk = (text) => spliceMarkerSection(text, { botId: 'b1', format: 'markdown', content: '节内容' });
  // begin only → marker and everything after is debris
  const beginOnly = mk('前文\n<!-- wao:assets:begin:v1:bot=b1 -->\n残骸\n');
  assert.ok(!beginOnly.text.includes('残骸'));
  assert.match(beginOnly.text, /^前文/);
  // end only → same
  const endOnly = mk('前文\n<!-- wao:assets:end:v1:bot=b1 -->\n残骸\n');
  assert.ok(!endOnly.text.includes('残骸'));
  // both deleted, content gone with them → clean rebuild at EOF
  const neither = mk('前文\n');
  assert.match(neither.text, /前文\n\n<!-- wao:assets:begin:v1:bot=b1 -->\n节内容/);
});

test('spliceMarkerSection: TOML half-deleted states — outside wao- tables stripped, fresh equal to repaired', () => {
  const content = '[mcp_servers."wao-x"]\ncommand = "node"';
  const fresh = spliceMarkerSection('model = "gpt"\n', { botId: 'b1', format: 'toml', content });
  // state 1: begin deleted (end + tables remain outside)
  const s1 = spliceMarkerSection('model = "gpt"\n[mcp_servers."wao-x"]\ncommand = "node"\n# wao:assets:end:v1:bot=b1\n', { botId: 'b1', format: 'toml', content });
  // state 2: end deleted
  const s2 = spliceMarkerSection('model = "gpt"\n# wao:assets:begin:v1:bot=b1\n[mcp_servers."wao-x"]\ncommand = "node"\n', { botId: 'b1', format: 'toml', content });
  // state 3: both markers deleted, tables remain
  const s3 = spliceMarkerSection('model = "gpt"\n[mcp_servers."wao-x"]\ncommand = "node"\n', { botId: 'b1', format: 'toml', content });
  // state 4: markers intact but a wao- table hides OUTSIDE the section
  const s4 = spliceMarkerSection(`model = "gpt"\n[mcp_servers."wao-y"]\ncommand = "x"\n# wao:assets:begin:v1:bot=b1\n${content}\n# wao:assets:end:v1:bot=b1\n`, { botId: 'b1', format: 'toml', content });
  for (const [name, got] of [['s1', s1], ['s2', s2], ['s3', s3], ['s4', s4]]) {
    assert.equal(got.text, fresh.text, `${name}: 清孤儿+重建 = 全新物化逐字节相同`);
  }
  assert.ok(!fresh.text.includes('wao-y'));
});

test('spliceMarkerSection: foreign-bot markers and unknown version segments refuse (drift, no rewrite)', () => {
  assert.throws(
    () => spliceMarkerSection('<!-- wao:assets:begin:v1:bot=OTHER -->\nx\n', { botId: 'b1', format: 'markdown', content: 'y' }),
    /他 bot 命名空间/,
  );
  assert.throws(
    () => spliceMarkerSection('<!-- wao:assets:begin:v2:bot=b1 -->\n', { botId: 'b1', format: 'markdown', content: 'y' }),
    /版本段未知/,
  );
  assert.throws(
    () => spliceMarkerSection('# wao:assets:begin:v1:bot=b1\nA\n# wao:assets:begin:v1:bot=b1\n', { botId: 'b1', format: 'toml', content: 'x' }),
    /成对多于一份/,
  );
});

// —— §3.6 JSON entry precise delete ———————————————————————————————————————

test('removeJsonEntry: precise-match delete (even after index shift), user-edited entry warns without deleting', () => {
  const doc = { hooks: { PreToolUse: [{ matcher: 'User', hooks: [] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk run' }] }] } };
  const recorded = { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk run' }] };
  const r1 = removeJsonEntry(doc, '/hooks/PreToolUse/1', recorded);
  assert.equal(r1.removed, true);
  assert.deepEqual(r1.doc.hooks.PreToolUse.map((h) => h.matcher), ['User']);
  // index recorded as 5 but the twin sits at 0 — full-scan still hits precisely
  const r2 = removeJsonEntry(doc, '/hooks/PreToolUse/5', recorded);
  assert.equal(r2.removed, true, 'shifted index still deletes by deep-equal scan');
  // user edited the entry → no fuzzy delete, warn carries the recorded full text
  const edited = structuredClone(doc);
  edited.hooks.PreToolUse[1].hooks[0].command = 'user-rewrote-me';
  const r3 = removeJsonEntry(edited, '/hooks/PreToolUse/1', recorded);
  assert.equal(r3.removed, false);
  assert.match(r3.warn, /请人工确认后删除/);
  assert.equal(edited.hooks.PreToolUse.length, 2, 'nothing was deleted');
});

// —— materialize: execution, jail, manifest, rollback ————————————————————

test('materialize: writes files, 0600 for mode-bearing files, manifest carries all §3.8 fields', async () => {
  const dataDir = botDir('d-mat1');
  const mat = mkMat(stubPort('p1'), dataDir);
  const cwd = botDir('b-mat1-cwd');
  const bot = { id: 'b1', provider: 'stub', providerConfig: { cwd } };
  const plan = [SKILL_ENTRY, MEM_ENTRY, MCP_ENTRY];
  const r = await mat.materialize(bot, plan);
  const actions = r.writes.map((w) => `${w.action} ${w.path}`);
  assert.equal(actions.filter((a) => a.startsWith('write')).length, 3);
  assert.ok(existsSync(join(cwd, 'skills', 'wao-company', 'SKILL.md')));
  assert.match(readFileSync(join(cwd, 'NOTES.md'), 'utf8'), /记忆：n1\|n2/);
  const mcpFile = join(dataDir, 'assets', 'b1', 'mcp.json');
  assert.ok(existsSync(mcpFile));
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600, 'mcp file lands 0600 (§4.2 ③)');
  const manifest = JSON.parse(readFileSync(join(dataDir, 'assets', 'b1', 'manifest.json'), 'utf8'));
  assert.equal(manifest.botId, 'b1');
  assert.equal(manifest.planFingerprint, planFingerprint(plan));
  assert.equal(manifest.lastResult, 'ok');
  assert.ok(Number.isFinite(manifest.lastMaterializedAt));
  assert.deepEqual(manifest.writes.map((w) => w.kind).sort(), ['file-create', 'file-create', 'marker-section']);
  // manifest itself 0600 (data/ discipline)
  assert.equal(statSync(join(dataDir, 'assets', 'b1', 'manifest.json')).mode & 0o777, 0o600);
});

test('getManifest: §3.8 read access for the roster — null when absent, deep clone of the stored doc', async () => {
  const dataDir = botDir('d-getm');
  const mat = mkMat(stubPort('p1'), dataDir);
  const cwd = botDir('b-getm-cwd');
  const bot = { id: 'bg1', provider: 'stub', providerConfig: { cwd } };
  assert.equal(mat.getManifest('bg1'), null, 'never materialized → null (§8.1 null echo)');
  assert.equal(mat.getManifest('nobody'), null);
  await mat.materialize(bot, [MEM_ENTRY]);
  const m = mat.getManifest('bg1');
  assert.equal(m.botId, 'bg1');
  assert.equal(m.lastResult, 'ok');
  assert.ok(Number.isFinite(m.lastMaterializedAt));
  m.lastResult = 'mutated'; // callers get a CLONE — the disk doc is the truth
  assert.equal(mat.getManifest('bg1').lastResult, 'ok');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'assets', 'bg1', 'manifest.json'), 'utf8')).lastResult, 'ok');
});

test('materialize: jail guard — target outside every allowed root throws and writes nothing', async () => {
  const dataDir = botDir('d-jail');
  const evilPort = {
    async materializeAssets(bot) {
      return { writes: [{ kind: 'file-create', target: join(root, 'outside.txt'), content: 'x' }], notes: [], entries: [] };
    },
  };
  const mat = mkMat(evilPort, dataDir);
  const cwd = botDir('b-jail-cwd');
  await assert.rejects(mat.materialize({ id: 'j1', provider: 'stub', providerConfig: { cwd } }, [SKILL_ENTRY]), /越界/);
  assert.ok(!existsSync(join(root, 'outside.txt')));
  // a ..-segmented target is refused even under a root (raw string — join()
  // would normalize the .. away and only the prefix check would fire)
  const dotdotPort = {
    async materializeAssets(bot) {
      return { writes: [{ kind: 'file-create', target: bot.providerConfig.cwd + '/../escape.txt', content: 'x' }], notes: [], entries: [] };
    },
  };
  await assert.rejects(mkMat(dotdotPort, dataDir).materialize({ id: 'j2', provider: 'stub', providerConfig: { cwd } }, [SKILL_ENTRY]), /\.\./);
});

test('materialize: mid-execution throw rolls earlier writes back byte-identical (§3.7.3)', async () => {
  const dataDir = botDir('d-roll');
  const cwd = botDir('b-roll-cwd');
  // pre-existing content that must survive untouched + a POISON file whose
  // surgery MUST throw (foreign marker inside → splice refuses)
  writeFileSync(join(cwd, 'NOTES.md'), '用户手写笔记\n');
  writeFileSync(join(cwd, 'POISON.md'), '<!-- wao:assets:begin:v1:bot=OTHER -->\n外来\n');
  const before = readFileSync(join(cwd, 'NOTES.md'), 'utf8');
  const mat = mkMat(stubPort('p1', { throwAt: 'section' }), dataDir);
  const bot = { id: 'r1', provider: 'stub', providerConfig: { cwd } };
  await assert.rejects(mat.materialize(bot, [SKILL_ENTRY, MEM_ENTRY]), /他 bot 命名空间/);
  assert.equal(readFileSync(join(cwd, 'NOTES.md'), 'utf8'), before, 'user file restored byte-identical');
  assert.ok(!existsSync(join(cwd, 'skills', 'wao-company', 'SKILL.md')), 'earlier file-create rolled back');
  // manifest keeps last-good with the failed reason (§3.8 不清旧清单)
  const manifest = JSON.parse(readFileSync(join(dataDir, 'assets', 'r1', 'manifest.json'), 'utf8'));
  assert.match(manifest.lastResult, /^failed:/);
  assert.deepEqual(manifest.writes, []);
});

test('materialize: stale cleanup — removed plan entries delete their files; empty plan cleans everything; foreign-rewritten skill warns and stays', async () => {
  const dataDir = botDir('d-stale');
  const cwd = botDir('b-stale-cwd');
  const mat = mkMat(stubPort('p1'), dataDir);
  const bot = { id: 's1', provider: 'stub', providerConfig: { cwd } };
  await mat.materialize(bot, [SKILL_ENTRY, MEM_ENTRY, MCP_ENTRY]);
  // drop the skill → its file goes; memory/mcp stay
  const r = await mat.materialize(bot, [MEM_ENTRY, MCP_ENTRY]);
  assert.ok(!existsSync(join(cwd, 'skills', 'wao-company', 'SKILL.md')));
  assert.ok(existsSync(join(cwd, 'NOTES.md')));
  // user rewrote the (now stale) NOTES target? it is a marker-section → stripped normally.
  // foreign-rewritten SKILL guard: re-materialize skill, hand-strip annotation, then unbind
  await mat.materialize(bot, [SKILL_ENTRY, MEM_ENTRY]);
  const skillFile = join(cwd, 'skills', 'wao-company', 'SKILL.md');
  writeFileSync(skillFile, '---\nname: wao-company\n---\n用户重写\n');
  const r2 = await mat.materialize(bot, [MEM_ENTRY]);
  assert.ok(existsSync(skillFile), 'foreign-rewritten skill is NOT deleted');
  assert.ok(r2.notes.some((n) => /跳过删除/.test(n.detail)), 'warn-not-delete note present');
  // empty plan → full cleanup
  await mat.materialize(bot, []);
  assert.ok(!existsSync(join(cwd, 'NOTES.md')), 'empty plan cleans the section file (WAO-owned + user text gone with the section? no — strip keeps user text, file only goes when empty)');
  // ^ NOTES.md carried user text ('用户手写笔记' not written in THIS test) — file kept if non-user content remains
  assert.ok(!existsSync(join(dataDir, 'assets', 's1', 'mcp.json')));
});

// —— removeAssets / verify / detection hooks ————————————————————————————

test('removeAssets: manifest-driven cleanup, marker strip keeps foreign text, hook entries precise-deleted, no manifest → removed:false', async () => {
  const dataDir = botDir('d-rm');
  const cwd = botDir('b-rm-cwd');
  const settingsFile = join(cwd, 'settings.json');
  writeFileSync(settingsFile, '{"model":"x","hooks":{"PreToolUse":[{"matcher":"User","hooks":[]}]}}');
  const hookEntry = { file: settingsFile, entry: { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk run' }] } };
  const mat = mkMat(stubPort('p1', { hookEntry }), dataDir);
  const bot = { id: 'm1', provider: 'stub', providerConfig: { cwd } };
  writeFileSync(join(cwd, 'CLAUDE.md'), '用户全局段\n');
  await mat.materialize(bot, [SKILL_ENTRY, MEM_ENTRY]);
  const r = await mat.removeAssets(bot);
  assert.equal(r.removed, true);
  assert.ok(!existsSync(join(cwd, 'skills', 'wao-company', 'SKILL.md')));
  // §3.6: the section file held ONLY WAO content (manifest-owned) → deleted;
  // a file that also carries user text keeps the user text.
  assert.ok(!existsSync(join(cwd, 'NOTES.md')), 'WAO-created section file deleted once stripped empty');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse.map((h) => h.matcher), ['User'], 'our hook entry precisely deleted, the user entry untouched');
  assert.ok(!existsSync(join(dataDir, 'assets', 'm1')), 'manifest dir removed');
  assert.deepEqual(await mat.removeAssets(bot), { removed: false, skipped: 'no-manifest' });
});

test('verify: hand-edited product → drift; removed plan row still on disk → orphan (§3.5 dryRun)', async () => {
  const dataDir = botDir('d-verify');
  const cwd = botDir('b-verify-cwd');
  const mat = mkMat(stubPort('p1'), dataDir);
  const bot = { id: 'v1', provider: 'stub', providerConfig: { cwd } };
  await mat.materialize(bot, [SKILL_ENTRY]);
  let v = await mat.verify(bot, [SKILL_ENTRY]);
  assert.deepEqual(v.drift, []);
  writeFileSync(join(cwd, 'skills', 'wao-company', 'SKILL.md'), 'tampered\n');
  v = await mat.verify(bot, [SKILL_ENTRY]);
  assert.equal(v.drift.length, 1);
  assert.match(v.drift[0].path, /SKILL\.md/);
  // stale manifest row: plan no longer covers a file that still exists
  writeFileSync(join(cwd, 'skills', 'wao-company', 'SKILL.md'), '---\nname: wao-company\nx-wao-asset: ast-s1\n---\ntampered\n');
  v = await mat.verify(bot, []);
  assert.ok(v.orphans.some((o) => /SKILL\.md/.test(o.path)), 'unplanned file flagged as orphan');
});

test('checkBind/detect*: provider without materializeAssets refuses; foreign skill target named; cross-bot manifest conflict named', async () => {
  const dataDir = botDir('d-hooks');
  const cwd = botDir('b-hooks-cwd');
  const mat = mkMat(stubPort('p1'), dataDir);
  const bare = createMaterializer({ ports: portsOf({}), dataDir, log: { info() {}, warn() {} } });
  assert.deepEqual(bare.checkBind({ id: 'x', provider: 'stub', providerConfig: { cwd } }, SKILL_ENTRY), ['该 provider 暂不支持资产装备']);
  assert.deepEqual(mat.checkBind({ id: 'x', provider: 'stub', providerConfig: { cwd } }, SKILL_ENTRY), []);
  // dsh-specific rows survive from the noop contract
  assert.ok(mat.checkBind({ id: 'x', provider: 'dsh', providerConfig: { cwd } }, MCP_ENTRY).some((e) => /dsh 岗位不支持 MCP/));
  assert.ok(mat.checkBind({ id: 'x', provider: 'claude', providerConfig: { cwd } }, { type: 'tool', name: 't', content: { kind: 'rtk' } }).some((e) => /专属目录/));
  // foreign skill: a same-path SKILL.md without x-wao-asset
  const otherCwd = botDir('b-hooks-other');
  mkdirSync(join(otherCwd, 'skills', 'wao-company'), { recursive: true });
  writeFileSync(join(otherCwd, 'skills', 'wao-company', 'SKILL.md'), '---\nname: wao-company\ndescription: 用户自有\n---\n');
  const foreign = await mat.detectForeignTargets({ id: 'x', provider: 'stub', providerConfig: { cwd: otherCwd } }, [SKILL_ENTRY]);
  assert.deepEqual(foreign, [{ path: join(otherCwd, 'skills', 'wao-company', 'SKILL.md') }]);
  // cross-bot conflict via manifest
  const botA = { id: 'botA', provider: 'stub', providerConfig: { cwd } };
  await mat.materialize(botA, [SKILL_ENTRY]);
  const conflicts = await mat.detectFileConflicts({ id: 'botB', provider: 'stub', providerConfig: { cwd } }, [SKILL_ENTRY], [botA]);
  assert.deepEqual(conflicts, [{ botId: 'botA', path: join(cwd, 'skills', 'wao-company', 'SKILL.md') }]);
});

test('targetsFor: enriches plan copies with manifest targets, never mutates entries', async () => {
  const dataDir = botDir('d-tgt');
  const cwd = botDir('b-tgt-cwd');
  const mat = mkMat(stubPort('p1'), dataDir);
  const bot = { id: 't1', provider: 'stub', providerConfig: { cwd } };
  await mat.materialize(bot, [SKILL_ENTRY, MCP_ENTRY]);
  const enriched = mat.targetsFor(bot, [SKILL_ENTRY, MCP_ENTRY]);
  assert.equal(enriched[0].target, join(cwd, 'skills', 'wao-company', 'SKILL.md'));
  assert.equal(enriched[1].target, join(dataDir, 'assets', 't1', 'mcp.json'));
  assert.equal(SKILL_ENTRY.target, undefined, 'source plan entry untouched');
  assert.notEqual(enriched[0], SKILL_ENTRY, 'entries are copies');
});

test('startupSweep: pre-T2 bindings without manifest migrate once; existing manifest drift reported without rewrite', async () => {
  const dataDir = botDir('d-sweep');
  const cwd = botDir('b-sweep-cwd');
  const mat = mkMat(stubPort('p1'), dataDir);
  const bot = { id: 'w1', provider: 'stub', providerConfig: { cwd } };
  // migration: bindings, no manifest → materialized, logged in out.migrated
  const out = await mat.startupSweep([bot], () => [SKILL_ENTRY]);
  assert.deepEqual(out.migrated, ['w1']);
  assert.ok(existsSync(join(cwd, 'skills', 'wao-company', 'SKILL.md')));
  // drift: manifest exists, disk tampered → reported, NOT rewritten
  writeFileSync(join(cwd, 'skills', 'wao-company', 'SKILL.md'), 'tampered\n');
  const out2 = await mat.startupSweep([bot], () => [SKILL_ENTRY]);
  assert.deepEqual(out2.migrated, []);
  assert.equal(out2.drift.length, 1);
  assert.equal(out2.drift[0].botId, 'w1');
  assert.equal(readFileSync(join(cwd, 'skills', 'wao-company', 'SKILL.md'), 'utf8'), 'tampered\n', '启动不自动改写（盘面即真相的例外=迁移扫尾）');
});

// W3 T2 review Minor 5: a bot whose provider port is gone (plugin disabled at
// boot) has a manifest → sweep takes the VERIFY path → plan failure must WARN
// naming the bot, not fall through silently (drift+orphans both empty).
test('startupSweep: verify-path provider failure warns naming botId+reason — never silent, never throws', async () => {
  const dataDir = botDir('d-sweep-verr');
  const cwd = botDir('b-sweep-verr-cwd');
  const warns = [];
  const recLog = { info() {}, warn: (...a) => warns.push(a.join(' ')), error() {} };
  const mat = createMaterializer({ ports: portsOf(stubPort('p1')), dataDir, log: recLog });
  const bot = { id: 'sw2', provider: 'stub', providerConfig: { cwd } };
  await mat.materialize(bot, [SKILL_ENTRY]); // manifest exists → next boot verifies
  const matNoPort = createMaterializer({ ports: { getProvider: () => undefined }, dataDir, log: recLog });
  const out = await matNoPort.startupSweep([bot], () => [SKILL_ENTRY]);
  assert.deepEqual(out.migrated, []);
  assert.deepEqual(out.drift, []);
  assert.ok(
    warns.some((w) => w.includes('sw2') && w.includes('暂不支持资产装备')),
    `warn names botId + reason: ${JSON.stringify(warns)}`,
  );
});

// W3 T2 review Minor 1 (owned 真值): owned records "file ABSENT at write time"
// (or already ours per the last-good manifest) — a host file that pre-dates our
// first write is owned:false and unloads by strip, never whole-file delete.
test('owned truth: pre-existing host file → owned:false, survives strip-to-empty unload; our own product stays owned across runs', async () => {
  const dataDir = botDir('d-owned');
  const cwd = botDir('b-owned-cwd');
  writeFileSync(join(cwd, 'NOTES.md'), ''); // user-created (empty) host file
  const mat = mkMat(stubPort('p1'), dataDir);
  const bot = { id: 'ow1', provider: 'stub', providerConfig: { cwd } };
  const manifestOf = () => JSON.parse(readFileSync(join(dataDir, 'assets', 'ow1', 'manifest.json'), 'utf8'));
  const mcpFile = join(dataDir, 'assets', 'ow1', 'mcp.json');

  await mat.materialize(bot, [MEM_ENTRY, MCP_ENTRY]);
  let manifest = manifestOf();
  const ownedOf = (p) => manifest.writes.find((w) => w.path === p).owned;
  assert.equal(ownedOf(join(cwd, 'NOTES.md')), false, 'host file existed at write time → owned:false');
  assert.equal(ownedOf(mcpFile), true, 'absent at write time (our product) → owned:true');

  // re-materialize: our product now EXISTS, but the last-good manifest owns it
  await mat.materialize(bot, [MEM_ENTRY, MCP_ENTRY]);
  manifest = manifestOf();
  assert.equal(manifest.writes.find((w) => w.path === mcpFile).owned, true, 'own product stays owned across runs');

  // unload: the host file's OUR section is stripped, the file itself SURVIVES
  await mat.materialize(bot, []);
  assert.ok(existsSync(join(cwd, 'NOTES.md')), 'user-created host file survives the strip-to-empty unload');
  assert.equal(readFileSync(join(cwd, 'NOTES.md'), 'utf8'), '', 'back to the user\'s original bytes');
  assert.ok(!existsSync(mcpFile), 'our own product still goes away');
  assert.ok(!readFileSync(join(cwd, 'NOTES.md'), 'utf8').includes('wao:assets'), 'our markers are gone from the spared file');

  // removeAssets guard: an owned:false FILE row (a host file a provider
  // overwrote) is never whole-deleted — a named warning instead.
  const cwdH = botDir('b-owned-host-cwd');
  const hostFile = join(cwdH, 'host.json');
  writeFileSync(hostFile, '{"host":true}');
  const hostMat = mkMat({
    async materializeAssets() {
      return { writes: [{ kind: 'file-create', target: hostFile, content: '{"ours":1}' }], notes: [], entries: [] };
    },
  }, dataDir);
  const hostBot = { id: 'ow2', provider: 'stub', providerConfig: { cwd: cwdH } };
  await hostMat.materialize(hostBot, [MCP_ENTRY]);
  const hm = JSON.parse(readFileSync(join(dataDir, 'assets', 'ow2', 'manifest.json'), 'utf8'));
  assert.equal(hm.writes.find((w) => w.path === hostFile).owned, false, 'pre-existing target → owned:false');
  const rr = await hostMat.removeAssets(hostBot);
  assert.ok(existsSync(hostFile), 'host target spared by removeAssets');
  assert.ok(rr.warnings.some((w) => /未整删/.test(w) && w.includes(hostFile)), `warning names the spared file: ${JSON.stringify(rr.warnings)}`);
});
