// Asset materialization pipeline executor (DESIGN-ASSETS rev.2 §3, W3 T2):
// the REAL materializer behind state.materializer (T1 shipped the noop).
// Providers are PURE PLANNERS — `materializeAssets(bot, plan, opts)` returns a
// write plan without touching disk:
//
//   { writes: [ { kind: 'file-create',   target, content, mode?, for?, appliesTo? }
//             | { kind: 'marker-section', target, format: 'markdown'|'toml', content, for? }
//             | { kind: 'hook-entry',    target, pointer: '/hooks/PreToolUse', content, for? }
//             | { kind: 'rtk-init',      target: <config dir>, flavor: 'claude'|'codex'|'pi', for?, owned: false } // §7.1 W3 T3
//             | { kind: 'argv',          flags: [...], for? } ],   // audit-only receipt row
//     notes: [{ assetId?, detail }],
//     entries: [{ file, pointer, entry }],   // §3.8 manifest JSON 条目型全文
//     tools: [{ assetId, kind: 'ripgrep'|'rtk', ...state }] } // §7.2 预检/装备态（ripgrep 由 provider 记，rtk 由本执行器记）
//
// THIS file owns every disk mutation: §8.3 jail guard (writes only under the
// bot's declared roots + data/), §3.4 marker-section surgery with orphan
// detection, §3.7 atomicity (in-memory build → ordered tmp+rename → snapshot
// rollback), §3.8 manifest persistence (data/assets/<botId>/manifest.json),
// §3.6 precise unload (files by manifest + guard notes, marker strips, JSON
// array entries by full-text deep-equal), §3.5 dryRun 回验 and the startup
// sweep (T1-skipped bindings migrate once; afterwards read-only drift check).
//
// V-item freeze points baked into the design (verified 2026-11-07, §9):
// V1 claude CLAUDE_CONFIG_DIR carries skills/+CLAUDE.md; V2 CODEX_HOME carries
// skills/+AGENTS.md; V7 --mcp-config overrides same-named user-scope servers;
// V8 claude expands ${VAR} in env/headers at spawn (missing → literal passthrough),
// codex env_vars forwards from its own environment; V9 pi tolerates (and its own
// rewrites preserve) unknown top-level keys in mcp.json.
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { atomicWrite } from '../../src/kernel/config.js';
import { childEnv } from '../../src/kernel/safeEnv.js';
import { BOT_ID_RE } from './bots.js';

const MARKER_RE = /^(?:<!--\s*)?# wao:assets:(begin|end):v(\d+):bot=([^\s>]*?)(?:\s*-->)?$/;
export const MARKER_VERSION = 1;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readText = (file) => {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
};

// Deterministic JSON (§3.5): sorted keys at every depth — byte-stable across
// materializations, the idempotence anchor.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function planFingerprint(plan) {
  return createHash('sha256').update(stableStringify(plan ?? [])).digest('hex');
}

// —— §7.1 RTK 装备（W3 T3）——————————————————————————————————————————————————
// rtk 1.1.0 实证（2026-11-07，本机 ~/.local/bin/rtk，探针 /tmp/wao-t3-v5*）：
//   V5 已解冻——`rtk init -g` 尊重 CLAUDE_CONFIG_DIR / CODEX_HOME /
//   PI_CODING_AGENT_DIR 重定向，三 flavor 的全部 bot 面产物都落在重定向目录：
//     claude: RTK.md + CLAUDE.md(@RTK.md 引用行) + settings.json 的
//             hooks.PreToolUse[] JSON 条目 {matcher:'Bash', hooks:[{type:'command',
//             command:'rtk hook claude'}]}（宿主文件则追加，幂等，.bak 备份）
//     codex:  RTK.md + AGENTS.md(@/abs/RTK.md) + hooks.json 的同形条目
//             （command:'rtk hook codex'；--codex 与 --auto-patch 互斥→裸跑即可）
//     pi:     extensions/rtk.ts（版本耦合的 TS 扩展）+ extensions/.rtk-agents
//   另有两处 rtk 自有域写入（~/Library/Application Support/rtk 的 filters.toml
//   模板 + history.db）——二进制自身域，非 bot 面，§8.3 前缀校验白名单之。
//   `rtk init -g … --uninstall` 三 flavor 均尊重重定向且幂等（hook 条目已被
//   手删时 exit 0），但会留 <被改文件>.bak 残片——卸载后由 WAO 清扫。
const RTK_FLAVORS = {
  claude: {
    envKey: 'CLAUDE_CONFIG_DIR',
    initArgs: ['--auto-patch', '--no-trust-filters'], // 免交互（实证：裸跑会 prompt settings.json 补丁）
    hookFile: 'settings.json',
    hookPointer: '/hooks/PreToolUse',
    hookCommand: 'rtk hook claude',
  },
  codex: {
    envKey: 'CODEX_HOME',
    initArgs: [], // 实证：--codex 与 --auto-patch/--no-patch 互斥，stdin 关闭即免交互
    hookFile: 'hooks.json',
    hookPointer: '/hooks/PreToolUse',
    hookCommand: 'rtk hook codex',
  },
  pi: {
    envKey: 'PI_CODING_AGENT_DIR',
    initArgs: [], // `--agent pi`；无 JSON hook 面（extensions/rtk.ts 是版本耦合 TS）
  },
};

const rtkFlavorArgs = (flavor) => (flavor === 'codex' ? ['--codex'] : flavor === 'pi' ? ['--agent', 'pi'] : []);

// rtk 自有配置域（F26「配置在 ~/.config/rtk/」的 macOS 实际形状 + Linux 形状
// 都放行——dry-run 路径前缀校验用，二进制自身域不是 bot 面）。
const rtkOwnRoots = () => [
  join(homedir(), 'Library', 'Application Support', 'rtk'),
  join(homedir(), '.config', 'rtk'),
];

const tailOf = (s, n = 300) => String(s ?? '').trim().slice(-n);

// probeBin result cache (R2 hardening): the agents roster probes rtk/rg per
// request and the rtk executor probes per plan row — a fresh spawnSync each
// time froze the event loop linearly with bot count. Results are keyed by
// bin+mtime (a replaced binary gets a fresh key) and expire after 5 minutes,
// so an install/upgrade never waits longer than that to be seen.
const PROBE_TTL_MS = 5 * 60_000;
const probeCache = new Map(); // key → { at, result }

// 同步探测一个 CLI（§7.2 3s 超时口径）：{ok, version, error}。
export function probeBin(bin, timeoutMs = 3000) {
  let key = String(bin);
  try { key = `${bin}:${statSync(bin).mtimeMs}`; } catch { /* not stat-able (missing): keyed by name alone */ }
  const hit = probeCache.get(key);
  if (hit != null && Date.now() - hit.at < PROBE_TTL_MS) return hit.result;
  let result;
  try {
    const r = spawnSync(bin, ['--version'], { timeout: timeoutMs, encoding: 'utf8' });
    if (r.error != null) result = { ok: false, version: null, error: r.error.code === 'ENOENT' ? 'not-found' : String(r.error.message ?? r.error.code) };
    else if (r.status !== 0) result = { ok: false, version: null, error: `exit ${r.status}` };
    else result = { ok: true, version: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] || null, error: null };
  } catch (err) {
    result = { ok: false, version: null, error: err?.message ?? String(err) };
  }
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

