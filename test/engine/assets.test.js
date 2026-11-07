// W3 T1 unit tests: plugins/core-engine/assets.js — the asset registry
// (DESIGN-ASSETS rev.2 §2/§4) in isolation. Covers: load/save round-trip,
// the §4 five-type schema validation (every red line: slug rule, control
// characters, proto-pollution keys, size limits, mcp stdio/http single-form,
// sse/ws refusal copy, URL embedded credentials, env key shape, server
// count/arg limits), (type,name) uniqueness, position-based masking of mcp
// env/headers values with __MASKED__ round-trip restore, plan building
// (binding order, exclusive snapshots, suppression, deleted-source
// exclusive), the noop materializer contract (T2 swaps in the real pipeline),
// and the bind/unbind validation chain with a synthetic state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_TYPES, MASKED_ECHO, loadAssets, saveAssets, newAssetId,
  validateAsset, maskAsset, restoreMaskedContent,
  resolveBinding, buildPlan, bindingSummary,
  bindAsset, unbindAsset, noopMaterializer,
} from '../../plugins/core-engine/assets.js';

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'wao-assets-unit-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

// —— loadAssets / saveAssets (§2.1 registry discipline) ——————————————————

test('loadAssets: missing / corrupt file → empty registry; valid file round-trips', () => {
  assert.deepEqual(loadAssets(join(tmp, 'missing-assets.json')), { assets: [] });
  const corrupt = join(tmp, 'corrupt-assets.json');
  writeFileSync(corrupt, '{not json');
  assert.deepEqual(loadAssets(corrupt), { assets: [] });
  const file = join(tmp, 'assets.json');
  const doc = { assets: [{ id: 'ast-x1', type: 'prompt', name: 'style', content: { text: 'hi' }, version: 1, origin: 'operator', createdAt: 1, updatedAt: 1 }] };
  saveAssets(file, doc);
  assert.deepEqual(loadAssets(file), doc);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).assets[0].name, 'style');
  // 0600 pin (§8.4): atomicWrite carries owner-only mode onto the registry
  assert.equal(statSync(file).mode & 0o777, 0o600, 'assets.json persists 0600 (owner-only, same discipline as bots.json)');
});

test('newAssetId: ast- prefix, and never collides with the given existing ids', () => {
  const id = newAssetId();
  assert.match(id, /^ast-[a-z0-9]+$/);
  const taken = new Set([id]);
  for (let i = 0; i < 50; i++) taken.add(newAssetId([...taken]));
  assert.equal(taken.size, 51);
});

// —— validateAsset: common red lines (§4.0) ————————————————————————————

test('ASSET_TYPES is exactly the five types', () => {
  assert.deepEqual([...ASSET_TYPES], ['skill', 'memory', 'mcp', 'prompt', 'tool']);
});

test('validateAsset: rejects non-object, bad type, and every slug violation (dot banned)', () => {
  assert.ok(validateAsset(null).length > 0);
  const base = (over) => ({ type: 'prompt', name: 'style', content: { text: 'x' }, ...over });
  assert.ok(validateAsset(base({ type: 'wall' })).some((e) => /type/.test(e)));
  for (const bad of ['Wao', 'wao.company', '-wao', '_wao', 'wao company', 'wao/company', 'wao/../x', 'a'.repeat(65), '', 42, null]) {
    const errors = validateAsset(base({ name: bad }));
    assert.ok(errors.some((e) => /name/.test(e)), `name ${JSON.stringify(bad)} must be rejected: ${errors.join(';')}`);
  }
  // the design slug allows exactly 64 chars total (1 + {0,63})
  assert.deepEqual(validateAsset(base({ name: 'a'.repeat(64) })), []);
});

test('validateAsset: description ≤200 and control-character red lines (C0/C1 except \\n \\r \\t)', () => {
  const mk = (description) => ({ type: 'prompt', name: 'style', description, content: { text: 'x' } });
  assert.deepEqual(validateAsset(mk('x'.repeat(200))), []);
  assert.ok(validateAsset(mk('x'.repeat(201))).some((e) => /description/));
  assert.ok(validateAsset(mk(42)).some((e) => /description/));
  const ctrl = [String.fromCharCode(0), String.fromCharCode(1), String.fromCharCode(11),
    String.fromCharCode(12), String.fromCharCode(0x85), String.fromCharCode(0x9f), String.fromCharCode(0x1f)];
  for (const bad of ctrl.map((c) => `a${c}b`)) {
    assert.ok(validateAsset(mk(bad)).some((e) => /控制字符|control/i), JSON.stringify(bad));
  }
  assert.deepEqual(validateAsset(mk('a\nb\tc\rd')), []);
});

test('validateAsset: control characters rejected inside content bodies of every type', () => {
  const cases = [
    { type: 'skill', name: 's1', content: { name: 's1', body: 'a\u0000b' } },
    { type: 'memory', name: 'm1', content: { notes: ['a\u0001b'] } },
    { type: 'prompt', name: 'p1', content: { text: 'a\u0000b' } },
    { type: 'mcp', name: 'c1', content: { servers: { a: { command: 'x\u0000y' } } } },
  ];
  for (const asset of cases) {
    assert.ok(validateAsset(asset).length > 0, JSON.stringify(asset.type));
  }
});

