#!/usr/bin/env bash
# test/ui-shot.sh (M3 T5) — harness 截图工作流固化（改 UI 红线的工具面）。
#
# 一条命令产出全部页面插件 harness 基线截图到 test/ui-shots/（提交进库）：
#   - ui-workbench 六页（workbench/bots/session/push/plugins/timeline）× 浅/深
#   - ui-office3d  Magpie iso/2d × 浅/深
#   - ui-office-studio 白棚 × 浅
#   - template-page demo × 浅（脚手架示例）
#   - 边界基线 ×4：workbench 空态/错误态、office 空态/错误态（浅色）
#
# 为什么 CDP 而不是 chrome --screenshot：真实控制台页有 SSE（EventSource），
# --virtual-time-budget 会与长连接互卡；这里统一走「常驻无头 Chrome + CDP
# WebSocket」——Emulation.setEmulatedMedia 精确设 prefers-color-scheme（浅/深
# 各一张，不依赖系统外观），真实时钟等待页面/动画稳定后 captureScreenshot。
# harness 页用 wao-stub（无 SSE），但同一条路径也适用于真控制台页。
#
# 用法（改完页面后必跑，看图后随代码一起提交）：
#   bash test/ui-shot.sh          # 或 test/ui-shot.sh
# 可调环境变量：WAO_SHOT_PORT（默认 18798）、CHROME（默认 Mac Chrome 路径）、
#   OUT_DIR（默认 test/ui-shots）、KEEP_FAILED=1（失败时保留现场日志路径打印）。
# 退出码：0 = 全部基线齐且每张 ≥5KB；1 = 有缺失/过小（CI 可 gate）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WAO_SHOT_PORT:-18798}"
CDP_PORT=$((PORT + 1))
BASE="http://127.0.0.1:${PORT}"
OUT_DIR="${OUT_DIR:-$ROOT/test/ui-shots}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
MIN_BYTES=5120 # <5KB 的 png 必是空白/残帧

[ -x "$CHROME" ] || { echo "✗ 未找到 Chrome：${CHROME}（可用 CHROME=... 覆盖）" >&2; exit 1; }
mkdir -p "$OUT_DIR"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wao-ui-shot.XXXXXX")"
DATA_DIR="$WORK/data"; CHROME_PROFILE="$WORK/chrome-profile"; DRIVER="$WORK/shot.mjs"
SERVER_LOG="$WORK/server.log"; CHROME_LOG="$WORK/chrome.log"
SERVER_PID=""; CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  sleep 0.3
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- CDP 截图驱动（重建自 T4 用过的 /tmp 脚本；ws 为仓库既装依赖） -----------
export WAO_SHOT_ROOT="$ROOT"
cat > "$DRIVER" <<'EOF'
// shot.mjs <cdpPort> <url> <out.png> <waitMs> <light|dark> — 经常驻无头
// Chrome 的 CDP 截一张：emulate prefers-color-scheme + 1280x800 视口 +
// 真实时钟等待（无 virtual-time-budget，SSE 页面同样适用）。
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [,, cdpPort, url, outFile, waitMs, scheme] = process.argv;
const require = createRequire(process.env.WAO_SHOT_ROOT + '/package.json');
const WebSocket = require('ws');
const openTarget = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (res.ok) return await res.json();
    } catch { /* chrome 还没就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CDP /json/new 就绪超时: ${url}`);
};
const target = await openTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.on('open', r));
try {
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme === 'dark' ? 'dark' : 'light' }],
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, Number(waitMs) || 2500));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(`  shot ${outFile} (${scheme})`);
} finally {
  try { ws.close(); await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`).catch(() => {}); } catch { /* best effort */ }
}
EOF

# ---- 起临时内核（tmp dataDir + 模板插件路径，让 /api/ui/template-page 可达） --
mkdir -p "$DATA_DIR"
WAO_PLUGINS_PATH="$ROOT/plugins/_template" \
  node "$ROOT/src/index.js" start --port "$PORT" --data-dir "$DATA_DIR" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# ---- 起常驻无头 Chrome（CDP） ----------------------------------------------
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  --remote-debugging-port="$CDP_PORT" about:blank > "$CHROME_LOG" 2>&1 &
CHROME_PID=$!

