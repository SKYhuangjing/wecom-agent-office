#!/usr/bin/env bash
# test/ui-shot.sh (M3 T5) — harness 截图工作流固化（改 UI 红线的工具面）。
#
# 一条命令产出全部页面插件 harness 基线截图到 test/ui-shots/（提交进库）：
#   - ui-workbench 三页（v2 导航收敛：overview/robots/settings）× 浅/深
#     + 总览卡片视图（?view=cards）与详情 tab 基线（robots&tab=tools/settings）
#     + 向导两视图（?select=new&step=3 配发装备 / step=5 通信渠道）× 浅/深
#     + 设置页 AI 操作 section（?section=ai，v2 MCP/Skill 引导）× 浅/深
#     + AI 工具清单展开态（?section=ai&ai-tools=1，浅）
#     + 设置页其余 section（?section=system 系统信息）与内嵌装备台
#       （?view=equip&bot=bot-2，含警示条/私发快照）× 浅/深
#   - ui-office3d  Magpie iso/2d × 浅/深（插件自带 harness，不占导航）
#   - ui-office-studio 白棚 × 浅
#   - template-page demo × 浅（脚手架示例）
#   - 边界基线 ×4：overview 空态/错误态、office 空态/错误态（浅色）
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
// shot.mjs <cdpPort> <url> <out.png> <waitMs> <light|dark> [scrollToSel] — 经常驻
// 无头 Chrome 的 CDP 截一张：emulate prefers-color-scheme + 1280x800 视口 +
// 真实时钟等待（无 virtual-time-budget，SSE 页面同样适用）。可选 scrollToSel：
// 截图前把该 CSS 选择器的首元素 scrollIntoView（基线在首屏以下的区块用）。
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [,, cdpPort, url, outFile, waitMs, scheme, scrollToSel] = process.argv;
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
  if (scrollToSel) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(scrollToSel)})?.scrollIntoView()`,
    });
    await new Promise((r) => setTimeout(r, 400));
  }
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

shot() { # shot <name> <theme> <waitMs> <query> [scrollToSel]
  local url="$BASE/$4"
  node "$DRIVER" "$CDP_PORT" "$url" "$OUT_DIR/$1-$2.png" "$3" "$2" "${5:-}"
}

echo "· ui-workbench 三页（v2 导航收敛）× 浅/深"
for page in overview robots settings; do
  for theme in light dark; do
    shot "ui-workbench-$page" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=$page"
  done
done

echo "· ui-workbench 总览卡片视图 / 机器人详情 tab 基线 × 浅/深"
for theme in light dark; do
  shot "ui-workbench-overview-cards" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=overview&view=cards"
  shot "ui-workbench-robots-tools" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=robots&select=bot-2&tab=tools"
  shot "ui-workbench-robots-settings" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=robots&select=main-bot&tab=settings"
done
# 引擎配置区（2026-11-10 UI 治理）：bot-2=claude，滚动到第 3 组钉「结构化
# 模型编辑器」——model 不再是手写 JSON textarea（用户在 PC1 真机提出的困惑）。
shot "ui-workbench-robots-engine" light 2800 "api/ui/ui-workbench/harness.html?page=robots&select=bot-2&tab=settings" "section.wb-group:nth-of-type(3)"

echo "· ui-workbench 入职向导（第 3 步配发装备 / 第 5 步通信渠道）× 浅/深"
for theme in light dark; do
  shot "ui-workbench-wizard-equip" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=robots&select=new&step=3"
  shot "ui-workbench-wizard-channel" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=robots&select=new&step=5"
done

echo "· ui-workbench 设置页（AI 操作 section + 系统信息 section + 内嵌装备台）× 浅/深"
for theme in light dark; do
  shot "ui-workbench-settings-ai" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=settings&section=ai"
  shot "ui-workbench-settings-system" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=settings&section=system"
  shot "ui-workbench-settings-equip" "$theme" 2800 "api/ui/ui-workbench/harness.html?page=settings&view=equip&bot=bot-2"
done
shot "ui-workbench-settings-ai-tools" light 2800 "api/ui/ui-workbench/harness.html?page=settings&section=ai&ai-tools=1" ".ai-tools"

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
shot "ui-workbench-overview-empty" light 2600 "api/ui/ui-workbench/harness.html?page=overview&state=empty"
shot "ui-workbench-overview-error" light 2600 "api/ui/ui-workbench/harness.html?page=overview&state=error"
shot "ui-office3d-iso-empty" light 4000 "api/ui/ui-office3d/harness.html?state=empty"
shot "ui-office3d-iso-error" light 4000 "api/ui/ui-office3d/harness.html?state=error"

# ---- 校验：基线全部存在且 ≥5KB ----------------------------------------
# 注意：set -u 下 $VAR 紧跟全角字符（如「）」）会被当成变量名一部分，
# 因此这里一律用 ${VAR} 括起来。
EXPECTED="
ui-workbench-overview-light
ui-workbench-overview-dark
ui-workbench-overview-cards-light
ui-workbench-overview-cards-dark
ui-workbench-robots-light
ui-workbench-robots-dark
ui-workbench-robots-tools-light
ui-workbench-robots-tools-dark
ui-workbench-robots-settings-light
ui-workbench-robots-settings-dark
ui-workbench-robots-engine-light
ui-workbench-settings-light
ui-workbench-settings-dark
ui-workbench-settings-ai-light
ui-workbench-settings-ai-dark
ui-workbench-settings-ai-tools-light
ui-workbench-settings-system-light
ui-workbench-settings-system-dark
ui-workbench-settings-equip-light
ui-workbench-settings-equip-dark
ui-workbench-wizard-equip-light
ui-workbench-wizard-equip-dark
ui-workbench-wizard-channel-light
ui-workbench-wizard-channel-dark
ui-office3d-iso-light
ui-office3d-iso-dark
ui-office3d-2d-light
ui-office3d-2d-dark
ui-office-studio-light
template-page-demo-light
ui-workbench-overview-empty-light
ui-workbench-overview-error-light
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
echo "✓ 33 张基线齐备 → $OUT_DIR"
