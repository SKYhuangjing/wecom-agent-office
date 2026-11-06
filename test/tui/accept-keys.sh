#!/usr/bin/env bash
# W2 T2+T3 真机验收（隔离内核，绝不碰生产 8792）：
#   1. 起一个临时内核（fake provider/channel 插件 + 一名 enabled 员工 +
#      预置一条台账行，fake channel 的 push 会落到 FAKE_PUSH_LOG 供断言）
#   2. 用 pty（script(1)）驱动 `wao tui` 的真实键位流，四条链路：
#        a) 空格 → y（调休）→ 空格 → y（返岗）→ t → 回车（默认探针）→ esc → q
#        b) b →（台账）选 fakechat:room1 → 输入内容 → y 确认 → q
#           （断言 fake channel 收到 push：chatRef + 内容逐字落盘）
#        c) n → 逐字段入职向导（姓名/岗位/cwd/botId/Secret → 摘要 y）→ q
#           （断言 bots.json 落盘：enabled=false + account 逐键核对）
#        d) l 日志半屏：26 行终端下前后两跑对照（5 行 ↔ ≥10 行标记）
#   3. rc=0 + 抓帧断言 + /api/agents 状态核对 + 终端还原（script 退出码）
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
# accountSchema 用 botId+secret（对齐 channel-wecom 的形状）：入职向导按
# schema 键组装 account，端点式 schema 会让向导入职永远过不了校验。
# push() 落盘 FAKE_PUSH_LOG：广播链的「fake channel 真实收到」断言读它
# （adapter 的进程内数组出不了内核进程）。
mkdir -p "$OUT/fakes/channel-fake" "$OUT/fakes/provider-fake"
cat > "$OUT/fakes/channel-fake/plugin.js" <<'EOF'
import { appendFileSync } from 'node:fs';
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [
        { key: 'botId', label: 'Bot ID', type: 'string', required: true },
        { key: 'secret', label: 'Secret', type: 'password', required: true },
      ],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter() {
        return {
          pushes: [], start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {},
          push(chatRef, text) {
            this.pushes.push({ chatRef, text });
            if (process.env.FAKE_PUSH_LOG) {
              try { appendFileSync(process.env.FAKE_PUSH_LOG, `${JSON.stringify({ chatRef, text })}\n`); } catch { /* 断言侧兜底 */ }
            }
          },
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
{ "bots": [ { "id": "acc1", "name": "验收员工", "enabled": true, "channel": "fakechan", "account": { "botId": "wb-acc-0001", "secret": "fake-secret-acc1" }, "provider": "fakeprov", "providerConfig": { "cwd": "/tmp" }, "allowedUsers": [] } ] }
EOF

# 预置一条台账行（完整 §3 字段形状）：b 广播链的「目标会话」从这里来。
mkdir -p "$OUT/data/ledger"
cat > "$OUT/data/ledger/acc1.jsonl" <<'EOF'
{"seq":1,"chatKey":"fakechat:room1","channel":"fakechan","chatKind":"group","chatid":"room1","userid":"u-lead","user":"早会提醒","assistant":"收到","provider":"fakeprov","sessionId":"session-fake-acc1","ok":true,"reason":"completed","tokens":10,"cost":0,"at":"2026-11-07T02:00:00.000Z"}
EOF

say "== W2 T2 真机验收：隔离内核 ${BASE}（生产 8792 不受影响） =="

FAKE_PUSH_LOG="$WORK/pushes.jsonl" WAO_PLUGINS_PATH="$OUT/fakes" node src/index.js start --port "$PORT" --data-dir "$OUT/data" > "$OUT/server.log" 2>&1 &
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

# —— 抓帧断言（剥离 ANSI）———————————————————————————————————————————————————
# node 侧剥 ANSI/OSC/CR（BSD sed 不认 \x1b）；last_frame 取「末帧」——按
# 键位栏切段，最后一段即退出前的完整帧（l 半屏对照用它数日志行）。
strip_ansi() { node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, ""));
' "$1"; }
last_frame() { node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
  const parts = text.split("↑↓选择 空格:调休/返岗");
  // 键位栏是每帧最后一行：末段只是退出序列，倒数第二段才是末帧内容。
  if (parts.length < 2) process.exit(0);
  process.stdout.write(parts[parts.length - 2]);
' "$1"; }
FRAMES=$(strip_ansi "$OUT/frames.log")
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

# —— W2 T3 增补键位流：b 广播链 / n 入职向导 / l 日志半屏 —————————————————
# 固定尺寸跑法（l 半屏要确定性行数）：wrapper 先 stty 再 exec，两平台通用。
cat > "$OUT/tui-26x90.sh" <<EOF
#!/usr/bin/env bash
stty rows 26 cols 90 2>/dev/null || true
exec node "$(pwd)/src/index.js" tui --port "$PORT" --data-dir "$WORK/data"
EOF
chmod +x "$OUT/tui-26x90.sh"

# —— b：广播链（台账 → 选会话 → 内容 → 确认 → fake channel 真实收到）————
say "== 键位流 b：广播（选 fakechat:room1 → 内容 → y 确认 → push 落盘）=="
KEYS=''
step 'b'    1.6   # b：查台账 → 目标会话选择窗
step '\r'   1.0   # 回车：选 fakechat:room1 → 内容输入行
step '全体注意：十分钟后台演练' 1.0   # 逐字进内容行
step '\r'   1.0   # 回车 → 二次确认行（真实发送确认）
step 'y'    1.8   # y：POST /api/send → fake channel push → FAKE_PUSH_LOG
step 'q'    0.8
eval "{ sleep 1.6;$KEYS }" | run_script "$OUT/frames-bcast.log" node src/index.js tui --port "$PORT" --data-dir "$OUT/data"
BCAST_RC=$?
[ "$BCAST_RC" -eq 0 ] && ok "b 流 TUI 正常退出（终端还原）" || bad "b 流退出码 $BCAST_RC"
FRAMES_B=$(strip_ansi "$OUT/frames-bcast.log")
say "== b 流抓帧断言 =="
check "b 弹出目标会话选择窗"         "$FRAMES_B" '广播 · 选择目标会话（验收员工）'
check "台账行成为选项（fakechat:room1（1 轮））" "$FRAMES_B" 'fakechat:room1（1 轮）'
check "选中后进内容输入行"           "$FRAMES_B" '广播到 fakechat:room1——内容：'
check "逐字输入的内容回显"           "$FRAMES_B" '全体注意：十分钟后台演练'
check "回车后二次确认行"             "$FRAMES_B" '将真实发送到该员工的渠道会话，确认？\(y/n\)'
check "y 后绿字广播回执"             "$FRAMES_B" '📢 已广播：验收员工 → fakechat:room1'
say "== b 流 fake channel 侧断言（FAKE_PUSH_LOG）=="
if [ -s "$OUT/pushes.jsonl" ] && grep -q '"chatRef":"fakechat:room1"' "$OUT/pushes.jsonl" && grep -q '全体注意：十分钟后台演练' "$OUT/pushes.jsonl"; then
  ok "fake channel 收到 push（chatRef=fakechat:room1，内容逐字一致）：$(cat "$OUT/pushes.jsonl")"
else
  bad "FAKE_PUSH_LOG 里没有这次广播（内容：$OUT/pushes.jsonl）"
fi

# —— n：入职向导全流（逐字段 → 摘要 y → bots.json 落盘）———————————————————
say "== 键位流 n：入职向导（新同学 → fakeprov → /tmp/wao-hire → wb-hire-001 → secret → y）=="
KEYS=''
step 'n'    1.8   # n：查 /api/ports → 向导第 0 步（姓名）
step '新同学' 0.8
step '\r'   0.8   # 回车 → 第 1 步：岗位选择
step '\r'   1.0   # 回车：选 fakeprov（唯一在册岗位）→ 第 2 步 cwd
step '/tmp/wao-hire' 0.8
step '\r'   0.8   # → 第 3 步 botId
step 'wb-hire-001' 0.8
step '\r'   0.8   # → 第 4 步 secret（打码）
step 'fake-secret-881' 0.8
step '\r'   1.2   # → 第 5 步：摘要确认
step 'y'    2.0   # y：POST /api/bots → 入职回执
step 'q'    0.8
eval "{ sleep 1.6;$KEYS }" | run_script "$OUT/frames-hire.log" node src/index.js tui --port "$PORT" --data-dir "$OUT/data"
HIRE_RC=$?
[ "$HIRE_RC" -eq 0 ] && ok "n 流 TUI 正常退出（终端还原）" || bad "n 流退出码 $HIRE_RC"
FRAMES_N=$(strip_ansi "$OUT/frames-hire.log")
say "== n 流抓帧断言 =="
check "n 进向导（第 0 步姓名行）"      "$FRAMES_N" '入职向导（esc 取消）'
check "逐字输入姓名"                  "$FRAMES_N" '▸ 姓名：新同学'
check "第 1 步岗位选择（fakeprov）"    "$FRAMES_N" '选择岗位（技能部门）'
check "第 2 步 cwd 回显"              "$FRAMES_N" '工位（cwd）：/tmp/wao-hire'
check "第 3 步 botId 回显"            "$FRAMES_N" '机器人 ID（botId）：wb-hire-001'
check "第 4 步 secret 打码（≥10 个＊）"  "$FRAMES_N" '＊＊＊＊＊＊＊＊＊＊'
check "摘要：已填回显（＊＊＊＊（已填））" "$FRAMES_N" '＊＊＊＊（已填）'
if printf '%s' "$FRAMES_N" | grep -qF 'fake-secret-881'; then
  bad "secret 明文出现在抓帧里（必须只显示打码）"
else
  ok "secret 全程不回显明文（抓帧仅见打码）"
fi
check "摘要：姓名/岗位/工位"          "$FRAMES_N" '姓名：新同学'
check "摘要：岗位 fakeprov（工位）"    "$FRAMES_N" '岗位：fakeprov（工位 /tmp/wao-hire）'
check "摘要：通道 + botId + Secret"   "$FRAMES_N" '通道：fakechan（机器人 ID wb-hire-001，Secret 已填）'
check "摘要：调休入职提示"            "$FRAMES_N" '入职后先调休'
check "摘要：门禁未配置警示（醒目）"    "$FRAMES_N" '门禁：未配置=接受任何企微用户发消息'
check "摘要确认行"                  "$FRAMES_N" '确认 办理入职？\(y/n\)'
check "y 后入职回执（工牌号 hr-）"    "$FRAMES_N" '已入职：新同学（工牌号 hr-'
check "入职回执同步门禁警示"          "$FRAMES_N" '门禁：未配置=接受任何企微用户发消息'
say "== n 流落盘断言（bots.json 逐键核对）=="
HIRE_CHECK=$(node -e '
  const bots = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).bots;
  const b = (bots ?? []).find((x) => x?.name === "新同学");
  if (b == null) { console.log("MISSING"); process.exit(0); }
  const errs = [];
  if (b.enabled !== false) errs.push("enabled!==false");
  if (b.channel !== "fakechan") errs.push("channel");
  if (b.provider !== "fakeprov") errs.push("provider");
  if (b.account?.botId !== "wb-hire-001") errs.push("account.botId");
  if (b.account?.secret !== "fake-secret-881") errs.push("account.secret");
  if (b.providerConfig?.cwd !== "/tmp/wao-hire") errs.push("providerConfig.cwd");
  if (!/^hr-[a-z0-9]{6,}$/.test(String(b.id))) errs.push("badge id");
  console.log(errs.length === 0 ? "OK" : "BAD:" + errs.join(","));
' "$WORK/data/bots.json")
case "$HIRE_CHECK" in
  OK) ok "bots.json 新员工逐键一致（enabled:false / fakechan / fakeprov / account.botId / account.secret / cwd / hr- 工牌号）" ;;
  *)   bad "bots.json 新员工核对失败（$HIRE_CHECK）" ;;
