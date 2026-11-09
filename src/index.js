#!/usr/bin/env node
// wao entry (spec §1 startup sequence, §2.5 stop, §8 kernel-native API):
// a thin CLI (start/doctor/version) over the createKernel library function.
// Boot order is deliberate: the exclusive data-dir lock is claimed before
// anything creates files (a second instance leaves no side effects), then
// logger → services → bus → http shell → lifecycle, plugin activation, the
// afterAllActivated batch, and only then the HTTP listener — a busy port
// fails the boot before anything serves traffic.
import process from 'node:process';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from './kernel/log.js';
import { atomicWrite, lockDataDir, readJson, writeJson } from './kernel/config.js';
import { createEventBus } from './kernel/events.js';
import { createServices } from './kernel/services.js';
import { createHttpShell, sendFile, fileUnder } from './kernel/http.js';
import { createLifecycle } from './kernel/lifecycle.js';
import * as loader from './kernel/loader.js';
import { runTUI } from './tui.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataDir = () => process.env.WAO_HOME || join(process.cwd(), 'data');

// 开机自启动的键名/注册表键（createKernel 的 autostart API 与 doctor 共用）。
const AUTOSTART_LABEL = 'com.wecom-agent-office';
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// 读用户级 Run 键里 wao 的启动命令；值不存在返回 null，reg 本身不可用才抛。
const winRunValue = () => {
  let out;
  try {
    out = execFileSync('reg', ['query', WIN_RUN_KEY, '/v', AUTOSTART_LABEL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err?.status === 1 || err?.code === 1) return null; // reg query：值不存在时退出码 1
    throw err;
  }
  const m = /REG_SZ\s+(.+)/.exec(out);
  return m ? m[1].trim() : null;
};

// 本机局域网地址自发现（纯函数，供状态面、AI 操作端点与日志 banner 呈现）：
// 获取所有非 internal 的 IPv4 地址与本地主机名，方便跨机访问。
export function getLanAddresses() {
  const ips = [];
  try {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (!info.internal && info.family === 'IPv4') ips.push(info.address);
      }
    }
  } catch { /* best effort */ }
  let hname = '';
  try { hname = hostname(); } catch { /* best effort */ }
  return { hostname: hname, lanIps: ips };
}

// win32 自启动启动器（纯函数，test/ops/autostart-win.test.js 锁内容）。登录时
// Run 键的 cwd 是 System32、PATH 未必含 node——启用一刻把绝对路径全部烘焙进
// cmd：cd 到仓库根、--data-dir 钉死数据目录、stdout/stderr 追加到数据目录日志
//（boot 失败也留痕）。CRLF 是 cmd 解释器的行要求。
export function buildWinAutostartCmd({ execPath, repoRoot: root, dataDir, lan = false }) {
  const q = (p) => `"${p}"`;
  // Windows 分隔符显式拼接：本函数可能在非 win32 上被调用（生成/测试），
  // path.join 在那里会产出正斜杠，混进 cmd 文件不伦不类。
  const w = (...p) => p.join('\\');
  const lanFlag = lan ? ' --lan' : '';
  return [
    '@echo off',
    `cd /d ${q(root)}`,
    `if not exist ${q(w(dataDir, 'logs'))} mkdir ${q(w(dataDir, 'logs'))}`,
    `${q(execPath)} ${q(w(root, 'src', 'index.js'))} start --data-dir ${q(dataDir)}${lanFlag} >> ${q(w(dataDir, 'logs', 'autostart.log'))} 2>&1`,
    '',
  ].join('\r\n');
}

// 当前 Commit 探测：优先读 data/version.json（更新器/打包写入），
// 其次探测本地 .git（开发模式），再次取 $WAO_COMMIT 环境变量，无则 null。
export function getCurrentCommit(dataDir) {
  try {
    const vf = join(dataDir ?? defaultDataDir(), 'version.json');
    if (existsSync(vf)) {
      const v = JSON.parse(readFileSync(vf, 'utf8'));
      if (typeof v?.commit === 'string' && v.commit) return v.commit.slice(0, 7);
    }
  } catch { /* best effort */ }
  try {
    const gitDir = join(repoRoot, '.git');
    if (existsSync(gitDir)) {
      const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000,
      });
      if (out && out.trim()) return out.trim();
    }
  } catch { /* best effort */ }
  if (process.env.WAO_COMMIT) return process.env.WAO_COMMIT.slice(0, 7);
  return null;
}

// 检查 GitHub 远程最新 Commit（跨平台、免登录公共 API，带超时与限流保护）
export async function checkRemoteUpdate(currentCommit) {
  const GITHUB_REPO = 'SKYhuangjing/wecom-agent-office';
  const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
  let remote = null;
  let error = null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'WAO-Updater/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const sha = typeof data?.sha === 'string' ? data.sha.slice(0, 7) : null;
      const msg = typeof data?.commit?.message === 'string' ? data.commit.message.split('\n')[0].trim() : '';
      const date = data?.commit?.committer?.date ?? data?.commit?.author?.date ?? null;
      remote = { sha, message: msg, date };
    } else if (res.status === 403) {
      error = 'GitHub API 访问达到频率限制（请稍后重试）';
    } else {
      error = `GitHub 应答异常（HTTP ${res.status}）`;
    }
  } catch (err) {
    error = `无法连接 GitHub（${err.message || '网络超时'}）`;
  }
  // currentCommit 未知（zip 首装、无 version.json/.git/WAO_COMMIT）时也放行为
  // 可更新——首次升级会写入 version.json，之后的比对就走正常路径。
  const hasUpdate = Boolean(remote?.sha && (!currentCommit || remote.sha !== currentCommit));
  return {
    currentCommit,
    currentVersion: pkgVersion(),
    remoteCommit: remote?.sha ?? null,
    commitMessage: remote?.message ?? null,
    commitDate: remote?.date ?? null,
    hasUpdate,
    error,
    checkedAt: Date.now(),
  };
}

// Repo-bundled plugins first, then operator extras from WAO_PLUGINS_PATH
// (path.delimiter-separated — ':' on POSIX, ';' on Windows —; empty segments
// dropped) — the §2.1 scan rule.
export const defaultPluginsDirs = () => {
  const dirs = [join(repoRoot, 'plugins')];
  for (const extra of (process.env.WAO_PLUGINS_PATH ?? '').split(delimiter)) if (extra !== '') dirs.push(extra);
  return dirs;
};

const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
};