// W3 T2 review: a wao marker-line pattern inside asset text would land
// verbatim in a materialized product and self-manufacture marker drift (§3.4
// refuses a duplicated own-marker pair) — refused at the registry door, 400
// copy naming the field.
test('validateAsset: wao marker-line pattern refused in every text surface, field named; harmless mentions pass', () => {
  const markerShapes = [
    '# wao:assets:begin:v1:bot=cl-b1',
    '# wao:assets:end:v1:bot=x',
    '<!-- wao:assets:begin:v1:bot=cl-b1 -->',
    '# wao:assets:begin:v2:bot=x', // forward version refused by the same rule
  ];
  const cases = [
    ['description', (v) => ({ type: 'prompt', name: 'p1', description: v, content: { text: 'x' } })],
    ['content.body', (v) => ({ type: 'skill', name: 's1', content: { name: 's1', body: v } })],
    ['content.description', (v) => ({ type: 'skill', name: 's1', content: { name: 's1', description: v, body: 'b' } })],
    ['content.notes[0]', (v) => ({ type: 'memory', name: 'm1', content: { notes: [v] } })],
    ['content.text', (v) => ({ type: 'prompt', name: 'p1', content: { text: v } })],
    ['content.options.extraHints', (v) => ({ type: 'tool', name: 't1', content: { kind: 'ripgrep', options: { extraHints: v } } })],
  ];
  for (const [field, mk] of cases) {
    for (const bad of markerShapes) {
      const errors = validateAsset(mk(`说明\n${bad}\n结尾`));
      assert.ok(errors.some((e) => e.includes(field) && /标记行/.test(e)), `${field} refuses ${bad}: ${errors.join(';')}`);
    }
    // harmless mentions of the namespace without a version segment pass
    assert.deepEqual(validateAsset(mk('讲一下 wao:assets 机制即可')), [], `${field} allows non-marker mentions`);
  }
});

test('validateAsset: prototype-pollution keys rejected at any depth of content', () => {
  const evil = JSON.parse('{"text":"x","__proto__":{"polluted":1}}');
  const errors = validateAsset({ type: 'prompt', name: 'p1', content: evil });
  assert.ok(errors.some((e) => /__proto__|原型|prototype/i.test(e)), errors.join(';'));
  const evil2 = JSON.parse('{"servers":{"a":{"command":"x","env":{"OK":"1"},"constructor":"y"}}}');
  assert.ok(validateAsset({ type: 'mcp', name: 'c1', content: evil2 }).length > 0);
  assert.ok(({}).polluted === undefined, 'no actual pollution happened');
});

test('validateAsset: content total size capped at 64KB', () => {
  // 50 notes × 2KB each passes per-note limits but blows the 64KB content cap.
  const notes = Array.from({ length: 50 }, () => 'x'.repeat(2048));
  const errors = validateAsset({ type: 'memory', name: 'big', content: { notes } });
  assert.ok(errors.some((e) => /64KB/), errors.join(';'));
});

test('validateAsset: (type,name) uniqueness — same type+name rejected, other types fine', () => {
  const others = [{ type: 'prompt', name: 'style' }];
  assert.ok(validateAsset({ type: 'prompt', name: 'style', content: { text: 'x' } }, { others })
    .some((e) => /同名/));
  assert.deepEqual(validateAsset({ type: 'skill', name: 'style', content: { name: 'style', body: 'x' } }, { others }), []);
  assert.deepEqual(validateAsset({ type: 'prompt', name: 'other', content: { text: 'x' } }, { others }), []);
});

// —— validateAsset: per-type schemas (§4.1–§4.5) ————————————————————————

test('skill schema: name slug + description ≤1536 + body ≤60KB, all required shapes', () => {
  const good = { type: 'skill', name: 'wao-company', content: { name: 'wao-company', description: '何时触发', body: '# 指令' } };
  assert.deepEqual(validateAsset(good), []);
  assert.ok(validateAsset({ ...good, content: { name: 'wao-company' } }).some((e) => /body/));
  assert.ok(validateAsset({ ...good, content: { name: 'wao-company', body: 42 } }).some((e) => /body/));
  assert.ok(validateAsset({ ...good, content: { name: 'Bad.Name', body: 'x' } }).some((e) => /name/));
  assert.ok(validateAsset({ ...good, content: { description: 'x'.repeat(1537), name: 'wao-company', body: 'x' } }).some((e) => /1536/));
  const bodyOk = { ...good, content: { name: 'wao-company', body: 'x'.repeat(60 * 1024) } };
  assert.deepEqual(validateAsset(bodyOk), []);
  assert.ok(validateAsset({ ...good, content: { name: 'wao-company', body: 'x'.repeat(60 * 1024 + 1) } }).some((e) => /60KB/));
});