// 跑一条 rtk 命令（stdin 关闭=免交互，30s 上限），env 注入 flavor 重定向变量。
// ASYNC (R2 hardening): rtkInit/rtkUninstall carry a 30s ceiling — a sync spawn
// there froze every chat and request for up to 30s. Same result shape the old
// spawnSync call sites consumed: {status, stdout, stderr, error} (status -1 +
// error message on spawn failure or timeout).
const runRtk = (rtkBin, args, flavor, target, timeoutMs = 30000) => new Promise((resolve) => {
  const env = childEnv(); // audit P0-2: no auth-shaped parent secrets into the rtk child
  const spec = RTK_FLAVORS[flavor];
  if (spec?.envKey) env[spec.envKey] = target;
  let child;
  try {
    child = spawn(rtkBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    resolve({ status: -1, stdout: '', stderr: '', error: err?.message ?? String(err) });
    return;
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c) => { stdout += c; });
  child.stderr?.on('data', (c) => { stderr += c; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.on('error', (err) => {
    clearTimeout(timer);
    resolve({ status: -1, stdout, stderr, error: err?.message ?? String(err) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve(timedOut
      ? { status: -1, stdout, stderr, error: `rtk 超时（${timeoutMs}ms）` }
      : { status: code, stdout, stderr, error: null });
  });
});

// 解析 `rtk init --dry-run` 输出里的将写路径（每行一个「…: /abs/path」，路径
// 可含空格——取冒号后到行尾）。
const dryRunPaths = (stdout) => {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('[dry-run]')) continue;
    const m = /:\s+(\/.*)$/.exec(line);
    if (m != null) out.push(m[1].trim());
  }
  return [...new Set(out)];
};

// 符号链接规范化前缀比较用：rtk 会把路径 realpath 化（macOS 上 /tmp 的
// dry-run 路径吐成 /private/tmp/…），纯 resolve 不解引用就对不上——对不存在
// 的目标（将写文件/目录）沿祖先递归到最近存在的一层再拼余段。
const canonPath = (p) => {
  try { return realpathSync(p); } catch { /* not there yet — canon the parent */ }
  const parent = dirname(p);
  if (parent === p) return resolve(p);
  return join(canonPath(parent), basename(p));
};

// —— §3.4 marker-section surgery ——————————————————————————————————————————

// Scan marker lines. Returns {own, foreign, unknownVersion, orphans}:
//   own: [{side:'begin'|'end', index}] — markers of THIS bot
//   foreign: botIds seen in markers that are not ours (无法归属 → drift, refuse)
//   unknownVersion: version segments other than ours (forward-compat anchor → refuse)
export function scanMarkers(text, botId) {
  const own = [];
  const foreign = new Set();
  const unknownVersion = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^<!--\s*wao:assets:(begin|end):v(\d+):bot=([^\s>]*?)\s*-->$/.exec(lines[i].trim())
      || /^#\s*wao:assets:(begin|end):v(\d+):bot=(\S*)$/.exec(lines[i].trim());
    if (m == null) continue;
    const [, side, version, markerBot] = m;
    if (Number(version) !== MARKER_VERSION) unknownVersion.add(`v${version}`);
    if (markerBot === botId) own.push({ side, index: i });
    else foreign.add(markerBot);
  }
  return { own, foreign: [...foreign], unknownVersion: [...unknownVersion] };
}

// Cut a TOML table block (header line through the next table header / EOF) —
// the §3.4 节外 wao- 残留 shape (a [mcp_servers."wao-*"] table outside markers).
const stripWaoTomlTables = (lines) => {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\s*mcp_servers\s*\.\s*"?wao-/.test(line);
    if (/^\s*\[/.test(line) && !header) skipping = false;
    if (header) { skipping = true; continue; }
    if (skipping && line.trim() === '') continue; // drop the block's blank lines too
    if (!skipping) out.push(line);
  }
  return out;
};

// Replace (or append) this bot's marker section in `text`. §3.4 rules:
// - markers missing (user deleted both) → treat as unmaterialized, rebuild at
//   EOF; single-sided markers are orphans → that marker and everything after
//   it is unmaterialized debris (cut to EOF);
// - wao- remnants OUTSIDE the section (TOML tables / stray marker lines) are
//   stripped (先清孤儿再重建);
// - foreign-bot markers or unknown :vN: segments → refuse (drift, no rewrite).
// Returns {text, cleaned: [descriptions]} — deterministic for (base, content).
export function spliceMarkerSection(text, { botId, format, content }) {
  const nl = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  const lines = nl.split('\n');
  const { own, foreign, unknownVersion } = scanMarkers(nl, botId);
  if (foreign.length > 0) {
    throw new Error(`标记节含他 bot 命名空间（bot=${foreign.join(',')}）——疑似跨 bot 残留，请人工处置（wao doctor）`);
  }
  if (unknownVersion.length > 0) {
    throw new Error(`标记节版本段未知（${unknownVersion.join(',')}，本实现只认 v${MARKER_VERSION}）=漂移，不自动改写`);
  }
  const cleaned = [];
  const begins = own.filter((x) => x.side === 'begin');
  const ends = own.filter((x) => x.side === 'end');
  let out = lines;
  if (begins.length > 1 || ends.length > 1) {
    throw new Error(`标记节成对多于一份（begin×${begins.length} end×${ends.length}）=漂移，请人工处置`);
  }
  if (begins.length === 1 && ends.length === 1) {
    const from = begins[0].index;
    const to = ends[0].index;
    if (to < from) throw new Error('标记节 end 在 begin 之前 =漂移，请人工处置');
    out = [...lines.slice(0, from), ...lines.slice(to + 1)];
    cleaned.push('替换既有标记节');
  } else if (begins.length === 1 || ends.length === 1) {
    // 单侧标记：该残标记及其后至文件尾视为未物化残骸 (§3.4 P0)
    const at = (begins[0] ?? ends[0]).index;
    out = lines.slice(0, at);
    cleaned.push('清除单侧残标记（至文件尾）');
  } else {
    cleaned.push('标记缺失，视为未物化，重建于文件末尾');
  }
  // 节外 wao- 残留（双侧全删留中间内容的半删态也落在这里）
  if (format === 'toml') {
    const before = out.length;
    out = stripWaoTomlTables(out);
    if (out.length !== before) cleaned.push('清除节外 wao- TOML 表残留');
  } else {
    const stray = out.filter((l) => MARKER_RE.test(l.trim()));
    if (stray.length > 0) {
      out = out.filter((l) => !MARKER_RE.test(l.trim()));
      cleaned.push('清除游离 wao 标记行');
    }
  }
  const [open, close] = format === 'toml'
    ? [`# wao:assets:begin:v${MARKER_VERSION}:bot=${botId}`, `# wao:assets:end:v${MARKER_VERSION}:bot=${botId}`]
    : [`<!-- wao:assets:begin:v${MARKER_VERSION}:bot=${botId} -->`, `<!-- wao:assets:end:v${MARKER_VERSION}:bot=${botId} -->`];
  let base = out.join('\n').replace(/\s+$/, '');
  if (base !== '') base += '\n\n';
  return { text: `${base}${open}\n${content}\n${close}\n`, cleaned };
}

// §3.6 JSON 条目型: precise-match delete from an array by pointer. Returns
// {doc, removed, warn} — a mutated COPY; a no-match (user edited the entry) is
// warn-not-delete (绝不按索引删、绝不模糊匹配).
export function removeJsonEntry(doc, pointer, recordedEntry) {
  const segments = String(pointer).split('/').filter(Boolean);
  if (segments.length === 0 || segments[segments.length - 1] === '-') {
    return { doc, removed: false, warn: `指针 ${pointer} 不指向数组元素` };
  }
  let node = doc;
  for (const seg of segments.slice(0, -1)) {
    if (!isObject(node)) return { doc, removed: false, warn: `指针 ${pointer} 路径不存在` };
    node = node[seg];
  }
  const key = segments[segments.length - 1];
  const index = Number(key);
  // Two pointer shapes, both §3.8-legal: the ELEMENT ('/hooks/PreToolUse/3' —
  // recorded indices drift, so the deep-equal twin scan carries the load) and
  // the ARRAY ('/hooks/PreToolUse' — match anywhere inside).
  let arr;
  if (Number.isInteger(index)) {
    arr = node;
  } else if (isObject(node) && Array.isArray(node[key])) {
    arr = node[key];
  } else {
    arr = Array.isArray(node) ? node : null;
  }
  if (!Array.isArray(arr)) {
    return { doc, removed: false, warn: `指针 ${pointer} 不再指向数组（可能已被手改）` };
  }
  // precise match FIRST at the recorded index, then a full scan for a
  // deep-equal twin (the array may have shifted — recorded indices drift);
  // never a fuzzy match, never a blind index delete.
  const same = (a, b) => stableStringify(a) === stableStringify(b);
  let hit = Number.isInteger(index) && index >= 0 && index < arr.length && same(arr[index], recordedEntry)
    ? index
    : arr.findIndex((item) => same(item, recordedEntry));
  if (hit === -1) {
    return {
      doc,
      removed: false,
      warn: `hook 条目已变化，请人工确认后删除：${stableStringify(recordedEntry)}`,
    };
  }
  const out = structuredClone(doc);
  let node2 = out;
  for (const seg of segments.slice(0, -1)) node2 = node2[seg];
  const arr2 = Number.isInteger(index) ? node2 : node2[key];
  arr2.splice(hit, 1);
  return { doc: out, removed: true };
}

// —— the materializer (state.materializer seam, noopMaterializer contract) —

export function createMaterializer({ ports, dataDir, log, rtkBin = 'rtk' }) {
  const assetsDir = join(dataDir, 'assets');
  const logger = log ?? console;
  // Defensive second check (audit P0-1): botId is a path segment under
  // data/assets/ and removeAssets rmSync's its directory recursively —
  // anything that is not a slug must never reach join().
  const manifestFileOf = (botId) => {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) {
      throw new Error(`materializer: bot id ${JSON.stringify(botId)} 不是合法 slug（仅限字母/数字/下划线/连字符，≤64 字符）`);
    }
    return join(assetsDir, botId, 'manifest.json');
  };
  const readManifest = (botId) => {
    const file = manifestFileOf(botId); // slug guard throws OUTSIDE the catch below (audit P0-1)
    const doc = (() => {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    })();
    return isObject(doc) && doc.botId === botId ? doc : null;
  };
  const saveManifest = (botId, doc) => atomicWrite(manifestFileOf(botId), `${JSON.stringify(doc, null, 2)}\n`);

  const providerOf = (bot) => {
    const port = ports?.getProvider?.(bot?.provider);
    return port != null && typeof port.materializeAssets === 'function' ? port : null;
  };

  // §8.3 越狱防护: every write target must sit under an allowed root (bot
  // declared dirs + WAO data/) with no `..` segment. dsh's profile tree under
  // DSH_HOME/~/.dsh is the provider's own config domain — same trust face as
  // its pre-existing materializeConfig writes — so it joins the root set for
  // dsh bots only. pi's DEFAULT agent dir (~/.pi/agent-wao-<botId>, the
  // piAgentDirFor formula in provider-pi/models.js — inlined here, no
  // plugin-to-plugin import) joins the same way: without it every default-dir
  // pi bot's asset writes would fail the jail (W3 T2 review Critical 1).
  const allowedRootsOf = (bot) => {
    const pc = isObject(bot?.providerConfig) ? bot.providerConfig : {};
    const roots = [pc.cwd, pc.claudeConfigDir, pc.codexHome, pc.piAgentDir, dataDir]
      .filter((v) => typeof v === 'string' && v !== '');
    if (bot?.provider === 'dsh') {
      roots.push(process.env.DSH_HOME || join(homedir(), '.dsh'));
    }
    if (bot?.provider === 'pi' && !(typeof pc.piAgentDir === 'string' && pc.piAgentDir !== '')) {
      roots.push(join(homedir(), '.pi', `agent-wao-${bot?.id ?? 'bot'}`));
    }
    return roots.map((r) => resolve(r));
  };
  const jailCheck = (bot, targets) => {
    const roots = allowedRootsOf(bot);
    for (const target of targets) {
      const resolved = resolve(target);
      if (resolved.split(sep).includes('..')) {
        throw new Error(`资产写入目标含 .. 段（拒绝）：${target}`);
      }
      const ok = roots.some((root) => resolved === root || resolved.startsWith(root + sep));
      if (!ok) {
        throw new Error(`资产写入目标越界（仅允许 bot 声明目录与 data/）：${target}`);
      }
    }
  };

  // Build the provider's write plan (dryRun for planning/verification paths).
  const planWrites = async (bot, plan, { dryRun = false } = {}) => {
    const port = providerOf(bot);
    if (port == null) {
      throw new Error(`provider ${bot?.provider} 暂不支持资产装备（端口未实现 materializeAssets）`);
    }
    const result = await port.materializeAssets(bot, plan ?? [], { log: logger, dryRun, assetsDir });
    if (dryRun) return result;
    if (result != null && !Array.isArray(result.writes)) {
      throw new Error(`materializeAssets 返回的 writes 不是数组（provider ${bot?.provider}）`);
    }
    return result;
  };

  const dedicatedDirOf = (bot) => {
    const pc = isObject(bot?.providerConfig) ? bot.providerConfig : {};
    return ['claudeConfigDir', 'codexHome', 'piAgentDir'].find((k) => typeof pc[k] === 'string' && pc[k] !== '');
  };

  // —— §7.1 RTK 执行器（providers 只计划 rtk-init 写；本文件独占盘面）————————
  // 每条 rtk 计划落三态之一（§7.1 状态机，态存 manifest.tools，不进 bots.json）：
  //   unavailable —— rtk 二进制缺失：绑定保留、零产物，notes/agents 指引安装；
  //   armed       —— 主路径（dry-run 采集→§8.3 前缀校验→真跑→回读断言）或
  //                  回退路径（dry-run 不可用/越界→WAO 自写 hook 条目，claude/
  //                  codex 专属；pi 的 extensions/rtk.ts 是版本耦合面，不伪造，
  //                  主路径不可用即 failed）；
  //   failed      —— 真跑非零/超时：throw（per-bot 隔离→回执 failed[]），stderr
  //                  摘要随 error，manifest lastResult 记因。
  // dry-run 白名单 = §8.3 允许根 ∪ rtk 自有配置域（filters.toml 模板等二进制
  // 自身域，非 bot 面）；其余任何越界路径 → 回退路径。
  const rtkSweepBaks = (flavor, target, notes) => {
    const spec = RTK_FLAVORS[flavor];
    if (spec?.hookFile == null) return;
    const bak = join(target, `${spec.hookFile}.bak`);
    if (existsSync(bak)) {
      try { unlinkSync(bak); } catch { /* best effort */ }
      notes.push({ detail: `清扫 rtk 卸载残片：${bak}` });
    }
  };

  // 卸载一条已装备的 rtk（stale 清理与 removeAssets 共用，best-effort 不抛）：
  // rtk 自带 --uninstall 优先（实证三 flavor 均尊重重定向且幂等）；返回
  // handled=rtk 已自清 hook 条目——false（rtk 缺失/非零/回退装备）时 entries
  // 精确匹配删（清单已记条目全文）兜底，另扫 .bak。ASYNC：runRtk 不再阻塞
  // 事件循环（R2）。
  const rtkUninstall = async (bot, w, notes) => {
    const flavor = w.flavor;
    const spec = RTK_FLAVORS[flavor];
    if (spec == null || typeof w.path !== 'string') return false;
    if (w.mode === 'wao-hook') {
      // 回退路径装备：产物只有 WAO 自写条目（entries 循环精确删），不跑 rtk。
      rtkSweepBaks(flavor, w.path, notes);
      return false;
    }
    const probe = probeBin(rtkBin);
    if (probe.ok) {
      const r = await runRtk(rtkBin, ['init', '-g', ...rtkFlavorArgs(flavor), '--uninstall'], flavor, w.path);
      if (r.status === 0) {
        notes.push({ detail: `rtk 卸载成功（flavor ${flavor}，${w.path}）` });
        rtkSweepBaks(flavor, w.path, notes);
        return true;
      }
      notes.push({ detail: `rtk uninstall 非零（exit ${r.status}）：${tailOf(r.stderr || r.error)}——hook 条目按清单精确匹配删兜底` });
    } else {
      notes.push({ detail: `rtk 二进制缺失（${probe.error}），无法跑 rtk uninstall——hook 条目按清单精确匹配删兜底` });
    }
    rtkSweepBaks(flavor, w.path, notes);
    return false;
  };

  // 执行一条 rtk-init 计划（materialize 步 3.5；returns nothing——产物经
  // notes/receiptRows/entriesOut/toolsOut 流出）。throw = failed 态。ASYNC：
  // dry-run 与真跑都走非阻塞 spawn（R2）。
  const rtkInit = async (bot, w, { snap, applied, receipt, notes, entriesOut, toolsOut }) => {
    const flavor = w.flavor;
    const spec = RTK_FLAVORS[flavor];
    const target = resolve(String(w.target ?? ''));
    const assetId = typeof w.for === 'string' ? w.for : undefined;
    const state = { assetId, kind: 'rtk', flavor, target };
    // 态 1：unavailable —— 二进制不在，绑定保留、零产物（§7.1）。
    const probe = probeBin(rtkBin);
    if (!probe.ok) {
      toolsOut.push({ ...state, state: 'unavailable' });
      notes.push({ assetId, detail: 'rtk 未安装（unavailable）：绑定保留但未装备——安装 rtk（brew install rtk 或 GitHub releases）后 POST rematerialize-assets 装备' });
      return;
    }
    state.version = probe.version;
    // 主路径前置：dry-run 采集将写路径 → §8.3 前缀校验（∪ rtk 自有域）。
    const dry = await runRtk(rtkBin, ['init', '-g', ...rtkFlavorArgs(flavor), '--dry-run'], flavor, target);
    let fallbackReason = null;
    const roots = [...allowedRootsOf(bot), ...rtkOwnRoots()].map(canonPath);
    const paths = dryRunPaths(dry.stdout);
    if (dry.status !== 0) fallbackReason = `dry-run 非零（exit ${dry.status}）`;
    else if (paths.length === 0) fallbackReason = 'dry-run 未解析出任何将写路径';
    else {
      const outside = paths.filter((p) => {
        const rp = canonPath(p);
        return !roots.some((root) => rp === root || rp.startsWith(root + sep));
      });
      if (outside.length > 0) fallbackReason = `dry-run 越界路径：${outside.join('、')}`;
    }
    if (fallbackReason == null) {
      // 主路径：快照将写文件（回滚锚）→ 真跑 → 回读断言 + 清 .bak。
      for (const p of paths) {
        try { snap(p); } catch { /* snapshot best effort */ }
      }
      const run = await runRtk(rtkBin, ['init', '-g', ...rtkFlavorArgs(flavor), ...spec.initArgs], flavor, target);
      if (run.status !== 0) {
        // 态 3：failed —— 非零/超时，throw 带 stderr 摘要（per-bot 隔离 → failed[]）。
        throw new Error(`rtk init 失败（flavor ${flavor}，exit ${run.status}）：${tailOf(run.stderr || run.error || run.stdout)}`);
      }
      for (const p of paths) applied.push({ kind: 'write', target: p });
      receipt.push({ path: target, action: 'rtk-init' });
      toolsOut.push({ ...state, state: 'armed', mode: 'rtk-init' });
      // 回读断言（§7.1）：claude/codex 找到 rtk 写入的 PreToolUse 条目 → 清单
      // 记全文（rtk 缺失时的卸载兜底）；pi 断言扩展文件在位。
      if (spec.hookFile != null) {
        const hookFile = join(target, spec.hookFile);
        let hookDoc = null;
        try { hookDoc = JSON.parse(readText(hookFile) ?? 'null'); } catch { hookDoc = null; }
        const arr = isObject(hookDoc) && Array.isArray(hookDoc?.hooks?.PreToolUse) ? hookDoc.hooks.PreToolUse : [];
        const entry = arr.find((e) => JSON.stringify(e ?? {}).includes(spec.hookCommand)) ?? null;
        if (entry != null) {
          entriesOut.push({ file: hookFile, pointer: spec.hookPointer, entry, via: 'rtk' });
          notes.push({ assetId, detail: `rtk 已配置（${probe.version}，flavor ${flavor}，主路径）：${hookFile} PreToolUse hook + RTK.md——卸载走 rtk uninstall` });
        } else {
          notes.push({ assetId, detail: `rtk 已配置（${probe.version}，flavor ${flavor}，主路径），但回读未找到 ${spec.hookCommand} 条目（形状漂移？）——卸载依赖 rtk uninstall` });
        }
        const bak = join(target, `${spec.hookFile}.bak`);
        if (existsSync(bak)) {
          try { unlinkSync(bak); } catch { /* best effort */ }
        }
      } else {
        const ext = join(target, 'extensions', 'rtk.ts');
        notes.push(existsSync(ext)
          ? { assetId, detail: `rtk 已配置（${probe.version}，flavor pi，主路径）：${ext} 扩展——卸载走 rtk uninstall` }
          : { assetId, detail: `rtk 报告成功但 ${ext} 未出现（形状漂移？）——卸载依赖 rtk uninstall` });
      }
      return;
    }
    // 回退路径（§7.1 双路径之二）：WAO 自写 hook 条目（JSON 条目型——清单记
    // 全文、卸载精确匹配删）。仅 claude/codex 有 JSON hook 面；pi 的扩展文件
    // 与 rtk 版本耦合，伪造比失败更糟 → failed。
    if (spec.hookFile == null) {
      throw new Error(`rtk 主路径不可用（${fallbackReason}）且 pi 无 JSON hook 面（extensions/rtk.ts 为版本耦合产物，不由 WAO 伪造）——修复 rtk 后 rematerialize`);
    }
    const hookFile = join(target, spec.hookFile);
    snap(hookFile);
    let doc;
    try { doc = JSON.parse(readText(hookFile) ?? 'null'); } catch { doc = null; }
    if (doc == null) doc = {};
    const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: spec.hookCommand }] };
    const next = upsertJsonEntry(doc, spec.hookPointer, entry);
    atomicWrite(hookFile, `${JSON.stringify(next, null, 2)}\n`);
    applied.push({ kind: 'write', target: hookFile });
    receipt.push({ path: hookFile, action: 'write' });
    entriesOut.push({ file: hookFile, pointer: spec.hookPointer, entry });
    toolsOut.push({ ...state, state: 'armed', mode: 'wao-hook' });
    notes.push({ assetId, detail: `rtk 经回退路径装备（${probe.version}，flavor ${flavor}）：主路径不可用（${fallbackReason}），WAO 自写 ${hookFile} PreToolUse 条目（卸载=精确匹配删）` });
  };

  return {
    assetsDir,

    // §3.8 manifest read access for the agents roster (§8.1 P1-14): the
    // last-good materialization record {lastMaterializedAt, lastResult, ...}
    // or null when the bot never materialized. Deep clone — callers must
    // never see the live object (可变引用纪律).
    getManifest(botId) {
      const m = readManifest(botId);
      return m == null ? null : structuredClone(m);
    },

    // §2.3 bind-time support matrix (noop's answers + the T2 hard refusal:
    // a provider port without materializeAssets cannot carry assets at all).
    checkBind(bot, asset) {
      const errors = [];
      const provider = bot?.provider;
      if (providerOf(bot) == null) {
        errors.push('该 provider 暂不支持资产装备');
        return errors;
      }
      if (provider === 'dsh' && asset?.type === 'mcp') {
        // W3 T6 lifted the blanket 「dsh 无 MCP 面」 refusal — mcp rides
        // mcp-<serverId> profile rows now. What stays refused is the one
        // shape dsh cannot load: serverName is capped at 32 chars by
        // dsh-mcp-client's SERVER_NAME_PATTERN (verified against the
        // installed package), and an over-cap row fails dsh's config
        // validation with failOnStartupError=false → tools silently absent.
        for (const serverId of Object.keys(asset?.content?.servers ?? {})) {
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverId)) {
            errors.push(`dsh 岗位的 MCP serverId ${serverId} 超出 dsh-mcp-client serverName 上限 32 字符——请缩短后绑定（超长名会被 dsh 配置校验拒绝，MCP 工具静默不出现）`);
          }
        }
      }
      if (provider === 'dsh' && asset?.type === 'tool' && asset?.content?.kind === 'rtk') {
        errors.push('dsh 岗位不支持 rtk 工具资产（rtk 支持列表不含 dsh）');
      }
      // §7.1 硬红线：共享用户主目录绝不动。pi 是例外形状——无 piAgentDir 时
      // 其装备面是 WAO 命名空间的默认目录 ~/.pi/agent-wao-<botId>（per-bot，
      // 非共享主目录，jail 已列为允许根，T2 评审 C1 同款判定）。
      if (asset?.type === 'tool' && asset?.content?.kind === 'rtk' && provider !== 'dsh' && provider !== 'pi' && dedicatedDirOf(bot) === undefined) {
        errors.push('rtk 工具资产要求 bot 配置专属目录（claudeConfigDir/codexHome/piAgentDir 之一）——共享用户主目录绝不动用户自己的 settings/hooks');
      }
      return errors;
    },

    // §2.3 P1-13 skill 外来守卫: a plan target that already exists on disk
    // without our x-wao-asset annotation is a foreign skill — refuse naming it.
    async detectForeignTargets(bot, plan) {
      const result = await planWrites(bot, plan, { dryRun: true }).catch(() => null);
      if (result == null) return [];
      const foreign = [];
      for (const w of result.writes ?? []) {
        if (w?.kind !== 'file-create' || typeof w.target !== 'string') continue;
        const existing = readText(w.target);
        if (existing == null) continue;
        if (w.content == null || !String(w.content).includes('x-wao-asset:')) continue; // not a skill face
        if (!/^\s*x-wao-asset:\s*\S+/m.test(existing)) foreign.push({ path: w.target });
      }
      return foreign;
    },

    // §2.3 last row: cross-bot same-file conflict, judged against the OTHER
    // bots' materialization manifests (§3.8 is the design's data source).
    async detectFileConflicts(bot, plan, allBots = []) {
      const mine = await planWrites(bot, plan, { dryRun: true }).catch(() => null);
      if (mine == null) return [];
      const myTargets = new Set((mine.writes ?? []).map((w) => w?.target).filter((t) => typeof t === 'string'));
      const conflicts = [];
      for (const other of allBots) {
        if (!isObject(other) || other.id === bot.id) continue;
        const manifest = readManifest(other.id);
        if (manifest == null) continue;
        for (const w of manifest.writes ?? []) {
          if (typeof w?.path === 'string' && myTargets.has(w.path)) {
            conflicts.push({ botId: other.id, path: w.path });
            myTargets.delete(w.path); // one row per path
          }
        }
      }
      return conflicts;
    },

    // v2 终审 [Minor]: detectFileConflicts is manifest-blind — a same-root bot
    // WITHOUT a manifest (bound but never materialized here, or its manifest
    // was wiped) is an unchecked overlap the conflict scan silently skips.
    // Minimal adjudicated fallback: name those bots so the bind receipt can
    // warn 「rematerialize first」 instead of silence. Face roots only — the
    // WAO dataDir is in every bot's jail root set but is never a shared
    // materialization face.
    async detectUnverifiedSharedRoots(bot, plan = [], allBots = []) {
      const mine = await planWrites(bot, plan, { dryRun: true }).catch(() => null);
      const targets = (mine?.writes ?? [])
        .map((w) => w?.target)
        .filter((t) => typeof t === 'string')
        .map((t) => resolve(t));
      if (targets.length === 0) return [];
      const dataRoot = resolve(dataDir);
      const faceRootsOf = (b) => allowedRootsOf(b).filter((r) => r !== dataRoot);
      const out = [];
      for (const other of allBots) {
        if (!isObject(other) || other.id === bot.id) continue;
        if (readManifest(other.id) != null) continue; // covered by the real scan
        // a bot with no bindings never materialized anything — nothing to collide
        if (!Array.isArray(other.assets) || other.assets.length === 0) continue;
        const overlap = faceRootsOf(other)
          .some((r) => targets.some((t) => t === r || t.startsWith(r + sep)));
        if (overlap) out.push(other.id);
      }
      return out;
    },

    memoryWarning(bot) {
      if (bot?.provider === 'dsh') return null; // memory rides personaPrefix, not cwd files (§3.3)
      if (dedicatedDirOf(bot) !== undefined) return null;
      return '记忆落在共享 cwd，对同目录其他会话可见，建议配专属 config 目录（claudeConfigDir/codexHome/piAgentDir）';
    },

    // §7.1/§7.2 工具资产常驻警示（agents 名册面）：rtk 绑定但二进制缺失
    // （unavailable 态）、ripgrep 绑定但 rg 缺失（指引已注入但无效）。绑定
    // 成功不受影响——这是「装备面」的注记，不是绑定面的拒绝。
    toolWarnings(bot, plan = []) {
      const out = [];
      const toolEntries = (Array.isArray(plan) ? plan : []).filter((e) => e?.type === 'tool');
      if (toolEntries.some((e) => e?.content?.kind === 'rtk') && !probeBin(rtkBin).ok) {
        out.push('rtk 未安装：工具资产未装备（unavailable）——安装 rtk 后 POST rematerialize-assets 装备');
      }
      if (toolEntries.some((e) => e?.content?.kind === 'ripgrep') && !probeBin('rg').ok) {
        out.push('rg 未安装：ripgrep 指引已注入但本机无效（brew install ripgrep）');
      }
      return out;
    },

    // §3.7/§3.8 materialize: plan → jail → orphan-aware execute (atomic,
    // ordered, snapshot rollback) → manifest. Throws on failure (per-bot
    // isolation turns this into failed[] upstream); the manifest keeps the
    // last-good writes with lastResult='failed:…' (§3.8 不清旧清单).
    async materialize(bot, plan, { log: opLog } = {}) {
      const lg = opLog ?? logger;
      const result = await planWrites(bot, plan);
      const writes = result?.writes ?? [];
      const notes = Array.isArray(result?.notes) ? result.notes : [];
      const entries = Array.isArray(result?.entries) ? result.entries.map((e) => structuredClone(e)) : [];
      const tools = Array.isArray(result?.tools) ? result.tools.map((t) => structuredClone(t)) : [];

      const diskWrites = writes.filter((w) => w?.kind !== 'argv' && typeof w?.target === 'string');
      jailCheck(bot, diskWrites.map((w) => w.target));

      const oldManifest = readManifest(bot.id);
      // owned 真值 (W3 T2 review): a row is ours-whole-file only when the file
      // was ABSENT at write time (we created it) or an earlier manifest of ours
      // already owned it — a HOST file that pre-dates our first write (user
      // CLAUDE.md/AGENTS.md/config.toml/settings.json) records owned:false and
      // unloads by section-strip only, never whole-file delete. The snapshot
      // map (taken before each mutation) is the did-not-exist oracle.
      const oldOwned = new Map();
      for (const w of oldManifest?.writes ?? []) {
        if (typeof w?.path === 'string') oldOwned.set(resolve(w.path), w.owned !== false);
      }
      const newTargets = new Set(diskWrites.map((w) => resolve(w.target)));
      // §3.6 stale cleanup: paths the last-good manifest owns that the new
      // plan no longer covers (unbind / renamed asset → precise cleanup).
      // owned:false file rows are HOST files — never file-deleted; their
      // marker-section rows still get STRIPPED below (剥节保留其余内容).
      // hook-entry rows NEVER file-delete here — their host file survives and
      // the entry leaves by precise-match delete (below, step 1b). rtk-init
      // rows (owned:false, the bot's whole config dir) unload through rtk
      // uninstall (§7.1), never a file delete.
      const activeRtkDirs = new Set(diskWrites
        .filter((x) => x?.kind === 'rtk-init' && typeof x?.target === 'string')
        .map((x) => resolve(x.target)));
      const stale = (oldManifest?.writes ?? []).filter((w) => w?.kind !== 'hook-entry'
        && typeof w?.path === 'string' && !newTargets.has(resolve(w.path))
        && (w?.owned !== false || w?.kind === 'marker-section' || w?.kind === 'rtk-init'));
      const newEntryTexts = new Set(entries.map((e) => stableStringify(e?.entry)));
      // An rtk-written hook entry (via:'rtk', recorded by the install-time
      // readback) is NOT planner-visible — while the rtk asset stays bound the
      // step-3.5 rerun owns it (rtk init is idempotent); only an UNBOUND rtk
      // leaves it stale (rtk uninstall / precise delete below).
      const staleEntries = (oldManifest?.entries ?? []).filter((e) => {
        if (newEntryTexts.has(stableStringify(e?.entry))) return false;
        if (e?.via === 'rtk' && activeRtkDirs.has(resolve(dirname(e.file)))) return false;
        return true;
      });

      // §3.7.1/§3.7.3: full snapshot before the first mutation; reverse-restore on failure.
      const snapshots = new Map(); // target → Buffer|null (null = did not exist)
      const snap = (file) => {
        if (!snapshots.has(file)) {
          snapshots.set(file, readText(file) === null ? null : Buffer.from(readFileSync(file)));
        }
      };
      const receipt = [];
      const applied = []; // {kind, target, ...} in execution order for rollback
      const rtkHandledFiles = new Set(); // rtk uninstall 已自清的 hook 文件
      try {
        // 1. stale deletions (orphan/precise cleanup first). marker-section
        // rows are STRIPPED (§3.6 剥节保留其余内容), never file-deleted; the
        // file only goes when the stripped remainder is empty AND WAO-owned.
        // rtk-init rows unload FIRST (rtk uninstall 先于条目精确删——成功即自清)。
        for (const w of stale) {
          if (w.kind === 'rtk-init') {
            if (await rtkUninstall(bot, w, notes)) {
              const hookFile = RTK_FLAVORS[w.flavor]?.hookFile;
              if (hookFile != null) rtkHandledFiles.add(resolve(join(w.path, hookFile)));
            }
            continue;
          }
          snap(w.path);
          const existing = readText(w.path);
          if (existing == null) continue;
          if (w.kind === 'marker-section') {
            try {
              const r = stripSectionToFile(existing, bot.id, w.owned !== false);
              if (r.changed) {
                if (r.deleted) {
                  unlinkSync(w.path);
                  receipt.push({ path: w.path, action: 'delete' });
                  applied.push({ kind: 'unlink', target: w.path });
                } else {
                  atomicWrite(w.path, r.text);
                  receipt.push({ path: w.path, action: 'write' });
                  applied.push({ kind: 'write', target: w.path });
                }
                notes.push({ detail: `${w.path}: ${r.deleted ? '剥后为空，WAO 所建文件删除' : '标记节已剥离'}` });
              }
            } catch (err) {
              notes.push({ detail: `标记节剥离失败 ${w.path}: ${err?.message ?? err}` });
            }
            continue;
          }
          // skill guard (§3.6): only delete when the frontmatter still carries
          // our annotation — a user-rewritten skill is warn-not-delete.
          if (/SKILL\.md$/.test(w.path) && !/^\s*x-wao-asset:\s*\S+/m.test(existing)) {
            notes.push({ detail: `技能文件已被外部改写（无 x-wao-asset 注记），跳过删除：${w.path}` });
            continue;
          }
          unlinkSync(w.path);
          receipt.push({ path: w.path, action: 'delete' });
          applied.push({ kind: 'unlink', target: w.path });
        }
        // 1b. stale JSON entries: precise-match delete from their host files
        // (§3.6: 不匹配 → warn-not-delete, never an index delete). rtk-written
        // entries whose rtk uninstall already succeeded are rtk-cleaned — skip.
        for (const e of staleEntries) {
          if (e.via === 'rtk' && rtkHandledFiles.has(resolve(e.file))) continue;
          const text = readText(e.file);
          if (text == null) continue;
          let doc;
          try { doc = JSON.parse(text); } catch { notes.push({ detail: `条目目标已非 JSON，跳过清理：${e.file}` }); continue; }
          snap(e.file);
          const r = removeJsonEntry(doc, e.pointer, e.entry);
          if (r.removed) {
            atomicWrite(e.file, `${JSON.stringify(r.doc, null, 2)}\n`);
            receipt.push({ path: e.file, action: 'write' });
            applied.push({ kind: 'write', target: e.file });
          } else if (r.warn) {
            notes.push({ detail: r.warn });
          }
        }
        // 2. independent files (§3.7.2: 最危险的拼接节最后写)
        for (const w of diskWrites.filter((x) => x.kind === 'file-create')) {
          snap(w.target);
          atomicWrite(w.target, String(w.content ?? ''));
          if (w.mode === 0o600) {
            try { chmodSync(w.target, 0o600); } catch { /* best effort on exotic filesystems */ }
          }
          receipt.push({ path: w.target, action: 'write' });
          applied.push({ kind: 'write', target: w.target });
        }
        // 3. JSON hook entries (§3.6 JSON 条目型): idempotent replace of the
        //    recorded entry, manifest carries the full text for precise delete.
        for (const w of diskWrites.filter((x) => x.kind === 'hook-entry')) {
          snap(w.target);
          const doc = (() => { try { return JSON.parse(readText(w.target) ?? 'null'); } catch { return null; } })();
          if (doc == null) throw new Error(`hook 条目目标不是合法 JSON：${w.target}`);
          const next = upsertJsonEntry(doc, w.pointer, w.content);
          atomicWrite(w.target, `${JSON.stringify(next, null, 2)}\n`);
          receipt.push({ path: w.target, action: 'write' });
          applied.push({ kind: 'write', target: w.target });
        }
        // 3.5 rtk 装备（§7.1, W3 T3）: external-command writes — dry-run 采集
        //     → §8.3 前缀校验 → 真跑 → 回读断言（or 回退路径/failed/unavailable）。
        //     必须在标记节之前：rtk 向 CLAUDE.md/AGENTS.md 追加 @RTK.md 引用行，
        //     先 rtk 后拼接节重建，产物才字节稳定（幂等锚）。
        for (const w of diskWrites.filter((x) => x.kind === 'rtk-init')) {
          await rtkInit(bot, w, { snap, applied, receipt, notes, entriesOut: entries, toolsOut: tools });
        }
        // 4. marker sections last
        for (const w of diskWrites.filter((x) => x.kind === 'marker-section')) {
          snap(w.target);
          const base = readText(w.target) ?? '';
          const spliced = spliceMarkerSection(base, { botId: bot.id, format: w.format, content: String(w.content ?? '') });
          for (const c of spliced.cleaned) notes.push({ detail: `${w.target}: ${c}` });
          atomicWrite(w.target, spliced.text);
          receipt.push({ path: w.target, action: 'write' });
          applied.push({ kind: 'write', target: w.target });
        }
      } catch (err) {
        // §3.7.3 restore in reverse; a restore failure is the worst case —
        // log ERROR, surface 不静默 copy, rethrow the original cause.
        let restoreFailed = false;
        for (const op of applied.reverse()) {
          try {
            const snapBuf = snapshots.get(op.target) ?? null;
            if (snapBuf === null) unlinkSync(op.target); // we created it → un-create
            else atomicWrite(op.target, snapBuf); // we modified it → restore bytes
          } catch (restoreErr) {
            restoreFailed = true;
            logger.error?.(`materializer: 回滚失败 ${op.target}: ${restoreErr?.message ?? restoreErr}`);
          }
        }
        try {
          saveManifest(bot.id, {
            ...(oldManifest ?? { botId: bot.id, writes: [], entries: [] }),
            lastMaterializedAt: Date.now(),
            lastResult: `failed:${err?.message ?? err}${restoreFailed ? '（回滚未完成：资产物化不一致，建议重试绑定/rematerialize）' : ''}`,
          });
        } catch { /* manifest failure must not mask the original error */ }
        lg.warn?.(`materializer: materialize failed for bot ${bot.id}: ${err?.message ?? err}`);
        throw err;
      }

      // §3.8 manifest: full rewrite on success (deterministic writes list).
      saveManifest(bot.id, {
        botId: bot.id,
        planFingerprint: planFingerprint(plan),
        writes: diskWrites.map((w) => ({
          path: w.target,
          action: 'write',
          // 写入时真值（见 oldOwned 注）：provider 明示 owned:false 仍尊重；
          // 其余以「写入时文件不存在 或 上一好清单已归我」判定。
          owned: w.owned === false
            ? false
            : (snapshots.get(w.target) === null || oldOwned.get(resolve(w.target)) === true),
          kind: w.kind,
          ...(w.for !== undefined ? { for: w.for } : {}),
          ...(w.appliesTo !== undefined ? { appliesTo: w.appliesTo } : {}),
          // §7.1 rtk rows carry their equipment face (uninstall reads these).
          ...(w.kind === 'rtk-init' ? { flavor: w.flavor, mode: tools.find((t) => t?.kind === 'rtk' && resolve(t?.target ?? '') === resolve(w.target))?.mode ?? 'rtk-init' } : {}),
        })),
        entries,
        // §7.1/§7.2 工具资产装备状态（三态状态机 + ripgrep 预检结论）。
        ...(tools.length > 0 ? { tools } : {}),
        lastMaterializedAt: Date.now(),
        lastResult: 'ok',
      });
      // dsh .wao/ root cleanup (§3.6): an emptied WAO namespace dir goes away.
      // The climb stops at any allowed root — never past the bot's own cwd.
      const stopRoots = allowedRootsOf(bot);
      for (const w of stale) {
        if (w.kind !== 'rtk-init') cleanupEmptyParents(w.path, stopRoots);
      }
      return { writes: receipt, notes };
    },

    // §3.6 unload: bot DELETE / full cleanup — only what the manifest says we
    // wrote. Best-effort per the removeConfig contract; never touches foreign
    // content (guards inside), warnings instead of risky deletes.
    async removeAssets(bot, { log: opLog } = {}) {
      const lg = opLog ?? logger;
      const manifest = readManifest(bot.id);
      if (manifest == null) return { removed: false, skipped: 'no-manifest' };
      let removedAny = false;
      const warnings = [];
      // §7.1 rtk FIRST (best-effort): rtk uninstall 自清 hook 条目 + RTK.md；
      // 成功即 handled——下方条目循环跳过对应 via:'rtk' 条目（避免「已变化」
      // 误警）；rtk 缺失/非零 → 条目精确匹配删兜底。
      const rtkNotes = [];
      const rtkHandledFiles = new Set();
      for (const w of manifest.writes ?? []) {
        if (w?.kind !== 'rtk-init') continue;
        if (await rtkUninstall(bot, w, rtkNotes)) {
          const hookFile = RTK_FLAVORS[w.flavor]?.hookFile;
          if (hookFile != null) rtkHandledFiles.add(resolve(join(w.path, hookFile)));
          removedAny = true;
        }
      }
      for (const n of rtkNotes) lg.info?.(`materializer: removeAssets rtk bot ${bot.id}: ${n.detail}`);
      // JSON 条目型 next (settings.json must survive as a file)
      for (const e of manifest.entries ?? []) {
        if (e.via === 'rtk' && rtkHandledFiles.has(resolve(e.file))) continue;
        const text = readText(e.file);
        if (text == null) continue;
        let doc;
        try { doc = JSON.parse(text); } catch { warnings.push(`条目目标已非 JSON：${e.file}`); continue; }
        const r = removeJsonEntry(doc, e.pointer, e.entry);
        if (r.removed) {
          atomicWrite(e.file, `${JSON.stringify(r.doc, null, 2)}\n`);
          removedAny = true;
        } else if (r.warn) warnings.push(r.warn);
      }
      for (const w of [...(manifest.writes ?? [])].reverse()) {
        if (w.kind === 'hook-entry') continue; // entries loop above owns these (precise delete, never file-delete)
        if (w.kind === 'argv') continue;
        if (w.kind === 'rtk-init') continue; // rtk pre-pass above owns these
        // owned:false = 宿主文件（写入时已存在，owned 真值）——卸载不整删；
        // marker-section 走下方剥节路径（owned 只决定剥空后是否删文件）。
        if (w.owned === false && w.kind !== 'marker-section') {
          warnings.push(`清单记为非 WAO 所建（写入时宿主文件已存在），未整删：${w.path}`);
          continue;
        }
        const existing = readText(w.path);
        if (existing == null) continue;
        if (w.kind === 'marker-section') {
          try {
            const r = stripSectionToFile(existing, bot.id, w.owned !== false);
            if (r.changed) {
              if (r.deleted) unlinkSync(w.path);
              else atomicWrite(w.path, r.text);
              removedAny = true;
            }
          } catch (err) {
            warnings.push(`标记节剥离失败 ${w.path}: ${err?.message ?? err}`);
          }
          continue;
        }
        if (/SKILL\.md$/.test(w.path) && !/^\s*x-wao-asset:\s*\S+/m.test(existing)) {
          warnings.push(`技能文件已被外部改写，未删除：${w.path}`);
          continue;
        }
        unlinkSync(w.path);
        removedAny = true;
        cleanupEmptyParents(w.path, allowedRootsOf(bot));
      }
      try { rmSync(dirname(manifestFileOf(bot.id)), { recursive: true, force: true }); } catch { /* best effort */ }
      lg.info?.(`materializer: removeAssets bot ${bot.id} → removed=${removedAny}${warnings.length > 0 ? ` warnings=${warnings.length}` : ''}`);
      return { removed: removedAny, ...(warnings.length > 0 ? { warnings } : {}) };
    },

    // §3.5 只读回验: rebuild every product in memory and diff against disk.
    // Returns {drift, orphans, foreignMarkers} — never writes.
    async verify(bot, plan) {
      const result = await planWrites(bot, plan, { dryRun: true }).catch((err) => ({ error: err?.message ?? String(err) }));
      if (result?.error != null) return { error: result.error, drift: [], orphans: [] };
      const drift = [];
      const orphans = [];
      for (const w of result.writes ?? []) {
        // rtk-init: the products belong to the rtk binary (no deterministic
        // rebuild to diff against) — verify skips it, §7.1 state rides
        // manifest.tools instead.
        if (w?.kind === 'argv' || w?.kind === 'rtk-init' || typeof w?.target !== 'string') continue;
        const actual = readText(w.target);
        let expected;
        if (w.kind === 'file-create') expected = String(w.content ?? '');
        else if (w.kind === 'marker-section') {
          try {
            expected = spliceMarkerSection(actual ?? '', { botId: bot.id, format: w.format, content: String(w.content ?? '') }).text;
          } catch (err) {
            orphans.push({ path: w.target, detail: err?.message ?? String(err) });
            continue;
          }
        } else if (w.kind === 'hook-entry') {
          try {
            expected = `${JSON.stringify(upsertJsonEntry(JSON.parse(actual ?? 'null'), w.pointer, w.content), null, 2)}\n`;
          } catch {
            drift.push({ path: w.target, expected: '合法 JSON', actual: (actual ?? '').slice(0, 200) });
            continue;
          }
        }
        if (actual !== expected) drift.push({ path: w.target, expected: expected.slice(0, 200), actual: (actual ?? '<缺失>').slice(0, 200) });
      }
      // stale manifest rows: paths we own on the manifest but no longer plan.
      // owned:false file rows are host files (not ours to flag); a marker-
      // section row is an orphan only while OUR markers still sit in the file
      // (a stripped host file legitimately remains — owned 真值).
      const manifest = readManifest(bot.id);
      if (manifest != null) {
        const planned = new Set((result.writes ?? []).map((w) => resolve(String(w?.target ?? ''))));
        for (const w of manifest.writes ?? []) {
          if (typeof w?.path !== 'string') continue;
          if (w?.owned === false && w?.kind !== 'marker-section') continue;
          if (!planned.has(resolve(w.path)) && existsSync(w.path)) {
            if (w?.kind === 'marker-section') {
              const text = readText(w.path);
              if (text == null || scanMarkers(text, bot.id).own.length === 0) continue;
            }
            orphans.push({ path: w.path, detail: '清单记有但当前 plan 不再覆盖（应已清理的残留）' });
          }
        }
      }
      return { drift, orphans };
    },

    // §3.1 createRunner({..., assets}): attach file targets (the runner's
    // --mcp-config/--skill/--append-system-prompt values) onto COPIES of the
    // plan entries — the plan itself stays read-only (可变引用纪律), the
    // registry's shared content objects are never mutated. SYNC and
    // manifest-driven (§3.8 is the design's own data source): the runner
    // follows the last SUCCESSFUL materialize, a missing manifest degrades to
    // the bare plan (bind receipts already reported the failure).
    targetsFor(bot, plan) {
      const manifest = readManifest(bot.id);
      const byAsset = new Map();
      const byType = new Map();
      for (const w of manifest?.writes ?? []) {
        if (w?.kind !== 'file-create' || typeof w?.path !== 'string') continue;
        if (typeof w.for === 'string' && !byAsset.has(w.for)) byAsset.set(w.for, w.path);
        if (typeof w.appliesTo === 'string' && !byType.has(w.appliesTo)) byType.set(w.appliesTo, w.path);
      }
      return (plan ?? []).map((e) => {
        const target = byAsset.get(e.assetId) ?? byType.get(e.type) ?? null;
        return target === null ? { ...e } : { ...e, target };
      });
    },

    // §3.2 startup row + T1 扫尾: manifest missing (pre-T2 skipped bindings)
    // → rematerialize ONCE with a log line; afterwards read-only verify —
    // drift is reported (doctor/rematerialize fix it), never auto-rewritten.
    async startupSweep(bots, planOf) {
      const out = { migrated: [], drift: [] };
      for (const bot of bots) {
        if (!isObject(bot)) continue;
        const plan = planOf(bot) ?? [];
        const hasManifest = readManifest(bot.id) != null;
        if (!hasManifest && plan.length > 0) {
          try {
            await this.materialize(bot, plan);
            out.migrated.push(bot.id);
            logger.info?.(`materializer: 上线迁移——bot ${bot.id} 有资产绑定但无物化清单（T1 skipped 态），已全量重物化`);
          } catch (err) {
            logger.warn?.(`materializer: 上线迁移失败 bot ${bot.id}: ${err?.message ?? err}（可用 POST /api/bots/${bot.id}/rematerialize-assets 重试）`);
          }
          continue;
        }
        if (plan.length === 0) continue;
        try {
          const v = await this.verify(bot, plan);
          if (v.error != null) {
            // W3 T2 review Minor 5: a provider port missing at boot (plugin
            // disabled) used to fall through SILENTLY here (drift+orphans both
            // empty) — name the bot and the reason, never throw.
            logger.warn?.(`materializer: bot ${bot.id} 启动回验不可用（provider 端口缺失或计划失败）：${v.error}`);
            continue;
          }
          if ((v.drift?.length ?? 0) > 0 || (v.orphans?.length ?? 0) > 0) {
            out.drift.push({ botId: bot.id, drift: v.drift ?? [], orphans: v.orphans ?? [] });
            logger.warn?.(`materializer: bot ${bot.id} 资产物化漂移（${v.drift.length} drift / ${v.orphans.length} orphan）——盘面与绑定不一致，走 wao doctor 或 POST /api/bots/${bot.id}/rematerialize-assets 修复（不自动改写）`);
          }
        } catch (err) {
          logger.warn?.(`materializer: bot ${bot.id} 启动回验异常: ${err?.message ?? err}`);
        }
      }
      return out;
    },
  };
}