// Orphan sweep (M3 ops hardening): stop()'s four phases already abort every
// run and every runner escalates SIGTERM→SIGKILL — but the drain windows are
// bounded (5s each), and a run whose SIGKILL escalation outlives them (or a
// provider that ignores its abort signal entirely) still holds a LIVE CLI
// child when the service exits: an orphan holding session write-locks with
// nobody left to reap it. The sweep is the last line before exit: enumerate
// this process's direct children (exactly what the runners spawned — pgrep
// excludes itself), confirm each is dead, and SIGKILL any survivor. Success
// is silent; only action/failure narrates. Assembly-layer on purpose (entry
// owns process lifetime, kernel modules stay child-free). Library caveat:
// createKernel's stop() sweeps the EMBEDDING process's direct children too —
// SIGKILLing any child the host itself spawned — so this is CLI-specific
// semantics; hosts embedding the kernel with children of their own must not
// lean on stop() untouched. pgrep is a macOS given here; where it is missing
// the sweep degrades to a warn, never throws.
export const sweepOrphanChildren = async ({ pid = process.pid, log, execFileFn = execFile } = {}) => {
  const say = (level, msg) => { (log?.[level] ?? (() => {}))(msg); };
  const list = await new Promise((resolve) => {
    execFileFn('pgrep', ['-P', String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        // pgrep exit 1 = no children matched (the happy norm); ENOENT = this
        // platform has no pgrep — degrade loudly, the sweep is best-effort.
        // A timeout (killed=true) is a different animal: pgrep EXISTS but did
        // not answer — say so, "unavailable" would send the operator hunting
        // for a missing binary that is right there.
        if (err.code === 1) return resolve([]);
        if (err.killed) say('warn', 'stop: orphan sweep skipped (pgrep timed out after 2000ms)');
        else say('warn', `stop: orphan sweep skipped (pgrep unavailable: ${err.code ?? err.message})`);
        return resolve(null);
      }
      resolve(String(stdout).split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  });
  if (list == null) return;
  const alive = (childPid) => {
    try { process.kill(childPid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
  };
  const survivors = list.filter(alive);
  if (survivors.length === 0) return;
  say('warn', `stop: orphan sweep — ${survivors.length} live child process(es) after teardown (${survivors.join(', ')}), SIGKILL`);
  for (const childPid of survivors) {
    try { process.kill(childPid, 'SIGKILL'); } catch (e) {
      if (e?.code !== 'ESRCH') say('error', `stop: orphan sweep kill ${childPid} failed: ${e?.code ?? e?.message}`);
    }
  }
  // Bounded re-confirmation: a SIGKILLed process can linger a beat as a
  // zombie until reaped; a survivor past this window is loudly an error.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && survivors.some(alive)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const childPid of survivors) {
    if (alive(childPid)) say('error', `stop: orphan sweep — pid ${childPid} survived SIGKILL`);
  }
};

// Library entry: wires every kernel module and returns the kernel object.
// stop() is the whole teardown story — library callers own it explicitly;
// only the CLI additionally maps SIGINT/SIGTERM onto it.
// `token` (P1 auth, DESIGN §13 预留接口): defaults to $WAO_TOKEN; a non-empty
// value gates every non-public HTTP path behind Bearer/X-WAO-Token (see
// kernel/http.js). Empty/unset = loopback no-auth, unchanged.
export async function createKernel({ port = 8792, host = '127.0.0.1', dataDir, pluginsDirs, log, token, lan = false, allowedHosts = null } = {}) {
  const isLanMode = lan === true || host === '0.0.0.0' || process.env.WAO_LAN === '1';
  const dir = dataDir ?? defaultDataDir();
  // data/ is owner-only (DESIGN §3/§13): bots.json/ledger/sessions carry
  // secrets and conversation content. Create the dir 0700, and tighten an
  // existing dir whose perms are looser — best-effort, a chmod failure (odd
  // mount, read-only FS) must not fail boot over a permission ambition.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch { /* best-effort by design */ }
  const lock = lockDataDir(dir); // throws "data dir locked by pid N" for a live second instance
  const logger = log ?? createLogger({
    file: join(dir, 'logs', 'wao.log'),
    level: process.env.WAO_LOG_LEVEL || 'info',
  });
  const roots = pluginsDirs ?? defaultPluginsDirs();

  const services = createServices();
  const events = createEventBus({ log: logger });
  // web/dist is a committed build artifact (M3): the console exists even on a
  // fresh clone with no build step. A missing dir just means GET / 404s —
  // boot never depends on the console being present.
  const webDir = join(repoRoot, 'web', 'dist');
  // P1 auth (see createKernel doc): $WAO_TOKEN by default. Set-but-empty is
  // called out loudly — the operator asked for a gate and got none.
  const authToken = token ?? process.env.WAO_TOKEN ?? '';
  if (token == null && process.env.WAO_TOKEN === '') {
    logger.warn('wao: WAO_TOKEN is set but empty — auth stays disabled');
  }
  const http = createHttpShell({
    log: logger, webDir,
    auth: authToken !== '' ? { token: authToken } : null,
    lan: isLanMode,
    allowedHosts,
    // P2 /healthz enrichment: version always; bots summary when an 'engine'
    // service (core-engine) is live — read per probe so reloads stay current.
    healthExtra: () => {
      const out = { version: pkgVersion() };
      const engineSvc = services.get('engine');
      if (engineSvc != null && typeof engineSvc.summary === 'function') {
        out.bots = engineSvc.summary();
      }
      return out;
    },
  });
  // SSE bridge (DESIGN §8 /api/events): the bus topics the UI may see are
  // forwarded verbatim to every live SSE client. The whitelist IS the list —
  // the bus has no wildcards, so a plugin cannot smuggle a new topic onto the
  // wire by emitting it. Kernel-lifetime subscription (never unsubscribed).
  for (const topic of ['agent/progress', 'agent/status', 'run/start', 'run/end',
    'ledger/turn', 'service/state', 'plugin/lifecycle']) {
    events.on(topic, (payload) => http.sseSend(topic, payload));
  }
  const lifecycle = createLifecycle({ events, services, log: logger, http });
  const portRegistry = lifecycle.portRegistry;
  // Kernel-assembly facts for plugins (core-engine reads both at activate):
  // the shared port registry and the data dir are kernel-level state — reached
  // through the service container instead of a new ctx surface.
  services.register('ports', portRegistry);
  services.register('paths', { dataDir: dir });
  services.register('network', { getLanAddresses, isLanMode, host, port });

  const startedAt = Date.now();
  const uptimeSec = () => Math.round((Date.now() - startedAt) / 1000);
  let lastLoad = { active: [], failed: [] };
  let lastDisabled = []; // {id,type,version} — plugins the enable table filtered out
  let knownPluginIds = new Set(); // every manifest id ever discovered (incl. disabled/failed)
  let lastFound = []; // discover() snapshot: {dir,id,manifest} — ui hosting input
  // Page-plugin ui roots (M3, DESIGN §9): plugins whose manifest declares
  // `ui: '<dir>'` AND ship <dir>/index.js get that dir hosted at
  // /api/ui/<id>/*. Rebuilt on every load pass, so reload/deactivate drops a
  // vanished plugin's hosting with it (same lifetime as its ports).
  const uiRoots = () => {
    const activeIds = new Set(lastLoad.active.map((a) => a.id));
    const out = [];
    for (const { id, dir, manifest } of lastFound) {
      if (id == null || !activeIds.has(id)) continue;
      const rel = manifest?.ui;
      if (typeof rel !== 'string' || rel === '') continue;
      const uiDir = resolve(dir, rel);
      if (!existsSync(join(uiDir, 'index.js'))) continue;
      out.push({ id, dir: uiDir });
    }
    return out;
  };
  const uiPlugins = () => uiRoots().map(({ id }) => ({ id, entry: `/api/ui/${id}/index.js` }));

  // Snapshot view of the last activateAll batch: /api/state, /api/plugins and
  // status() answer from a copy, never from loader state a concurrent reload
  // could be mid-mutating. Disabled plugins are LISTED (status 'disabled')
  // rather than omitted — the UI must be able to show what to re-enable.
  const pluginList = () => [
    ...lastLoad.active.map(({ id, name, type, version }) => ({ id, name, type, version, status: 'active' })),
    // The loader's error copy attributes with an id prefix; the entry carries
    // `id` right beside it, so the prefix is stripped here — "stray: failed —
    // stray: import failed" reads the id twice; once is enough. A failed
    // import may leave no readable manifest: name stays null then.
    ...lastLoad.failed.map(({ id, error }) => ({
      id, status: 'failed',
      error: typeof error === 'string' && error.startsWith(`${id}: `) ? error.slice(id.length + 2) : error,
    })),
    ...lastDisabled.map((d) => ({ ...d, status: 'disabled' })),
  ];

  // Scan the roots for plugin dirs. The manifest id is read through the same
  // cache-busted import the loader uses, so an enabled plugin's module top
  // level evaluates once per mtime (the loader's second import hits the
  // module cache). Honest tradeoff, not a guarantee: this import runs for
  // EVERY candidate dir — including plugins the enable table then filters
  // out, so a disabled plugin's module top level still evaluates, and no
  // timeout guards imports (the loader's 10s bound covers activate, not
  // import): a disabled plugin with a hanging top-level await blocks boot
  // and reload. `_`-prefixed dirs are scaffolding (_template), `.`-prefixed
  // are not plugins; an unimportable dir is kept so activateAll records the
  // failure instead of the plugin vanishing silently from every report.
  const discover = async () => {
    const found = [];
    for (const root of roots) {
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; } // missing root = no plugins there (yet)
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        const pluginDir = join(root, ent.name);
        let manifest = null;
        try { manifest = (await loader.importPlugin(pluginDir)).manifest ?? null; } catch { /* import failure surfaces via activateAll */ }
        found.push({ dir: pluginDir, id: manifest?.id ?? null, manifest });
      }
    }
    return found;
  };

  // Shared by boot and reload: the enable table in plugins.json is data and
  // is re-read every pass (never cached), disabled dirs are filtered out
  // before the loader ever sees them, and each enabled plugin receives its
  // options as ctx.config (DESIGN §2.6: `{enabled, options}` — `enabled` is
  // consumed here, `options` belongs to the plugin).
  const loadPlugins = async () => {
    const table = readJson(join(dir, 'plugins.json'))?.plugins ?? {};
    const enabled = (id) => !(table[id] && table[id].enabled === false);
    const found = await discover();
    lastFound = found;
    knownPluginIds = new Set(found.filter(({ id }) => id != null).map(({ id }) => id));
    lastDisabled = found
      .filter(({ id }) => id != null && !enabled(id))
      .map(({ id, manifest }) => ({ id, name: manifest?.name ?? null, type: manifest?.type, version: manifest?.version }));
    const dirs = found.filter(({ id, dir: d }) => enabled(id ?? basename(d))).map((f) => f.dir);
    const pluginConfig = {};
    for (const { id } of found) if (id != null && enabled(id)) pluginConfig[id] = table[id]?.options ?? {};
    lastLoad = await loader.activateAll({ dirs, lifecycle, portRegistry, pluginConfig, log: logger });
    return lastLoad;
  };

  // Kernel-native API (§8), registered directly on the shell — not a plugin,
  // so they survive every reload and exist even with zero plugins loaded.
  http.register({
    prefix: '/api/state', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      const lanInfo = getLanAddresses();
      json(res, 200, {
        ok: true, uptimeSec: uptimeSec(), pid: process.pid, dataDir: dir,
        port: http.port, host, lanMode: isLanMode,
        lanIps: lanInfo.lanIps, hostname: lanInfo.hostname,
        plugins: pluginList(), uiPlugins: uiPlugins(),
      });
    },
  });
  // Page-plugin static hosting (DESIGN §9): /api/ui/<id>/<file> serves the
  // ui/ dir a plugin's manifest declared, kernel-native so it exists even
  // mid-reload quirks and wins dispatch over core-engine's shorter '/api'.
  // Every path goes through fileUnder — traversal attempts are plain 404s.
  http.register({
    prefix: '/api/ui/', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch {
        return json(res, 404, { error: 'not found' });
      }
      const m = /^\/api\/ui\/([^/]+)\/(.*)$/.exec(pathname);
      if (m == null) return json(res, 404, { error: 'not found' });
      const root = uiRoots().find(({ id }) => id === m[1])?.dir;
      if (root == null) return json(res, 404, { error: 'not found' });
      const file = fileUnder(root, m[2]);
      if (file == null) return json(res, 404, { error: 'not found' });
      return sendFile(res, file);
    },
  });
  http.register({
    prefix: '/api/plugins', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      json(res, 200, { plugins: pluginList() });
    },
  });
  http.register({
    prefix: '/api/service/reload', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      // Returned promise: the shell's dispatch wrapper turns a rejection into
      // an attributed 500 instead of an unhandled crash.
      return reload().then(() => json(res, 200, { ok: true }));
    },
  });
  // 开机自启动（用户指令：设置里的开关，不替客户选择——开关只读写真实系统
  // 配置，永不预选）。只切「随系统启动」：macOS=LaunchAgent 的 RunAtLoad，
  // Linux=systemd --user enable/disable，Windows=用户级注册表 Run 键；写完即
  // 生效于下次登录/开机，当前进程与 KeepAlive（崩溃自愈）均不受影响——切换
  // 零服务中断。
  const autostartStatus = () => {
    if (process.platform === 'darwin') {
      const file = join(homedir(), 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
      if (!existsSync(file)) {
        return { supported: true, installed: false, enabled: false, mechanism: 'launchd',
          detail: `未安装 LaunchAgent——按 docs/launchd.plist 模板安装到 ${file} 后可切换` };
      }
      const enabled = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(readFileSync(file, 'utf8'));
      return { supported: true, installed: true, enabled, mechanism: 'launchd' };
    }
    if (process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['--user', 'is-enabled', AUTOSTART_LABEL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { supported: true, installed: true, enabled: true, mechanism: 'systemd (user)' };
      } catch (err) {
        const out = String(err?.stdout ?? err?.stderr ?? '').trim();
        if (/disabled/.test(out)) return { supported: true, installed: true, enabled: false, mechanism: 'systemd (user)' };
        if (/not[- ]found|no such/i.test(out)) return { supported: true, installed: false, enabled: false, mechanism: 'systemd (user)',
          detail: '未安装 wao 用户服务——按 docs/wao.service 模板安装后可切换' };
        return { supported: true, installed: false, enabled: false, mechanism: 'systemd (user)', detail: `systemctl 不可用：${out || '无输出'}` };
      }
    }
    if (process.platform === 'win32') {
      // Run 键两态：值在=已启用（指向启用时生成的 data/win-autostart.cmd），
      // 值不在=未启用。系统原生支持无需外部安装模板（installed: true）。
      // 只管登录拉起；KeepAlive/崩溃自愈语义仍属 NSSM（README §3.1）。
      const val = winRunValue();
      if (val == null) {
        return { supported: true, installed: true, enabled: false, mechanism: 'registry Run (user)',
          detail: '未启用（随用户登录启动，仅登录拉起，无崩溃自愈）' };
      }
      return { supported: true, installed: true, enabled: true, mechanism: 'registry Run (user)', detail: val };
    }
    return { supported: false, installed: false, enabled: false, mechanism: null,
      detail: '当前平台暂不支持（支持 macOS launchd、Linux systemd 用户服务与 Windows 注册表 Run 键）' };
  };
  const setAutostart = (enabled) => {
    if (process.platform === 'darwin') {
      const file = join(homedir(), 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
      if (!existsSync(file)) { const err = new Error('未安装 LaunchAgent（docs/launchd.plist），无法切换'); err.status = 409; throw err; }
      let text = readFileSync(file, 'utf8');
      const tag = `<key>RunAtLoad</key>\n    <${enabled}/>`;
      if (/<key>RunAtLoad<\/key>\s*<(?:true|false)\s*\/>/.test(text)) {
        text = text.replace(/<key>RunAtLoad<\/key>\s*<(?:true|false)\s*\/>/, tag);
      } else {
        text = text.replace(/<\/dict>/, `    ${tag}\n</dict>`);
      }
      atomicWrite(file, text);
      return;
    }
    if (process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['--user', enabled ? 'enable' : 'disable', AUTOSTART_LABEL], { stdio: 'ignore' });
        return;
      } catch (err) { err.status = 409; throw err; }
    }
    if (process.platform === 'win32') {
      // 启用：生成启动器（烘焙绝对路径）+ 写用户级 Run 键（免管理员）；禁用：
      // 删值，值本就不缺视为已达目标态（幂等），reg 真不可用才 409。
      if (enabled) {
        // launcher 与 dataDir 都钉成绝对路径：dir 可为相对（默认 cwd/data），
        // 登录时 Run 键的 cwd 是 System32，相对路径会落到别处/找不到 cmd。
        const absDataDir = resolve(dir);
        const launcher = join(absDataDir, 'win-autostart.cmd');
        atomicWrite(launcher, buildWinAutostartCmd({
          execPath: process.execPath, repoRoot, dataDir: absDataDir, lan: isLanMode,
        }));
        execFileSync('reg', ['add', WIN_RUN_KEY, '/v', AUTOSTART_LABEL, '/t', 'REG_SZ', '/d', launcher, '/f'], { stdio: 'ignore' });
      } else {
        try {
          execFileSync('reg', ['delete', WIN_RUN_KEY, '/v', AUTOSTART_LABEL, '/f'], { stdio: 'ignore' });
        } catch (err) {
          if (winRunValue() != null) { err.status = 409; throw err; }
        }
      }
      return;
    }
    const err = new Error('当前平台暂不支持开机自启动配置'); err.status = 400; throw err;
  };
  const readServiceBody = (req, limit = 1 << 16) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  http.register({
    prefix: '/api/service/autostart', owner: 'kernel', handler: (req, res) => {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...autostartStatus() });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
      return readServiceBody(req).then((raw) => {
        let enabled;
        try { enabled = JSON.parse(raw.toString('utf8') || '{}')?.enabled; } catch { /* fall through */ }
        if (typeof enabled !== 'boolean') return json(res, 400, { error: 'enabled 必须为布尔值' });
        setAutostart(enabled);
        return json(res, 200, { ok: true, ...autostartStatus() });
      }).catch((err) => {
        if (err?.status) return json(res, err.status, { error: err.message });
        throw err;
      });
    },
  });

  // 全平台在线更新与自适应平滑重启接口（GET 检查 / POST 触发升级）：
  // 1. 下载目标代码包并解压校验
  // 2. 识别宿主环境托管机制（macOS launchd / Linux systemd / 通用 detached updater）
  // 3. 派生独立更新器 scripts/updater.js 覆写代码并重新拉起服务
  // 4. 原进程优雅关闭并释放端口与目录锁
  const detectRestartMode = () => {
    if (process.platform === 'darwin') {
      const file = join(homedir(), 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
      if (existsSync(file)) return 'launchd';
    } else if (process.platform === 'linux') {
      const unit = join(homedir(), '.config', 'systemd', 'user', 'wao.service');
      if (existsSync(unit)) return 'systemd';
    }
    return 'detached';
  };

  http.register({
    prefix: '/api/service/update', owner: 'kernel', handler: async (req, res) => {
      if (req.method === 'GET') {
        const cur = getCurrentCommit(dir);
        const info = await checkRemoteUpdate(cur);
        return json(res, 200, { ok: true, ...info });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });

      try {
        const cur = getCurrentCommit(dir);
        const check = await checkRemoteUpdate(cur);
        const targetCommit = check.remoteCommit || '';
        if (!targetCommit) {
          return json(res, 503, { ok: false, error: `无法确定远程最新 Commit（${check.error ?? 'GitHub 不可达'}），稍后重试` });
        }

        // 零停机架构：主进程只派生更新器并立即应答——下载在更新器里做（无 HTTP
        // 超时压力，慢网络可跑数分钟），旧服务全程在线；下载完成那一刻更新器才
        // 杀旧进程、覆写、重启。停机窗口 = 覆写+重启 ≈ 十几秒。
        const restartMode = detectRestartMode();
        const updaterScript = join(repoRoot, 'scripts', 'updater.js');
        const updaterArgs = [
          updaterScript,
          '--zip-url', 'https://codeload.github.com/SKYhuangjing/wecom-agent-office/zip/refs/heads/main',
          '--parent-pid', String(process.pid),
          '--target-dir', repoRoot,
          '--data-dir', dir,
          '--port', String(http.port),
          '--host', host,
          '--restart-mode', restartMode,
          '--target-commit', targetCommit,
        ];
        if (isLanMode) updaterArgs.push('--lan');

        const child = spawn(process.execPath, updaterArgs, {
          detached: true,
          stdio: 'ignore',
          cwd: repoRoot,
          env: process.env,
        });
        child.unref();

        logger.info(`wao: update delegated to detached updater (mode=${restartMode}, targetCommit=${targetCommit}), updater pid=${child.pid} — service stays up during download`);
        return json(res, 200, {
          ok: true,
          message: '后台更新已启动：新版本下载完成后服务将短暂重启（十几秒），页面就绪后自动刷新',
          restartMode,
          targetCommit,
        });
      } catch (err) {
        logger.error('wao: update failed', err);
        return json(res, 500, { ok: false, error: err.message || String(err) });
      }
    },
  });
  // Plugin runtime enable/disable (DESIGN §8 kernel-native): body-less POST
  // flips the enable table in plugins.json (atomic read-modify-write, other
  // options preserved) and drives the four-phase reload — disable of a core
  // plugin goes through the same drain→teardown→rescan path, so the engine
  // drain obligation chain fires. Longer prefix than any plugin's '/api', so
  // it wins dispatch over core-engine's catch-all.
  http.register({
    prefix: '/api/plugins/', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const m = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(pathname);
      if (m == null) return json(res, 404, { error: 'not found' });
      let id = m[1];
      try { id = decodeURIComponent(id); } catch { /* keep raw */ }
      // Reload chains with any in-flight one; the response carries the NEW list.
      return setPluginEnabled(id, m[2] === 'enable')
        .then((plugins) => json(res, 200, { ok: true, plugins }))
        .catch((err) => {
          if (err?.status === 404) return json(res, 404, { error: err.message });
          throw err; // shell-attributed 500, unchanged
        });
    },
  });

  // Four-phase reload (§2.5): drain → reverse teardown → rescan+activate →
  // afterAllActivated. loadPlugins re-reads plugins.json inside phase ③.
  const doReload = async ({ drainTimeoutMs = 5000 } = {}) => {
    await lifecycle.fourPhase({ drainTimeoutMs, reloadFn: loadPlugins });
    // The port set changed (§2.5): notify subscribers (core-engine reconcile).
    events.emit('plugin/lifecycle', { ids: lastLoad.active.map((a) => a.id) });
    return { active: [...lastLoad.active], failed: [...lastLoad.failed] };
  };
  // Reloads are serialized through a chain: fourPhase is not reentrant, and
  // two overlapping POSTs (or a POST racing a library reload()) would
  // interleave their teardown/activation halves on the shared lifecycle —
  // double activation and "prefix already registered" showing up as a false
  // `failed` entry. Each caller awaits its own link's outcome; the chain
  // itself swallows rejections so one bad reload cannot wedge the queue.
  let reloadChain = Promise.resolve();
  const reload = (opts) => {
    const link = reloadChain.then(() => doReload(opts));
    reloadChain = link.then(() => {}, () => {});
    return link;
  };

  // Plugin enable/disable as ONE operation (W1 T2): flips the enable table in
  // plugins.json (atomic read-modify-write, other options preserved) and
  // drives the four-phase reload. Both the kernel-native /api/plugins/:id
  // route and the mcp-gateway toggle_plugin tool call this same function
  // — no duplicated logic, no HTTP self-calls. Unknown plugin → status-404
  // error (the route turns it into its historical 404 shape).
  const setPluginEnabled = async (id, enabled) => {
    if (!knownPluginIds.has(id)) {
      const err = new Error(`unknown plugin: ${id}`);
      err.status = 404;
      throw err;
    }
    const file = join(dir, 'plugins.json');
    const doc = readJson(file) ?? {};
    const plugins = { ...((doc != null && typeof doc === 'object' && !Array.isArray(doc)) ? doc.plugins : {}) };
    plugins[id] = { ...plugins[id], enabled };
    writeJson(file, { ...(doc ?? {}), plugins });
    await reload();
    return pluginList();
  };

  // Kernel operations published to plugins through the service container
  // (same broker as 'ports'/'paths', W1 T2): mcp-gateway's list_plugins /
  // toggle_plugin / get_state tools consume these. Read per call by
  // the consumer, so a reload's fresh closures are always current.
  services.register('kernelOps', { plugins: pluginList, setPluginEnabled, uptimeSec });

  let stopped = false;
  const stop = async ({ closeTimeoutMs = 5000 } = {}) => {
    if (stopped) return; // SIGINT then SIGTERM: the second signal must not re-run teardown
    stopped = true;
    // Phase-1-only stop semantics: drain while channels are still up, then
    // reverse-deactivate, close the listener, release the data-dir lock. Each
    // step is individually guarded — stop must never throw, and one step's
    // failure must not skip the others. Success is narrated into the log so
    // ops can tell a graceful stop from a wedged one from the log tail alone.
    logger.info('wao: stopping (four-phase)');
    try { await lifecycle.drainEngine(5000); } catch (err) { logger.error('stop: engine drain failed', err); }
    logger.info('wao: drain done');
    try { await lifecycle.deactivateAll(); } catch (err) { logger.error('stop: deactivate failed', err); }
    logger.info('wao: plugins deactivated');
    // http.close() waits out non-idle connections: a client wedged mid-request
    // would hold stop() — and with it the lock release — hostage forever.
    // Bounded wait; on timeout destroy the remaining connections by force.
    try {
      let settled = false;
      let timer = null;
      const closing = http.close().then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([closing, new Promise((resolve) => { timer = setTimeout(resolve, closeTimeoutMs); })]);
      clearTimeout(timer); // the losing branch's timer must not linger
      if (!settled) {
        logger.warn(`stop: http close did not settle within ${closeTimeoutMs}ms, forcing connections closed`);
        await http.forceClose();
      }
    } catch (err) { logger.error('stop: http close failed', err); }
    // Orphan sweep (see sweepOrphanChildren): after the bounded four phases a
    // CLI child that outlived its kill window must not survive the process.
    try { await sweepOrphanChildren({ pid: process.pid, log: logger }); } catch (err) { logger.error("stop: orphan sweep failed", err); }
    lock.release();
    logger.info('wao: stopped (lock released)');
  };

  const status = () => ({
    running: http.port != null,
    uptimeSec: uptimeSec(),
    port: http.port,
    dataDir: dir,
    plugins: pluginList(),
  });

  try {
    await loadPlugins();
    await lifecycle.runAfterAllActivated();
    await http.listen(port, host);
  } catch (err) {
    // A failed boot must not leak: half-activated plugins are torn down and
    // the lock released, so the operator fixes the cause and starts again.
    try { await lifecycle.deactivateAll(); } catch { /* rollback must never mask the boot error */ }
    lock.release();
    if (err?.code === 'EADDRINUSE') throw new Error(`port ${port} in use (second instance?)`, { cause: err });
    throw err;
  }

  logger.info(`wao up: ${lastLoad.active.length} plugins on http://${host}:${http.port} (data: ${dir})`);
  return {
    events, services, http, lifecycle, loader, portRegistry, status, reload, stop, log: logger,
    // Not part of the library API surface: escape hatch for the CLI's
    // second-signal force exit, so a wedged teardown cannot cost the
    // operator the lock too (a released-then-leaked lock is adoptable on
    // next boot anyway — config.js's stale-holder path).
    releaseLock: lock.release,
  };
}