test('mcp schema: stdio and http single-form, url-without-type, sse/ws, embedded credentials', () => {
  const mk = (servers) => ({ type: 'mcp', name: 'company-mcp', content: { servers } });
  assert.deepEqual(validateAsset(mk({ company: { command: 'node', args: ['server.js'], env: { TOKEN: 'sk-x', A_1: 'v' } } })), []);
  assert.deepEqual(validateAsset(mk({ docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-K': 'v' } } })), []);
  // F13 red line: url without type is a config error → reject
  assert.ok(validateAsset(mk({ docs: { url: 'https://example.com/mcp' } })).some((e) => /type/));
  // sse/ws refused with the fixed v1 copy
  for (const type of ['sse', 'ws']) {
    const errors = validateAsset(mk({ docs: { type, url: 'https://example.com/mcp' } }));
    assert.ok(errors.some((e) => /v1 仅支持 stdio\/http 形态 MCP server/), `${type}: ${errors.join(';')}`);
  }
  // embedded credentials in URL refused with the fixed copy
  const cred = validateAsset(mk({ docs: { type: 'http', url: 'https://user:pass@example.com/mcp' } }));
  assert.ok(cred.some((e) => /URL 内嵌凭据不允许：凭据走 env\/headers/), cred.join(';'));
  // non-http(s) scheme refused
  assert.ok(validateAsset(mk({ docs: { type: 'http', url: 'ftp://example.com/mcp' } })).length > 0);
  // mixed / missing forms
  assert.ok(validateAsset(mk({ m: { command: 'node', url: 'https://x.example/' } })).some((e) => /stdio 或 http/));
  assert.ok(validateAsset(mk({ m: {} })).some((e) => /stdio 或 http/));
  // stdio shape details
  assert.ok(validateAsset(mk({ m: { command: '' } })).some((e) => /command/));
  assert.ok(validateAsset(mk({ m: { command: 'node', args: 'x' } })).some((e) => /args/));
  assert.ok(validateAsset(mk({ m: { command: 'node', args: Array.from({ length: 33 }, () => 'x') } })).some((e) => /args/));
  assert.ok(validateAsset(mk({ m: { command: 'node', args: ['x'.repeat(513)] } })).some((e) => /args/));
  assert.ok(validateAsset(mk({ m: { command: 'node', env: { 'lower-case': 'v' } } })).some((e) => /env/));
  assert.ok(validateAsset(mk({ m: { command: 'node', env: { TOKEN: '' } } })).some((e) => /env/));
  // serverId slug + count cap (≤16)
  assert.ok(validateAsset(mk({ 'Bad.Id': { command: 'node' } })).some((e) => /Bad.Id/));
  const many = {};
  for (let i = 0; i < 17; i++) many[`s${i}`] = { command: 'node' };
  assert.ok(validateAsset(mk(many)).some((e) => /16/));
  const sixteen = {};
  for (let i = 0; i < 16; i++) sixteen[`s${i}`] = { command: 'node' };
  assert.deepEqual(validateAsset(mk(sixteen)), []);
});

test('memory schema: notes array ≤50, each ≤2KB, empty array allowed', () => {
  assert.deepEqual(validateAsset({ type: 'memory', name: 'mem', content: { notes: [] } }), []);
  assert.deepEqual(validateAsset({ type: 'memory', name: 'mem', content: { notes: ['a', 'b'] } }), []);
  assert.ok(validateAsset({ type: 'memory', name: 'mem', content: { notes: 'a' } }).some((e) => /notes/));
  assert.ok(validateAsset({ type: 'memory', name: 'mem', content: { notes: [42] } }).some((e) => /notes/));
  assert.ok(validateAsset({ type: 'memory', name: 'mem', content: { notes: Array.from({ length: 51 }, () => 'x') } }).some((e) => /notes/));
  assert.deepEqual(validateAsset({ type: 'memory', name: 'mem', content: { notes: ['x'.repeat(2048)] } }), []);
  assert.ok(validateAsset({ type: 'memory', name: 'mem', content: { notes: ['x'.repeat(2049)] } }).some((e) => /2KB/));
});

test('prompt schema: text required, ≤8KB', () => {
  assert.deepEqual(validateAsset({ type: 'prompt', name: 'style', content: { text: 'x'.repeat(8 * 1024) } }), []);
  assert.ok(validateAsset({ type: 'prompt', name: 'style', content: {} }).some((e) => /text/));
  assert.ok(validateAsset({ type: 'prompt', name: 'style', content: { text: 'x'.repeat(8 * 1024 + 1) } }).some((e) => /8KB/));
});

test('tool schema: kind whitelist rtk|ripgrep; rtk options empty; ripgrep extraHints ≤1KB', () => {
  assert.deepEqual(validateAsset({ type: 'tool', name: 'rtk-1', content: { kind: 'rtk' } }), []);
  assert.deepEqual(validateAsset({ type: 'tool', name: 'rtk-2', content: { kind: 'rtk', options: {} } }), []);
  assert.deepEqual(validateAsset({ type: 'tool', name: 'rg', content: { kind: 'ripgrep', options: { extraHints: 'x' } } }), []);
  assert.ok(validateAsset({ type: 'tool', name: 'x', content: { kind: 'grep' } }).some((e) => /kind/));
  assert.ok(validateAsset({ type: 'tool', name: 'x', content: {} }).some((e) => /kind/));
  assert.ok(validateAsset({ type: 'tool', name: 'x', content: { kind: 'rtk', options: { edition: 'e' } } }).some((e) => /options/));
  assert.ok(validateAsset({ type: 'tool', name: 'x', content: { kind: 'ripgrep', options: { extraHints: 'x'.repeat(1025) } } }).some((e) => /extraHints/));
});

test('closed content schema: unknown keys rejected for all five types, mcp servers close per form (W3 T1 review)', () => {
  // content-level closure — one stray key per type must fail, not vanish
  const cases = [
    { type: 'skill', name: 's', content: { name: 's', body: 'x', scripts: [] } },
    { type: 'memory', name: 'm', content: { notes: [], pinned: true } },
    { type: 'mcp', name: 'c', content: { servers: { a: { command: 'node' } }, 'x-wao': 1 } },
    { type: 'prompt', name: 'p', content: { text: 'x', lang: 'zh' } },
    { type: 'tool', name: 't', content: { kind: 'rtk', options: {}, edition: 'e' } },
  ];
  for (const asset of cases) {
    const errors = validateAsset(asset);
    assert.ok(errors.some((e) => /unexpected key/.test(e)), `${asset.type}: ${errors.join(';')}`);
  }
  // the closed shapes themselves stay clean
  assert.deepEqual(validateAsset({ type: 'prompt', name: 'p', content: { text: 'x' } }), []);
  // mcp server-level closure per form
  const stdio = validateAsset({ type: 'mcp', name: 'c1', content: { servers: { a: { command: 'node', cwd: '/x' } } } });
  assert.ok(stdio.some((e) => /servers\.a\.cwd：unexpected key（stdio 形态仅接受 command\/args\/env）/.test(e)), stdio.join(';'));
  const http = validateAsset({ type: 'mcp', name: 'c2', content: { servers: { b: { type: 'http', url: 'https://x.example/', env: { A: '1' } } } } });
  assert.ok(http.some((e) => /servers\.b\.env：unexpected key（http 形态仅接受 type\/url\/headers）/.test(e)), http.join(';'));
  // stdio+type keeps its dedicated copy (not doubled by the generic one)
  const stdioType = validateAsset({ type: 'mcp', name: 'c3', content: { servers: { a: { command: 'node', type: 'http' } } } });
  assert.ok(stdioType.some((e) => /stdio 形态不接受 type 字段/.test(e)), stdioType.join(';'));
  assert.equal(stdioType.filter((e) => /unexpected key/.test(e)).length, 0, 'type is not double-reported');
  // ripgrep options closure (rtk is covered by the empty-options rule above)
  const rg = validateAsset({ type: 'tool', name: 't2', content: { kind: 'ripgrep', options: { extraHints: 'x', flags: '-i' } } });
  assert.ok(rg.some((e) => /options\.flags：unexpected key（ripgrep 仅接受 extraHints）/.test(e)), rg.join(';'));
});

// —— position masking (§8.1 P1: env/headers values masked regardless of key) —

test('maskAsset: mcp env/headers values ALL masked by position; command/args/url intact; no mutation', () => {
  const asset = {
    id: 'ast-1', type: 'mcp', name: 'company-mcp', version: 2, origin: 'operator', createdAt: 1, updatedAt: 2,
    description: '公司 MCP',
    content: {
      servers: {
        company: { command: 'node', args: ['server.js'], env: { TOKEN: 'sk-secret', NOTE: 'plain-note' } },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-K': 'v', Accept: 'json' } },
      },
    },
  };
  const masked = maskAsset(asset);
  assert.equal(masked.content.servers.company.env.TOKEN, MASKED_ECHO);
  assert.equal(masked.content.servers.company.env.NOTE, MASKED_ECHO, 'non-sensitive-looking env names mask too (position rule)');
  assert.equal(masked.content.servers.docs.headers['X-K'], MASKED_ECHO);
  assert.equal(masked.content.servers.docs.headers.Accept, MASKED_ECHO);
  assert.equal(masked.content.servers.company.command, 'node');
  assert.deepEqual(masked.content.servers.company.args, ['server.js']);
  assert.equal(masked.content.servers.docs.url, 'https://example.com/mcp');
  assert.equal(masked.version, 2);
  // original untouched
  assert.equal(asset.content.servers.company.env.TOKEN, 'sk-secret');
});

test('maskAsset: non-mcp assets echo content verbatim', () => {
  const skill = { id: 'ast-2', type: 'skill', name: 'wao-company', version: 1, origin: 'operator', content: { name: 'wao-company', body: '# 正文' } };
  assert.deepEqual(maskAsset(skill).content, skill.content);
});

test('restoreMaskedContent: __MASKED__ restores the stored value at the same position; new values replace; absent servers are removed', () => {
  const old = {
    servers: {
      a: { command: 'node', env: { TOKEN: 'real', KEEP: 'also' } },
      b: { type: 'http', url: 'https://b.example/', headers: { 'X-K': 'real' } },
    },
  };
  const patch = {
    servers: {
      a: { command: 'node', env: { TOKEN: MASKED_ECHO, KEEP: 'changed', NEW: 'added' } },
      b: { type: 'http', url: 'https://b.example/', headers: { 'X-K': MASKED_ECHO } },
    },
  };
  const restored = restoreMaskedContent(patch, old, 'mcp');
  assert.equal(restored.servers.a.env.TOKEN, 'real', 'sentinel round-trips back to the stored value');
  assert.equal(restored.servers.a.env.KEEP, 'changed');
  assert.equal(restored.servers.a.env.NEW, 'added');
  assert.equal(restored.servers.b.headers['X-K'], 'real');
  const removed = restoreMaskedContent({ servers: { a: old.servers.a } }, old, 'mcp');
  assert.equal(removed.servers.b, undefined, 'an omitted server is a deliberate removal');
  // non-mcp types: nothing to restore (nothing is masked there)
  assert.deepEqual(restoreMaskedContent({ text: MASKED_ECHO }, { text: 'x' }, 'prompt'), { text: MASKED_ECHO });
  // keys the RESPONSE pipeline strips by name (secret/*apikey*) never echo —
  // their absence in a round-trip is "never saw", not "delete": backfilled.
  const stripped = restoreMaskedContent(
    { servers: { a: { command: 'node', env: { TOKEN: MASKED_ECHO } } } },
    { servers: { a: { command: 'node', env: { TOKEN: 't', MY_APIKEY: 'k' } }, 'apikey-svc': { command: 'x' } } },
    'mcp',
  );
  assert.equal(stripped.servers.a.env.MY_APIKEY, 'k', 'strip-shaped key backfilled, never silently erased');
  assert.deepEqual(stripped.servers['apikey-svc'], { command: 'x' }, 'strip-shaped serverId backfilled too');
});

// —— plan building (§2.2/§2.3/§6) ————————————————————————————————————————

const ASSETS = [
  { id: 'ast-s1', type: 'skill', name: 'wao-company', version: 3, origin: 'operator', content: { name: 'wao-company', body: 'v3' } },
  { id: 'ast-p1', type: 'prompt', name: 'style', version: 1, origin: 'operator', content: { text: 'T1' } },
  { id: 'ast-m1', type: 'memory', name: 'mem', version: 1, origin: 'operator', content: { notes: ['n1'] } },
  { id: 'ast-s2', type: 'skill', name: 'other-skill', version: 1, origin: 'operator', content: { name: 'other-skill', body: 'x' } },
];

test('resolveBinding + buildPlan: binding order, exclusive snapshot wins over live content', () => {
  const bot = {
    id: 'b1', assets: [
      { assetId: 'ast-p1', mode: 'shared' },
      { assetId: 'ast-s1', mode: 'exclusive', snapshot: { name: 'wao-company', body: 'FROZEN' }, snapshotVersion: 1, snapshotAt: 111, snapshotType: 'skill', snapshotName: 'wao-company' },
    ],
  };
  const { plan, suppressed } = buildPlan(ASSETS, bot);
  assert.deepEqual(plan.map((e) => e.assetId), ['ast-p1', 'ast-s1']);
  assert.equal(plan[0].content.text, 'T1');
  assert.equal(plan[1].content.body, 'FROZEN', 'exclusive binds the binding-time snapshot, not the live v3');
  assert.equal(plan[1].mode, 'exclusive');
  assert.deepEqual(suppressed, []);
  const r = resolveBinding(ASSETS, bot.assets[1]);
  assert.equal(r.content.body, 'FROZEN');
  assert.equal(r.name, 'wao-company');
});

test('buildPlan: shared entry shadowed by an exclusive of the same (type,name) is suppressed', () => {
  const assets = [...ASSETS, { id: 'ast-p2', type: 'prompt', name: 'style-2', version: 1, origin: 'operator', content: { text: 'T2' } }];
  // different (type,name) groups coexist fine
  const bot = {
    id: 'b1', assets: [
      { assetId: 'ast-s1', mode: 'shared' },
      { assetId: 'ast-p1', mode: 'shared' },
      { assetId: 'ast-p2', mode: 'exclusive', snapshot: { text: 'P' }, snapshotVersion: 1, snapshotAt: 1, snapshotType: 'prompt', snapshotName: 'style-2' },
    ],
  };
  assert.deepEqual(buildPlan(assets, bot).plan.map((e) => e.assetId), ['ast-s1', 'ast-p1', 'ast-p2']);
  assert.deepEqual(buildPlan(assets, bot).suppressed, []);
  // same (type,name): the exclusive snapshot shadows the shared entry (§2.3 row 2)
  const shadow = {
    id: 'b2', assets: [
      { assetId: 'ast-p1', mode: 'shared' },
      { assetId: 'ast-p2', mode: 'exclusive', snapshot: { text: 'P' }, snapshotVersion: 1, snapshotAt: 1, snapshotType: 'prompt', snapshotName: 'style' },
    ],
  };
  const r = buildPlan(assets, shadow);
  assert.deepEqual(r.plan.map((e) => e.assetId), ['ast-p2'], 'shadowed shared entry leaves the effective plan');
  assert.deepEqual(r.suppressed.map((s) => s.assetId), ['ast-p1']);
});

test('buildPlan: exclusive binding survives its source asset being deleted (snapshot carries type/name)', () => {
  const bot = {
    id: 'b1', assets: [
      { assetId: 'ast-gone', mode: 'exclusive', snapshot: { text: 'FROZEN' }, snapshotVersion: 2, snapshotAt: 1, snapshotType: 'prompt', snapshotName: 'style' },
      { assetId: 'ast-gone2', mode: 'shared' }, // dangling shared → excluded
    ],
  };
  const { plan } = buildPlan([], bot);
  assert.deepEqual(plan, [{ assetId: 'ast-gone', type: 'prompt', name: 'style', mode: 'exclusive', content: { text: 'FROZEN' } }]);
});

test('bindingSummary: name/type/origin/exclusiveBehind/sourceDeleted, no content', () => {
  const bot = {
    id: 'b1', assets: [
      { assetId: 'ast-s1', mode: 'shared' },
      { assetId: 'ast-m1', mode: 'exclusive', snapshot: { notes: ['n'] }, snapshotVersion: 1, snapshotAt: 9, snapshotType: 'memory', snapshotName: 'mem' },
      { assetId: 'ast-gone', mode: 'exclusive', snapshot: { text: 'x' }, snapshotVersion: 1, snapshotAt: 9, snapshotType: 'prompt', snapshotName: 'old' },
    ],
  };
  const summary = bindingSummary(ASSETS, bot);
  assert.equal(summary.length, 3);
  assert.deepEqual(summary[0], { assetId: 'ast-s1', name: 'wao-company', type: 'skill', mode: 'shared', origin: 'operator' });
  assert.equal(summary[1].exclusiveBehind, 0, 'snapshotVersion 1 vs version 1 → not behind');
  const behind = bindingSummary([{ ...ASSETS[2], version: 4 }], bot);
  assert.equal(behind[0].exclusiveBehind, 3, 'snapshotVersion 1 vs version 4 → behind by 3');
  assert.equal(summary[2].sourceDeleted, true);
  assert.equal(summary[2].name, 'old');
  assert.ok(!('snapshot' in summary[2]), 'summary never carries content');
});

// —— noop materializer (T2 seam) —————————————————————————————————————————

test('noopMaterializer: materialize/removeAssets answer the skipped receipt; detection hooks are empty (T2 wires real ones)', async () => {
  const m = noopMaterializer();
  assert.deepEqual(await m.materialize({ id: 'b1' }, []), { writes: [], skipped: 'not-equipped' });
  assert.deepEqual(await m.removeAssets({ id: 'b1' }), { removed: false, skipped: 'not-equipped' });
  assert.deepEqual(m.detectFileConflicts({ id: 'b1' }, [], []), []);
  assert.deepEqual(m.detectForeignTargets({ id: 'b1' }, []), []);
});

test('noopMaterializer.checkBind: dsh×mcp, dsh×rtk, rtk without a dedicated dir are refused; memory shared-cwd warning', () => {
  const m = noopMaterializer();
  const dsh = { id: 'd1', provider: 'dsh', providerConfig: { cwd: '/tmp' } };
  const mcpAsset = { type: 'mcp', name: 'c', content: { servers: { a: { command: 'x' } } } };
  assert.ok(m.checkBind(dsh, mcpAsset).some((e) => /dsh 岗位不支持 MCP/), 'dsh has no MCP face (F23)');
  const rtkAsset = { type: 'tool', name: 'rtk', content: { kind: 'rtk' } };
  assert.ok(m.checkBind(dsh, rtkAsset).some((e) => /dsh 岗位不支持 rtk/), 'rtk does not support dsh (F27)');
  const claudeShared = { id: 'c1', provider: 'claude', providerConfig: { cwd: '/tmp' } };
  assert.ok(m.checkBind(claudeShared, rtkAsset).some((e) => /专属目录/), 'rtk hard line: never touch a shared home dir (§7.1)');
  const claudeDedicated = { id: 'c2', provider: 'claude', providerConfig: { cwd: '/tmp', claudeConfigDir: '/tmp/c2-claude' } };
  assert.deepEqual(m.checkBind(claudeDedicated, rtkAsset), []);
  assert.deepEqual(m.checkBind(claudeShared, { type: 'skill', name: 's', content: {} }), []);
  // memory warning (§7.3)
  assert.match(m.memoryWarning({ provider: 'claude', providerConfig: { cwd: '/tmp' } }), /共享 cwd/);
  assert.equal(m.memoryWarning({ provider: 'claude', providerConfig: { cwd: '/tmp', claudeConfigDir: '/x' } }), null);
  assert.equal(m.memoryWarning({ provider: 'codex', providerConfig: { cwd: '/tmp', codexHome: '/x' } }), null);
  assert.equal(m.memoryWarning({ provider: 'dsh', providerConfig: { cwd: '/tmp' } }), null, 'dsh memory rides personaPrefix, not cwd files');
});

// —— bindAsset / unbindAsset (validation chain §2.3, receipts) ————————————

const mkState = ({ bots, assets }) => {
  const botsFile = join(tmp, `bots-${Math.random().toString(36).slice(2)}.json`);
  const assetsFile = join(tmp, `assets-${Math.random().toString(36).slice(2)}.json`);
  const assetsDoc = { assets };
  const state = {
    botsFile,
    assetsFile,
    doc: { bots },
    get assetsDoc() { return assetsDoc; },
    materializer: noopMaterializer(),
    log: { warn() {}, info() {} },
    refreshRunner: () => true,
  };
  return state;
};

const SKILL_A = { id: 'ast-s1', type: 'skill', name: 'wao-company', version: 3, origin: 'operator', createdAt: 1, updatedAt: 1, content: { name: 'wao-company', description: 'd', body: 'B1' } };
const SKILL_B = { id: 'ast-s9', type: 'skill', name: 'second-skill', version: 1, origin: 'operator', createdAt: 1, updatedAt: 1, content: { name: 'second-skill', body: 'B9' } };
const MCP_X = { id: 'ast-mx', type: 'mcp', name: 'mcp-x', version: 1, origin: 'operator', createdAt: 1, updatedAt: 1, content: { servers: { company: { command: 'node' } } } };
const MCP_Y = { id: 'ast-my', type: 'mcp', name: 'mcp-y', version: 1, origin: 'operator', createdAt: 1, updatedAt: 1, content: { servers: { company: { command: 'node' } } } }; // same serverId
const MEM = { id: 'ast-mem', type: 'memory', name: 'mem', version: 1, origin: 'operator', createdAt: 1, updatedAt: 1, content: { notes: ['n'] } };
const AGENT_MADE = { id: 'ast-ag', type: 'prompt', name: 'agent-style', version: 1, origin: 'mcp', createdAt: 1, updatedAt: 1, content: { text: 'T' } };
const BOT = { id: 'b1', name: '一', enabled: true, provider: 'fakeprov', providerConfig: { cwd: '/tmp' } };

test('bindAsset: happy path shared — binding lands in the bot record (bots.json), receipt shape', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A] });
  const receipt = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.binding.assetId, 'ast-s1');
  assert.equal(receipt.binding.mode, 'shared');
  assert.deepEqual(receipt.rematerialized, ['b1']);
  assert.deepEqual(receipt.failed, []);
  assert.deepEqual(receipt.writes, []);
  assert.equal(receipt.skipped, 'not-equipped');
  const stored = state.doc.bots[0].assets;
  assert.deepEqual(stored, [{ assetId: 'ast-s1', mode: 'shared' }]);
});

