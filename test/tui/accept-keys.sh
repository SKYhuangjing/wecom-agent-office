#!/usr/bin/env bash
# W2 T2 真机验收（隔离内核，绝不碰生产 8792）：
#   1. 起一个临时内核（fake provider/channel 插件 + 一名 enabled 员工）
#   2. 用 pty（script(1)）驱动 `wao tui` 的真实键位流：
#        空格 → y（调休）→ 空格 → y（返岗）→ t → 回车（默认探针）→ esc → q
#   3. 断言三件事：
#        - 抓帧里出现确认行/绿字反馈/岗前测试结果窗（code: completed）
#        - /api/agents 的 enabled 真实翻转了两次（true→false→true）
#        - 终端还原（script 正常退出码）
# 依赖：node、curl、script(1)（macOS/Linux 自带）。产物：build/accept-keys/ 下
# 的抓帧与逐断言输出，进任务报告。
set -u
cd "$(dirname "$0")/../.."

OUT="build/accept-keys"
rm -rf "$OUT"; mkdir -p "$OUT/fakes" "$OUT/data"
WORK="$(pwd)/$OUT"
PORT=$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})")
BASE="http://127.0.0.1:$PORT"
FAILURES=0

say()  { printf '%s\n' "$*"; }
ok()   { say "  ✔ $*"; }
bad()  { say "  ✘ $*"; FAILURES=$((FAILURES+1)); }

check() { # check <描述> <抓帧文本> <grep 正则>
  if printf '%s' "$2" | grep -qE "$3"; then ok "$1"; else bad "$1（帧中未匹配 /$3/）"; fi
}

# —— 隔离内核的 fake 端口（与 test/mcp/tools.test.js 同款形状）———————————
mkdir -p "$OUT/fakes/channel-fake" "$OUT/fakes/provider-fake"
cat > "$OUT/fakes/channel-fake/plugin.js" <<'EOF'
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter() {
        return {
          pushes: [], start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {},
          push(chatRef, text) { this.pushes.push({ chatRef, text }); },
        };
      },
    });
  },
};
EOF
printf '{"type":"module"}\n' > "$OUT/fakes/channel-fake/package.json"
cat > "$OUT/fakes/provider-fake/plugin.js" <<'EOF'
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }],
      validate: (c) => (typeof c?.cwd === 'string' && c.cwd !== '' ? [] : ['cwd is required']),
      materializeConfig() { return { changed: true }; },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, onEvent }) {
            if (onEvent) onEvent({ type: 'text', text: '好的：' + prompt });
            return { ok: true, code: 'completed', finalText: 'fake 完成：' + prompt, aborted: false, sessionId: sessionId || 'session-fake-acc1', reason: null, detail: { exitCode: 0 } };
          },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
      describeError: (r) => 'fake error: ' + (r?.code ?? 'unknown'),
    });
  },
};
EOF
printf '{"type":"module"}\n' > "$OUT/fakes/provider-fake/package.json"

cat > "$OUT/data/bots.json" <<'EOF'
{ "bots": [ { "id": "acc1", "name": "验收员工", "enabled": true, "channel": "fakechan", "account": { "endpoint": "http://fake.local" }, "provider": "fakeprov", "providerConfig": { "cwd": "/tmp" }, "allowedUsers": [] } ] }
EOF

say "== W2 T2 真机验收：隔离内核 ${BASE}（生产 8792 不受影响） =="

WAO_PLUGINS_PATH="$OUT/fakes" node src/index.js start --port "$PORT" --data-dir "$OUT/data" > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null' EXIT

for i in $(seq 1 50); do curl -sf "$BASE/api/state" > /dev/null 2>&1 && break; sleep 0.2; done
if ! curl -sf "$BASE/api/state" > /dev/null 2>&1; then
  say "内核没起来，server.log："; tail -5 "$OUT/server.log"; exit 1