esac
curl -s "$BASE/api/agents" | grep -q '"name":"新同学"' && ok "/api/agents 在册新同学" || bad "/api/agents 没有新同学"

# —— l：日志半屏切换（26 行终端，前后两跑对照：默认 5 行 ↔ 放大 ≥10 行）———
say "== 键位流 l：日志窗 5 行 ↔ 半屏（先灌 30 条标记行，两跑各数末帧）=="
seed_markers() { for i in $(seq -w 1 30); do printf 'WAO-LOG-MARK-%s 巡检标记行\n' "$i" >> "$WORK/data/logs/wao.log"; done; }
KEYS=''; step 'q' 0.8
seed_markers
eval "{ sleep 2.2;$KEYS }" | run_script "$OUT/frames-log-5.log" "$OUT/tui-26x90.sh"
LOG5_RC=$?
[ "$LOG5_RC" -eq 0 ] && ok "l 对照跑 A（不按 l）正常退出" || bad "l 跑 A 退出码 $LOG5_RC"
MARK5=$(last_frame "$OUT/frames-log-5.log" | grep -oE 'WAO-LOG-MARK-[0-9]+' | sort -u | wc -l | tr -d ' ')
[ "$MARK5" -eq 5 ] && ok "默认日志窗恰 5 行标记（实测 ${MARK5}）" || bad "默认窗应 5 行标记，实测 ${MARK5}"
KEYS=''; step 'l' 1.4; step 'q' 0.8
seed_markers
eval "{ sleep 2.0;$KEYS }" | run_script "$OUT/frames-log-half.log" "$OUT/tui-26x90.sh"
LOGH_RC=$?
[ "$LOGH_RC" -eq 0 ] && ok "l 切换跑 B（按 l）正常退出" || bad "l 跑 B 退出码 $LOGH_RC"
MARKH=$(last_frame "$OUT/frames-log-half.log" | grep -oE 'WAO-LOG-MARK-[0-9]+' | sort -u | wc -l | tr -d ' ')
if [ "$MARKH" -ge 10 ] && [ "$MARKH" -le 12 ]; then
  ok "l 后日志窗放大到半屏（预算 23 行→窗 11 行，实测 ${MARKH} 条标记）"
else
  bad "l 后应 ≥10 行标记（半屏），实测 ${MARKH}"
fi

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "全部断言通过 ✔（抓帧与日志：$OUT/frames.log、$OUT/server.log）"
  exit 0
fi
say "有 $FAILURES 项断言未通过 ✘（细节见上，抓帧：$OUT/frames.log）"
exit 1