test('bindAsset: unknown bot / asset → 404; bad mode / duplicate binding / agent-made shared → 400 with the adjudicated copy', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A, AGENT_MADE] });
  await assert.rejects(bindAsset(state, 'nobody', { assetId: 'ast-s1', mode: 'shared' }), /bot not found/);
  const notFound = await bindAsset(state, 'b1', { assetId: 'nope', mode: 'shared' }).catch((e) => e);
  assert.equal(notFound.status, 404);
  const badMode = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'hot' }).catch((e) => e);
  assert.equal(badMode.status, 400);
  await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  const dup = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' }).catch((e) => e);
  assert.equal(dup.status, 400);
  assert.match(dup.message, /已绑定.*先解绑/);
  const agentShared = await bindAsset(state, 'b1', { assetId: 'ast-ag', mode: 'shared' }).catch((e) => e);
  assert.equal(agentShared.status, 400);
  assert.match(agentShared.message, /Agent 创建的资产仅可私发（exclusive）绑定/);
});

test('bindAsset: same (type,name) second shared → 400 「已配发，先卸载或改私发」; exclusive shadows shared with receipt note', async () => {
  const sameName = { ...SKILL_B, name: SKILL_A.name, content: { ...SKILL_B.content, name: SKILL_A.name } };
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A, sameName] });
  await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  const dup = await bindAsset(state, 'b1', { assetId: 'ast-s9', mode: 'shared' }).catch((e) => e);
  assert.equal(dup.status, 400);
  assert.match(dup.message, /同名技能已配发，先卸载或改私发/);
  // exclusive + shared coexist: allowed, shared is suppressed (§2.3 row 2)
  const r = await bindAsset(state, 'b1', { assetId: 'ast-s9', mode: 'exclusive' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.suppressed.map((s) => s.assetId), ['ast-s1']);
  assert.match(r.suppressedNote, /被私发副本压制/);
});