fi
ok "隔离内核就绪（pid ${SERVER_PID}，端口 ${PORT}）"
curl -s "$BASE/api/agents" | grep -q '"enabled":true' && ok "初始态：验收员工在册（enabled:true）" || bad "初始态 /api/agents 不对"

# —— pty 驱动真实 TUI 键位流 ————————————————————————————————————————————
# macOS BSD script: `script -q file cmd...`；Linux util-linux: `script -q -c cmd file`
run_script() { # run_script <capture> <cmd...>
  local capture="$1"; shift
  if [ "$(uname)" = "Darwin" ]; then /usr/bin/script -q "$capture" "$@"; else script -qec "$*" "$capture"; fi
}

KEYS=''
step() { KEYS="$KEYS printf '$1'; sleep $2;"; }
step ' '    1.0   # 空格：确认行「确认将 验收员工 调休？」
step 'y'    1.5   # y：执行 toggle（enabled → false）
step ' '    1.0   # 空格：这次是返岗确认
step 'y'    1.5   # y：执行 toggle（enabled → true）
step 't'    0.8   # t：底部输入行
step '\r'   2.5   # 回车：默认探针「回复：收到」→ 结果窗
step '\x1b' 0.6   # esc：关结果窗
step 'q'    0.8   # q：退出还原终端

say "== 键位流：空格 y 调休 → 空格 y 返岗 → t 回车(默认探针) → esc → q =="
eval "{ sleep 1.6;$KEYS }" | run_script "$OUT/frames.log" node src/index.js tui --port "$PORT" --data-dir "$OUT/data"
TUI_RC=$?
say "script 退出码：${TUI_RC}（0=终端正常还原）"
[ "$TUI_RC" -eq 0 ] && ok "TUI 会话正常退出（终端已还原）" || bad "TUI 退出码 $TUI_RC"

# —— 抓帧断言（剥离 ANSI）———————————————————————————————————————————————
FRAMES=$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/\x1b\][^\x07]*\x07//g; s/\r//g' "$OUT/frames.log")
say "== 抓帧断言 =="
check "空格弹出确认行（确认将 验收员工 调休）" "$FRAMES" '确认将 验收员工 调休？\(y/n\)'
check "y 后绿字反馈（已调休）"               "$FRAMES" '已调休：验收员工'
check "第二次确认（返岗）"                   "$FRAMES" '确认将 验收员工 返岗？\(y/n\)'
check "返岗绿字反馈"                         "$FRAMES" '已返岗：验收员工'
check "t 弹出输入行（默认探针提示）"          "$FRAMES" '岗前测试 · 验收员工——测试问题'
check "回车执行后结果窗 code: completed"      "$FRAMES" 'code: completed  ✅ 通过'
check "结果窗展示 fake 回复"                 "$FRAMES" 'fake 完成：回复：收到'
check "结果窗展示 sessionId"                 "$FRAMES" '会话：session-fake-acc1'
check "esc 关窗回到仪表盘（键位栏复现）"       "$FRAMES" '↑↓选择 空格:调休/返岗'

# —— 状态翻转的服务端核对 ————————————————————————————————————————————————
say "== /api/agents 状态核对 =="
FINAL=$(curl -s "$BASE/api/agents")
printf '%s' "$FINAL" | grep -q '"enabled":true' && ok "两次 toggle 后 enabled 回到 true（true→false→true 全程真实生效）" || bad "最终态不对：$FINAL"
if grep -q 'detached (bot disabled)' "$OUT/server.log" && [ "$(grep -c 'bot acc1 attached' "$OUT/server.log")" -ge 2 ]; then
  ok "服务端日志见证两次翻转：detached (bot disabled) → attached"
else
  bad "服务端日志没有 toggle 事件（detached/attached 缺席）"
fi

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "全部断言通过 ✔（抓帧与日志：$OUT/frames.log、$OUT/server.log）"
  exit 0
fi
say "有 $FAILURES 项断言未通过 ✘（细节见上，抓帧：$OUT/frames.log）"
exit 1