wait_http() { # wait_http <url> <name> <timeout_s>
  local i=0
  until curl -sf -o /dev/null "$1"; do
    i=$((i + 1))
    if [ $i -gt $(($3 * 4)) ]; then
      echo "✗ $2 未就绪：$1" >&2
      [ -s "$SERVER_LOG" ] && tail -5 "$SERVER_LOG" >&2
      [ -s "$CHROME_LOG" ] && tail -5 "$CHROME_LOG" >&2
      exit 1
    fi
    sleep 0.25
  done
}
wait_http "$BASE/healthz" "内核" 30
wait_http "http://127.0.0.1:$CDP_PORT/json/version" "Chrome CDP" 30

shot() { # shot <name> <theme> <waitMs> <query>
  local url="$BASE/$4"
  node "$DRIVER" "$CDP_PORT" "$url" "$OUT_DIR/$1-$2.png" "$3" "$2"
}

echo "· ui-workbench 六页 × 浅/深"
for page in workbench bots session push plugins timeline; do
  for theme in light dark; do
    shot "ui-workbench-$page" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=$page"
  done
done

echo "· ui-office3d Magpie iso/2d × 浅/深"
for theme in light dark; do
  shot "ui-office3d-iso" "$theme" 5500 "api/ui/ui-office3d/harness.html?dim=iso"
  shot "ui-office3d-2d" "$theme" 5500 "api/ui/ui-office3d/harness.html?dim=2d"
done

echo "· ui-office-studio 白棚 × 浅"
shot "ui-office-studio" light 4000 "api/ui/ui-office-studio/harness.html"

echo "· template-page demo"
shot "template-page-demo" light 2200 "api/ui/template-page/harness.html"

echo "· 边界基线（空态/错误态 = 断服 fetch 失败文案，浅色）"
shot "ui-workbench-workbench-empty" light 2600 "api/ui/ui-workbench/harness.html?page=workbench&state=empty"
shot "ui-workbench-workbench-error" light 2600 "api/ui/ui-workbench/harness.html?page=workbench&state=error"
shot "ui-office3d-iso-empty" light 4000 "api/ui/ui-office3d/harness.html?state=empty"
shot "ui-office3d-iso-error" light 4000 "api/ui/ui-office3d/harness.html?state=error"

# ---- 校验：22 张基线全部存在且 ≥5KB ----------------------------------------
# 注意：set -u 下 $VAR 紧跟全角字符（如「）」）会被当成变量名一部分，
# 因此这里一律用 ${VAR} 括起来。
EXPECTED="
ui-workbench-workbench-light
ui-workbench-workbench-dark
ui-workbench-bots-light
ui-workbench-bots-dark
ui-workbench-session-light
ui-workbench-session-dark
ui-workbench-push-light
ui-workbench-push-dark
ui-workbench-plugins-light
ui-workbench-plugins-dark
ui-workbench-timeline-light
ui-workbench-timeline-dark
ui-office3d-iso-light
ui-office3d-iso-dark
ui-office3d-2d-light
ui-office3d-2d-dark
ui-office-studio-light
template-page-demo-light
ui-workbench-workbench-empty-light
ui-workbench-workbench-error-light
ui-office3d-iso-empty-light
ui-office3d-iso-error-light
"
fails=0
for name in $EXPECTED; do
  f="$OUT_DIR/$name.png"
  if [ ! -f "$f" ]; then
    echo "✗ 缺失 $name.png"; fails=$((fails + 1))
  elif [ "$(stat -f%z "$f")" -lt "$MIN_BYTES" ]; then
    echo "✗ 过小(<${MIN_BYTES}B) $name.png"; fails=$((fails + 1))
  fi
done
if [ "$fails" -gt 0 ]; then
  [ -n "${KEEP_FAILED:-}" ] && echo "现场保留：$WORK" && trap - EXIT || true
  echo "✗ $fails 张基线不合格（${OUT_DIR}）" >&2
  exit 1
fi
echo "✓ 22 张基线齐备 → $OUT_DIR"