test('bindAsset: exclusive takes a full content snapshot stamped with version/time', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [{ ...SKILL_A }] });
  await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'exclusive' });
  const b = state.doc.bots[0].assets[0];
  assert.equal(b.mode, 'exclusive');
  assert.deepEqual(b.snapshot, SKILL_A.content);
  assert.equal(b.snapshotVersion, 3);
  assert.ok(Number.isFinite(b.snapshotAt));
  assert.equal(b.snapshotType, 'skill');
  assert.equal(b.snapshotName, SKILL_A.name);
});

test('bindAsset: two mcp assets with the same serverId → 400 naming the server; memory on shared cwd → warning in receipt', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [MCP_X, MCP_Y, MEM] });
  await bindAsset(state, 'b1', { assetId: 'ast-mx', mode: 'shared' });
  const conflict = await bindAsset(state, 'b1', { assetId: 'ast-my', mode: 'shared' }).catch((e) => e);
  assert.equal(conflict.status, 400);
  assert.match(conflict.message, /MCP server 冲突.*company.*mcp-x/);
  const mem = await bindAsset(state, 'b1', { assetId: 'ast-mem', mode: 'shared' });
  assert.ok(mem.warnings.some((w) => /共享 cwd/), JSON.stringify(mem.warnings));
});

test('bindAsset: materializer hooks (provider support / foreign guard / cross-bot file conflict) are honored when non-empty', async () => {
  const base = noopMaterializer();
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A] });
  state.materializer = {
    ...base,
    checkBind: () => ['该 provider 暂不支持资产装备'],
    detectForeignTargets: () => [{ path: '/tmp/b1/.claude/skills/wao-company/SKILL.md' }],
  };
  const r1 = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' }).catch((e) => e);
  assert.equal(r1.status, 400);
  assert.match(r1.message, /暂不支持资产装备/);
  state.materializer = { ...base, detectForeignTargets: () => [{ path: '/tmp/p' }] };
  const r2 = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' }).catch((e) => e);
  assert.equal(r2.status, 400);
  assert.match(r2.message, /目标已有非 WAO 技能：\/tmp\/p/);
  state.materializer = { ...base, detectFileConflicts: () => [{ botId: 'other', path: '/tmp/shared/SKILL.md' }] };
  const r3 = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' }).catch((e) => e);
  assert.equal(r3.status, 400);
  assert.match(r3.message, /与 bot other 的资产目标文件冲突：\/tmp\/shared\/SKILL.md/);
});