// —— local helpers ——————————————————————————————————————————————————————————

// Idempotent upsert of ONE entry into the array at `pointer`: replace a
// deep-equal twin in place, else append (定序: append-only keeps determinism).
function upsertJsonEntry(doc, pointer, entry) {
  const segments = String(pointer).split('/').filter(Boolean);
  let node = doc;
  for (const seg of segments.slice(0, -1)) {
    if (!isObject(node) || !isObject(node[seg])) node[seg] = {};
    node = node[seg];
  }
  const key = segments[segments.length - 1];
  if (!Array.isArray(node[key])) node[key] = [];
  const arr = node[key];
  const same = (a) => stableStringify(a) === stableStringify(entry);
  const hit = arr.findIndex(same);
  if (hit >= 0) arr[hit] = structuredClone(entry);
  else arr.push(structuredClone(entry));
  return doc;
}

// Strip-only marker removal (§3.6 unload): drop the section and orphan debris,
// keep everything else. Refuses on foreign markers (same rules as splice).
// §3.6 tail rule: a stripped-EMPTY file goes away only when WAO created it.
function stripSection(text, botId) {
  const { own, foreign, unknownVersion } = scanMarkers(text, botId);
  if (foreign.length > 0 || unknownVersion.length > 0) {
    throw new Error(`标记节含他 bot/未知版本段（${[...foreign, ...unknownVersion].join(',')}）——请人工处置`);
  }
  const begins = own.filter((x) => x.side === 'begin');
  const ends = own.filter((x) => x.side === 'end');
  const lines = text.split('\n');
  let out = lines;
  let changed = false;
  if (begins.length === 1 && ends.length === 1) {
    const [from, to] = [begins[0].index, ends[0].index];
    out = [...lines.slice(0, from), ...lines.slice(Math.max(from, to) + 1)];
    changed = true;
  } else if (begins.length === 1 || ends.length === 1) {
    out = lines.slice(0, (begins[0] ?? ends[0]).index);
    changed = true;
  }
  out = out.filter((l) => !MARKER_RE.test(l.trim()));
  return { text: out.join('\n').replace(/^\n+/, '').replace(/\n+$/, '\n'), changed };
}

// stripSection → {changed, text, deleted} with the empty-file tail rule.
function stripSectionToFile(text, botId, owned) {
  const r = stripSection(text, botId);
  if (!r.changed) return r;
  if (r.text.trim() === '') return { changed: true, deleted: owned, text: owned ? '' : r.text };
  return { changed: true, deleted: false, text: r.text };
}

// Delete a file's parent dirs while they are EMPTY, never climbing past
// `stops` (absolute resolved roots that must survive, e.g. the bot cwd).
function cleanupEmptyParents(file, stops = []) {
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (stops.map((s) => resolve(s)).includes(resolve(dir))) break;
    let entries;
    try { entries = statSync(dir).isDirectory() ? readdirSync(dir) : []; } catch { break; }
    if (entries.length > 0) break;
    // rmdirSync is the exact primitive here: removes an EMPTY directory and
    // refuses a non-empty one (rmSync recursive:false throws EISDIR on any dir).
    try { rmdirSync(dir); } catch { break; }
    dir = parent;
  }
}