// --- CLI (thin on purpose: parse, delegate, exit) ---------------------------

const USAGE = 'usage: wao [start [--port N] [--host H] [--data-dir DIR] [--lan] | tui [--port N] [--host H] [--data-dir DIR] | doctor [--port N] [--host H] [--data-dir DIR] [--lan] | version]';
const pkgVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Strict parsing (reject beats silent correction): an unknown flag or a flag
// without a value is a typo'd command line, not an invitation to guess.
const parseFlags = (raw) => {
  const known = new Set(['port', 'host', 'data-dir', 'lan']);
  const flags = {};
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!arg.startsWith('--')) return { error: `unexpected argument: ${arg}` };
    const name = arg.slice(2);
    if (!known.has(name)) return { error: `unknown flag: ${arg}` };
    if (name === 'lan') {
      flags.lan = true;
      continue;
    }
    const value = raw[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
    flags[name] = value;
    i++;
  }
  return { flags };
};

const portOf = (flags, fallback) => {
  if (flags.port === undefined) return fallback;
  const n = Number(flags.port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got '${flags.port}'`);
  }
  return n;
};

// start 时刷新 win32 自启启动器（若已启用）：启用一刻烘焙的参数会随运行
// 形态漂移（11-09 真机实例：先启用自启、后开 --lan，data/win-autostart.cmd
// 仍是旧参数——重启登录即丢 LAN）。每次 start 用当前参数重写，保证「下一次
// 登录拉起」=「这一次的运行形态」。纯决策函数（依赖注入）供单测；
// dataDir 契约=绝对路径（start 传 kernel.status().dataDir，与启用路径同源），
// 路径拼接用 Windows 分隔符显式拼接（本函数可能在非 win32 上被单测调用，
// path.join 在那里会产出正斜杠）。
export function planAutostartRefresh({ platform, enabled, dataDir, lan }) {
  if (platform !== 'win32' || !enabled || !dataDir) return { write: false };
  return {
    write: true,
    path: [dataDir, 'win-autostart.cmd'].join('\\'),
    content: buildWinAutostartCmd({ execPath: process.execPath, repoRoot, dataDir, lan: lan === true }),
  };
}

const cmdStart = async (flags) => {
  const isLan = flags.lan === true || flags.host === '0.0.0.0' || process.env.WAO_LAN === '1';
  const defaultHost = isLan ? '0.0.0.0' : (process.env.WAO_HOST || '127.0.0.1');
  const host = flags.host ?? defaultHost;
  const kernel = await createKernel({
    port: portOf(flags, 8792),
    host,
    dataDir: flags['data-dir'],
    lan: isLan,
  });
  const st = kernel.status();
  const lanInfo = getLanAddresses();
  const lanNote = lanInfo.lanIps.length > 0 ? ` (LAN: ${lanInfo.lanIps.map((ip) => `http://${ip}:${st.port}`).join(', ')})` : '';
  // Through the logger (timestamped, level info, file+stderr): the boot banner
  // belongs in data/logs/wao.log like every other lifecycle fact, not on bare
  // stdout where the log tail would miss it.
  kernel.log.info(`wao v${pkgVersion()} listening on http://${host}:${st.port}${lanNote} (pid ${process.pid}, data ${st.dataDir})`);
  // win32 自启参数漂移修复：见 planAutostartRefresh 注释。best-effort，失败
  // 只记日志不阻断启动。
  try {
    const plan = planAutostartRefresh({ platform: process.platform, enabled: winRunValue() != null, dataDir: st.dataDir, lan: isLan });
    if (plan.write) {
      atomicWrite(plan.path, plan.content);
      kernel.log.info(`autostart launcher refreshed with current args (lan=${isLan})`);
    }
  } catch (err) {
    kernel.log.info(`autostart launcher refresh failed (ignored): ${err?.message ?? err}`);
  }
  // Graceful stop (§1): SIGINT/SIGTERM run the four-phase teardown, then exit.
  let signalled = false;
  const shutdown = () => {
    if (signalled) {
      // Force-exit hatch: a second signal during teardown means the operator
      // wants out now — stop() may be wedged on a hung drain/effect past its
      // own bounds. Best-effort lock release (idempotent, and a leaked lock
      // is adoptable via the stale-holder path), then exit 0 immediately.
      try { kernel.releaseLock(); } catch { /* best effort by definition */ }
      process.exit(0);
    }
    signalled = true;
    kernel.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0; // the listener keeps the process alive from here
};

// `wao tui` (W2): the ops dashboard is a CLIENT of an already-running service
// — it never boots a kernel. runTUI probes /api/state first so a missing
// service is a friendly one-liner, not a red-bar screensaver. exit:true: the
// tui loop ends on quit, and a resumed raw stdin must not keep the process
// alive the way start's listener does.
const cmdTui = (flags) => runTUI({
  port: portOf(flags, 8792),
  host: flags.host ?? '127.0.0.1',
  dataDir: flags['data-dir'],
});

// Someone answering a TCP connect = a listener is already bound; refused or
// silent = free to try (a filtered port cannot be probed — "no answer" is the
// honest report). 2s timeout so a dropping firewall cannot hang doctor.
const checkPortFree = (host, port, timeoutMs = 2000) => new Promise((settled) => {
  const sock = net.connect({ port, host });
  const done = (free) => { sock.destroy(); settled(free); };
  sock.setTimeout(timeoutMs, () => done(true));
  sock.once('connect', () => done(false));
  sock.once('error', () => done(true));
});

// PATH scan without executing anything: the first executable entry named
// `bin` wins (a `command -v` in pure node). null = not on PATH.
// Cross-platform (P2): PATH splits on the PLATFORM delimiter — a Windows
// PATH is ';'-joined and a ':' split would never match — and on Windows an
// extensionless name must be probed against PATHEXT (.COM/.EXE/…/.CMD):
// npm bin shims are .cmd files, accessSync(join(dir, 'dsh')) alone misses
// them. delim/exts are injectable so the Windows behavior is unit-testable
// on POSIX; both default to this platform's conventions.
export const whichBin = (bin, { pathEnv = process.env.PATH ?? '', delim = delimiter, exts = null } = {}) => {
  const tryExts = exts ?? (process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : ['']);
  for (const dir of pathEnv.split(delim)) {
    if (dir === '') continue;
    for (const ext of tryExts) {
      try {
        const p = join(dir, bin + ext);
        accessSync(p, constants.X_OK);
        return p;
      } catch { /* keep scanning */ }
    }
  }
  return null;
};

const cmdDoctor = async (flags) => {
  let bad = 0;
  const mark = (sym, item, detail) => {
    console.log(`${sym} ${item}: ${detail}`);
    if (sym === '✗') bad++;
  };

  // Node floor (P2-12 修正, 2026-11-07): >=22.15.0 — node:zlib gained zstd
  // (zstdDecompressSync, provider-dsh history decoding) in v23.0.0, backported
  // to v22.15.0; below that provider-dsh cannot even import (加载即失败). The
  // old 20.10 floor predated the zstd dependency and was never actually
  // exercised — the old quoted test glob ran ZERO tests on node <21.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 15)) mark('✓', 'node', `v${process.versions.node} (floor 22.15, node:zlib zstd)`);
  else mark('!', 'node', `v${process.versions.node} is below the 22.15 floor (engines >=22.15.0 — provider-dsh 需要 node:zlib zstd, 低版本加载即失败) — warn only`);

  try {
    await import('ws');
    mark('✓', 'ws', "module 'ws' resolvable");
  } catch (err) {
    mark('✗', 'ws', `'ws' not resolvable — run npm install (${err.code ?? err.message})`);
  }

  for (const root of defaultPluginsDirs()) {
    let count = 0;
    const nonEsm = [];
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && !ent.name.startsWith('_')
          && existsSync(join(root, ent.name, 'plugin.js'))) {
          count++;
          // Node <22.7 parses a .js plugin without package.json
          // {"type":"module"} as CommonJS — the loader records a load
          // failure for it. Doctor names the dir so the fix is obvious.
          let type = null;
          try { type = JSON.parse(readFileSync(join(root, ent.name, 'package.json'), 'utf8')).type; } catch { /* missing/broken package.json */ }
          if (type !== 'module') nonEsm.push(ent.name);
        }
      }
      mark('✓', 'plugins', `${count} plugin dir${count === 1 ? '' : 's'} (${root})`);
      for (const name of nonEsm) {
        mark('!', 'plugins', `${name}: plugin.js present but package.json lacks {"type":"module"} — it will fail to load`);
      }
    } catch (err) {
      mark('✗', 'plugins', `cannot scan ${root} (${err.code ?? err.message})`);
    }
  }

  const dataDir = flags['data-dir'] ?? defaultDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.doctor-probe-${process.pid}`);
    writeFileSync(probe, 'probe');
    rmSync(probe);
    mark('✓', 'data dir', `${dataDir} writable`);
  } catch (err) {
    mark('✗', 'data dir', `${dataDir} not writable (${err.code ?? err.message})`);
  }

  const host = flags.host ?? '127.0.0.1';
  const port = portOf(flags, 8792);
  const free = await checkPortFree(host, port);
  mark(free ? '✓' : '✗', 'port', free ? `${port} free on ${host}` : `port ${port} already in use`);

  // WAO_TOKEN 生效性实测 (P1): with a token configured, prove the gate on the
  // LIVE service — one probe without the header (must 401) and one with it
  // (must 200). Without a live service the check is informational: auth is a
  // runtime property of `wao start`, not of this doctor process.
  if (process.env.WAO_TOKEN !== undefined) {
    if (process.env.WAO_TOKEN === '') {
      mark('!', 'auth', 'WAO_TOKEN 设置为空——鉴权未启用（需非空值才生效）');
    } else {
      const base = `http://${host}:${port}`;
      const probe = async (headers) => {
        try {
          return await fetch(`${base}/api/state`, { headers, signal: AbortSignal.timeout(2000) });
        } catch { return null; }
      };
      const bare = await probe({});
      if (bare == null) {
        mark('!', 'auth', `WAO_TOKEN 已设置，但 ${base} 无服务应答——鉴权生效性未验证（服务启动后复跑 doctor）`);
      } else {
        const withToken = await probe({ 'x-wao-token': process.env.WAO_TOKEN });
        if (bare.status === 401 && withToken?.status === 200) {
          mark('✓', 'auth', 'WAO_TOKEN 鉴权生效（无 token → 401 / 带 token → 200）');
        } else if (bare.status === 200) {
          mark('✗', 'auth', `服务未启用鉴权（无 token 仍 200）——在跑的实例未带 WAO_TOKEN 启动，重启时注入`);
        } else if (withToken?.status === 401) {
          mark('✗', 'auth', '带 token 仍 401——本进程环境的 WAO_TOKEN 与在跑服务不一致');
        } else {
          mark('✗', 'auth', `鉴权探测异常（无 token=${bare.status} / 带 token=${withToken?.status ?? '无应答'}）`);
        }
      }
    }
  } else {
    // 本进程未 export WAO_TOKEN：明确宣告跳过，避免「doctor 没有 auth 行」被误读为检查通过。
    // 鉴权是 `wao start` 运行时属性，取令牌后复跑 doctor 才会实测 401/200。
    mark('!', 'auth', '未设 env，跳过 WAO_TOKEN 生效性实测（export WAO_TOKEN 后复跑 doctor 检查；服务侧鉴权不受本进程 env 影响）');
  }

  // Agent CLI presence is INFORMATIONAL (`!`, never ✗): a missing CLI only
  // fails that provider's runs at runtime — the /api/bots/:id/test endpoint
  // and probe.sh report it precisely; doctor just tells the operator which
  // agent CLIs this machine currently has.
  for (const cli of ['dsh', 'claude', 'codex', 'pi']) {
    const found = whichBin(cli);
    if (found != null) mark('✓', `cli ${cli}`, `present (${found})`);
    else mark('!', `cli ${cli}`, 'not found in PATH (informational — provider runs needing it will fail)');
  }

  // Claim+release probe with the REAL lock: a live holder (second instance)
  // means start would refuse — that is a failure, not a warning.
  try {
    const lock = lockDataDir(dataDir);
    lock.release();
    mark('✓', 'lock', `${dataDir} lockable (claim+release probe)`);
  } catch (err) {
    mark('✗', 'lock', `${dataDir} not lockable (${err.message})`);
  }

  // Process-manager check, dispatched per platform (P1 跨平台):
  // macOS = launchd 三态 (installed+running / not installed `!` / loaded-but-
  // dead `✗`); Linux = systemd --user is-active against the docs/wao.service
  // template; anything else (Windows…) = informational pointer to README §3.1
  // (NSSM / 任务计划程序) — no native service manager probe exists there.
  if (process.platform === 'darwin') {
    // launchd install check (M3 T6): the agent is a user LaunchAgent from the
    // docs/launchd.plist template. `!` not installed (informational — the
    // production install is the cutover's job); `✗` installed but not running
    // (a real failure for an unattended box: KeepAlive should have it up).
    // `launchctl list` line shape: "<pid>|-\t<last-status>\t<label>".
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.wecom-agent-office.plist');
    if (!existsSync(plistPath)) {
      mark('!', 'launchd', `not installed (informational — cp docs/launchd.plist ${plistPath} per its header, then launchctl load)`);
    } else {
      const [listed, lcErr] = await new Promise((resolve) => {
        execFile('launchctl', ['list'], { timeout: 3000 }, (err, stdout) => resolve([err ? null : String(stdout ?? ''), err]));
      });
      if (lcErr != null) {
        // launchctl itself failing (spawn error/timeout) says NOTHING about the
        // agent's loaded state — reporting "not loaded" here would send the
        // operator to re-load a healthy install. Informational, state unknown.
        const why = lcErr.killed ? 'timed out after 3000ms' : (lcErr.code ?? lcErr.message);
        mark('!', 'launchd', `cannot determine loaded state — launchctl list failed (${why}); check manually: launchctl list | grep com.wecom-agent-office`);
      } else {
        const m = new RegExp('^\\s*(\\d+|-)\\s+[-\\d]+\\s+com\\.wecom-agent-office\\s*$', 'm').exec(listed);
        if (m != null && m[1] !== '-') mark('✓', 'launchd', `installed and running (pid ${m[1]})`);
        else if (m != null) mark('✗', 'launchd', 'loaded but NOT running (tail the plist\'s launchd.err.log; launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office to force-restart)');
        else mark('✗', 'launchd', `installed at ${plistPath} but not loaded (launchctl load ${plistPath})`);
      }
    }
  } else if (process.platform === 'linux') {
    // Same three-state contract as launchd, against the docs/wao.service
    // user unit. `systemctl --user is-active` exits nonzero for
    // inactive/failed but still PRINTS the state — stdout decides, the exit
    // code does not.
    const unitPath = join(homedir(), '.config', 'systemd', 'user', 'wao.service');
    if (!existsSync(unitPath)) {
      mark('!', 'systemd', `not installed (informational — cp docs/wao.service ${unitPath} per its header, then systemctl --user daemon-reload && systemctl --user enable --now wao)`);
    } else {
      const [state, why] = await new Promise((resolve) => {
        execFile('systemctl', ['--user', 'is-active', 'wao.service'], { timeout: 3000 }, (err, stdout) => {
          // Nonzero exit with a printed state (inactive/failed/activating) is
          // a RESULT, not a probe failure — only a missing binary (ENOENT) or
          // timeout means "cannot determine".
          if (err != null && (err.code === 'ENOENT' || err.killed || typeof stdout !== 'string')) {
            resolve([null, err.killed ? 'timed out after 3000ms' : (err.code ?? err.message)]);
          } else {
            resolve([String(stdout ?? '').trim(), null]);
          }
        });
      });
      if (state == null) {
        mark('!', 'systemd', `cannot determine loaded state — systemctl --user is-active failed (${why}); check manually: systemctl --user status wao.service`);
      } else if (state === 'active') {
        mark('✓', 'systemd', 'installed and running (active)');
      } else {
        mark('✗', 'systemd', `installed at ${unitPath} but ${state || 'unknown'} (journalctl --user -u wao.service -n 50; systemctl --user restart wao)`);
      }
    }
  } else if (process.platform === 'win32') {
    // 注册表 Run 键两态（与 /api/service/autostart 同源）：已启用 ✓；未启用 !
    //（信息级——开关在设置页，不替客户选择）；reg 探测失败 !（状态未知，指路
    // 手查）。Run 键只管登录拉起，KeepAlive 等价物仍是 NSSM（README §3.1）。
    try {
      const val = winRunValue();
      if (val != null) mark('✓', 'autostart', `enabled (${val})`);
      else mark('!', 'autostart', 'not enabled (informational — 设置页「开机自启动」开关，或 POST /api/service/autostart {"enabled":true})');
    } catch (err) {
      mark('!', 'autostart', `cannot determine — reg query failed (${err?.message}); check manually: reg query "${WIN_RUN_KEY}" /v ${AUTOSTART_LABEL}`);
    }
  } else {
    mark('!', 'service', `no service-manager check on ${process.platform} — see README §3.1`);
  }
  // Asset drift check (DESIGN-ASSETS §8.1 P1-8, W3 T5): read-only dryRun
  // verify per bound bot — the provider planners rebuild every product in
  // memory and the core-engine materializer diffs against disk (§3.5), plus
  // the orphan scan (§3.4) and manifest diff (§3.8). Never writes; the repair
  // path is POST /api/bots/:id/rematerialize-assets. Provider plugins are
  // activated in a bare lifecycle (their activation is port registration
  // only — core-engine/bots never attach), and the planner modules come from
  // the same repo-bundled plugin dirs the kernel loads at boot, dynamically
  // imported here so doctor never maintains a second copy of the pipeline.
  try {
    const botsDoc = readJson(join(dataDir, 'bots.json'));
    const assetsDoc = readJson(join(dataDir, 'assets.json'));
    const bound = (Array.isArray(botsDoc?.bots) ? botsDoc.bots : [])
      .filter((b) => b != null && typeof b === 'object' && Array.isArray(b.assets) && b.assets.length > 0);
    if (bound.length > 0) {
      const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
      const lc = createLifecycle({ events: createEventBus({ log: silent }), services: createServices(), log: silent, http: createHttpShell({ log: silent }) });
      for (const root of defaultPluginsDirs()) {
        let entries = [];
        try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
          const dir = join(root, ent.name);
          let rec;
          try { rec = await loader.importPlugin(dir); } catch { continue; }
          if (rec.manifest?.type !== 'provider' || loader.validateManifest(rec.manifest).length > 0) continue;
          try { await lc.activate({ dir, manifest: rec.manifest, mod: rec.mod.default, status: 'enabled', config: {} }); } catch { /* unverifiable provider — the per-bot line says so */ }
        }
      }
      const { createMaterializer } = await import(pathToFileURL(join(repoRoot, 'plugins', 'core-engine', 'materializer.js')).href);
      const { buildPlan } = await import(pathToFileURL(join(repoRoot, 'plugins', 'core-engine', 'assets.js')).href);
      const materializer = createMaterializer({ ports: lc.portRegistry, dataDir, log: silent });
      const registry = Array.isArray(assetsDoc?.assets) ? assetsDoc.assets : [];
      for (const bot of bound) {
        const plan = buildPlan(registry, bot).plan;
        if (plan.length === 0) continue; // dangling bindings only — nothing on disk to verify
        const v = await materializer.verify(bot, plan);
        if (v.error != null) {
          mark('!', `assets ${bot.id}`, `回验不可用（${v.error}）`);
          continue;
        }
        const rows = [...(v.drift ?? []), ...(v.orphans ?? [])];
        if (rows.length === 0) {
          mark('✓', `assets ${bot.id}`, `无漂移（${plan.length} 项装备与盘面一致）`);
          continue;
        }
        for (const r of rows) {
          const why = r.detail != null ? r.detail : `盘面与期望不符（expected ${String(r.expected ?? '').slice(0, 80)} / actual ${String(r.actual ?? '<缺失>').slice(0, 80)}）`;
          mark('!', `assets ${bot.id}`, `漂移：${r.path} — ${why}`);
        }
        mark('!', `assets ${bot.id}`, `修复：POST /api/bots/${bot.id}/rematerialize-assets（确定性重物化，幂等可重试）`);
      }
      try { await lc.deactivateAll(); } catch { /* read-only pass — nothing to unwind */ }
    }
  } catch (err) {
    mark('!', 'assets', `漂移检查不可用（${err?.message ?? err}）`);
  }

  return bad === 0 ? 0 : 1;
};

// invokedAsScript, not import.meta.main (Node <20.11): realpath because an
// npm/link bin entry is a symlink while ESM resolves import.meta.url to the
// real path — a plain string compare would miss every linked invocation.
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (invokedAsScript) {
  const raw = process.argv.slice(2);
  const cmd = raw.find((a) => !a.startsWith('-')) ?? 'start';
  const { flags = {}, error } = parseFlags(raw.filter((a) => a !== cmd));
  const run = async () => {
    if (error) return { code: 2, err: error };
    if (cmd === 'version') { console.log(pkgVersion()); return { code: 0 }; }
    if (cmd === 'start') return { code: await cmdStart(flags) };
    if (cmd === 'tui') return { code: await cmdTui(flags), exit: true };
    if (cmd === 'doctor') return { code: await cmdDoctor(flags) };
    return { code: 2, err: `unknown command: ${cmd}` };
  };
  run().then(
    ({ code, err, exit }) => {
      if (err) { console.error(err); console.error(USAGE); }
      if (code !== 0 || exit) process.exit(code); // start: code 0 stays alive on the listener
    },
    (err) => { console.error(`wao: ${err?.message ?? err}`); process.exit(1); },
  );
}