test('bindAsset: per-bot isolation — a materialize throw lands in failed[], binding persists, status 200', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A] });
  state.materializer = { ...noopMaterializer(), materialize: async () => { throw new Error('disk full'); } };
  const receipt = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  assert.deepEqual(receipt.rematerialized, []);
  assert.deepEqual(receipt.failed, [{ botId: 'b1', error: 'disk full' }]);
  assert.deepEqual(state.doc.bots[0].assets.map((b) => b.assetId), ['ast-s1'], 'registry stays ahead of disk; retry via rematerialize');
});

test('unbindAsset: removes the binding, reports exclusive content loss; unknown pairs 404', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A] });
  await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'exclusive' });
  const receipt = await unbindAsset(state, 'b1', 'ast-s1');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.removed.mode, 'exclusive');
  assert.equal(receipt.removed.exclusiveContentLost, true);
  assert.deepEqual(state.doc.bots[0].assets, []);
  const missing = await unbindAsset(state, 'b1', 'ast-s1').catch((e) => e);
  assert.equal(missing.status, 404);
  const shared = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  assert.equal(shared.removed, undefined);
  const r2 = await unbindAsset(state, 'b1', 'ast-s1');
  assert.equal(r2.removed.exclusiveContentLost, false);
});

test('bind/unbind: runner refresh ONLY after a successful materialize — runner follows registry truth (W3 T1 review)', async () => {
  const state = mkState({ bots: [{ ...BOT }], assets: [SKILL_A] });
  const refreshed = [];
  state.refreshRunner = (bot) => { refreshed.push(bot.id); return true; };
  // materialize throws → binding persists (registry ahead of disk), but NO refresh
  state.materializer = { ...noopMaterializer(), materialize: async () => { throw new Error('disk full'); } };
  const bound = await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  assert.deepEqual(bound.failed, [{ botId: 'b1', error: 'disk full' }]);
  assert.deepEqual(refreshed, [], 'no runner refresh while disk lags the registry');
  // same refusal on the unbind tail
  const un = await unbindAsset(state, 'b1', 'ast-s1');
  assert.deepEqual(un.failed, [{ botId: 'b1', error: 'disk full' }]);
  assert.deepEqual(refreshed, [], 'cleanup failure also keeps the last-good runner');
  // materialize succeeds → refresh happens exactly once per op
  state.materializer = noopMaterializer();
  await bindAsset(state, 'b1', { assetId: 'ast-s1', mode: 'shared' });
  await unbindAsset(state, 'b1', 'ast-s1');
  assert.deepEqual(refreshed, ['b1', 'b1'], 'successful rematerializes refresh the runner');
});
