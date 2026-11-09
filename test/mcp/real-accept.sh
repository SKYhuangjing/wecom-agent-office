#!/usr/bin/env bash
# W1 T4 real-CLI MCP acceptance (HARD gate): a REAL kernel (isolated: tmp
# dataDir, port 18793, full repo plugins + fake channel/provider ports from
# test/mcp/tools.test.js shapes) is operated by REAL Agent CLIs over MCP —
# claude (tasks 1+2, stream-json evidence) and codex (task 1, JSONL events) —
# plus the session-recovery path (T1 leftover -32002): kernel restart kills
# the session, old id gets -32002, re-initialize recovers, and a fresh real
# CLI run works again. Production 8792 is NEVER started or touched.
#
# Usage: bash test/mcp/real-accept.sh
#   WAO_REAL_ACCEPT_KEEP=1  keep the tmp workspace (artifacts inspection)
#   WAO_REAL_ACCEPT_PORT=   override the isolated port (default 18793)
# Requires: node >=22.15, claude CLI, codex CLI (authenticated), curl.
#
# Headless tool authorization: claude runs with --dangerously-skip-permissions
# and codex with --approve-for-me (its MCP calls are blocked by the default
# never-approval policy) — both acceptable here because the target is an
# isolated loopback kernel whose only ports are fakes; noted in the task
# report. CLIs run inside the tmp workspace (zero repo context).
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${WAO_REAL_ACCEPT_PORT:-18793}
BASE="http://127.0.0.1:${PORT}"
MCP="${BASE}/mcp"
D=$(mktemp -d "/tmp/wao-real-accept.XXXXXX")
KEEP=${WAO_REAL_ACCEPT_KEEP:-0}
CLAUDE_BIN=$(command -v claude || true)
CODEX_BIN=$(command -v codex || true)

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "== $*"; }

[ -n "$CLAUDE_BIN" ] || fail "claude CLI not found in PATH"
[ -n "$CODEX_BIN" ] || fail "codex CLI not found in PATH"
[ -f "$HOME/.codex/auth.json" ] || fail "codex auth missing (~/.codex/auth.json)"
curl -s --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && fail "port $PORT already answering — another instance? (refusing to clobber)"
note "workspace: $D (claude=$CLAUDE_BIN, codex=$CODEX_BIN, port=$PORT)"

# run_with_timeout <secs> <cmd...> — plain fg waits can hang a CI box forever.
# Caller-side redirections pass straight through to the command.
run_with_timeout() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$waited" -ge "$secs" ] && { kill -9 "$pid" 2>/dev/null || true; fail "timeout after ${secs}s: $*"; }
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid"
}
# claude_run <task> <outfile> <errfile> — claude has no --cwd flag, so run it
# INSIDE the tmp workspace (zero repo context) via positional-arg bash -c.
claude_run() {
  run_with_timeout 240 bash -c 'cd "$1" && exec "$2" -p "$3" --mcp-config "$4" --output-format stream-json --verbose --dangerously-skip-permissions' \
    _ "$D" "$CLAUDE_BIN" "$1" "$D/wao.mcp.json" < /dev/null > "$2" 2> "$3"
}

boot_kernel() {
  node "$REPO_ROOT/test/mcp/real-kernel.mjs" --port "$PORT" --data-dir "$D/data" --fakes "$D/fakes" \
    >> "$D/kernel.out" 2>> "$D/kernel.err" &
  KERNEL_PID=$!
  echo "$KERNEL_PID" > "$D/kernel.pid"
  local i=0
  until tail -1 "$D/kernel.out" 2>/dev/null | grep -q 'REAL-KERNEL READY'; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { cat "$D/kernel.err" >&2; fail "kernel did not become READY"; }
    sleep 0.5
  done
}
stop_kernel() {
  [ -f "$D/kernel.pid" ] || return 0
  local pid; pid=$(cat "$D/kernel.pid")
  kill -INT "$pid" 2>/dev/null || return 0
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { kill -9 "$pid" 2>/dev/null || true; fail "kernel did not exit on SIGINT"; }
    sleep 0.5
  done
}
cleanup() {
  stop_kernel || true
  [ "$KEEP" = "1" ] && { note "KEEP=1 — workspace left at $D"; return; }
  rm -rf "$D"
}
trap cleanup EXIT

# —— Node assertion helpers (stream-json / JSONL parsing) —————————————————
cat > "$D/assert-claude.mjs" <<'EOF'
// argv: <stream-json-file> <mode: task1|task2|recovery> <extra...>
// Parses claude --output-format stream-json: MCP connection status, mcp__
// tool_use names, tool_result bodies, final result text. Prints evidence and
// asserts per mode. Exit 1 with a clear message on any violated expectation.
import { readFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
const events = readFileSync(file, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
const connected = (init?.mcp_servers ?? []).some((s) => s.name === 'wao-company' && s.status === 'connected');
const toolUses = events.flatMap((e) => (e.type === 'assistant' ? e.message?.content ?? [] : []))
  .filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, input: c.input }));
const mcpUses = toolUses.filter((u) => u.name.startsWith('mcp__wao-company__'));
const toolResults = events.flatMap((e) => (e.type === 'user' ? e.message?.content ?? [] : []))
  .filter((c) => c.type === 'tool_result')
  .map((c) => ({ id: c.tool_use_id, body: typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '') }));
const resultFor = (pred) => toolResults.filter((r) => {
  const use = toolUses.find((u) => u.id === r.id && typeof u.name === 'string' && pred(u.name));
  return use != null;
}).map((r) => r.body);
const result = events.filter((e) => e.type === 'result').at(-1);
const answer = String(result?.result ?? '');
console.log(`  [claude ${mode}] mcp server connected: ${connected}`);
console.log(`  [claude ${mode}] mcp tool_use: ${mcpUses.map((u) => u.name.replace('mcp__wao-company__', '')).join(', ') || '(none)'}`);
console.log(`  [claude ${mode}] answer: ${answer.slice(0, 400).replace(/\n/g, ' ⏎ ')}`);
const die = (m) => { console.error(`ASSERT-FAIL [claude ${mode}]: ${m}`); process.exit(1); };
if (!connected) die('init event does not show wao-company connected');
if (mcpUses.length === 0) die('no mcp__wao-company__ tool_use in the stream');
if (result?.subtype !== 'success') die(`result subtype=${result?.subtype}`);
const standalone = (n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(answer);
if (mode === 'task1') {
  if (!mcpUses.some((u) => /list_bots|get_state/.test(u.name))) die('neither list_bots nor get_state was called');
  if (!answer.includes('休假丙')) die('answer does not name the on-leave bot 休假丙');
  if (!standalone(2)) die('answer does not state 2 on-duty bots');
} else if (mode === 'task2') {
  const names = mcpUses.map((u) => u.name);
  if (!names.some((n) => /create_bot$/.test(n))) die('create_bot was never called');
  if (!names.some((n) => /test_bot/.test(n))) die('test_bot was never called');
  const probationResults = resultFor((n) => /test_bot/.test(n));
  if (probationResults.length === 0)
    die(`no tool_result paired with the test_bot call (uses=${JSON.stringify(toolUses.map((u) => ({ id: u.id, name: u.name })))} results=${JSON.stringify(toolResults.map((r) => ({ id: r.id, body: r.body.slice(0, 120) })))}`);
  if (!probationResults.some((b) => /"code"\s*:\s*"completed"/.test(b))) die('probation tool_result lacks code:"completed"');
  if (!probationResults.some((b) => b.includes('fake 完成'))) die('probation tool_result lacks the fake finalText');
  if (!answer.includes('fake 完成')) die('answer does not relay the finalText');
} else if (mode === 'recovery') {
  if (!standalone(4)) die('answer does not report 4 registered bots');
}
console.log(`  [claude ${mode}] ASSERTIONS OK`);
EOF

cat > "$D/assert-codex.mjs" <<'EOF'
// argv: <jsonl-file> — parses codex exec --json events: mcp_tool_call items
// (server wao) with completed status + last agent_message text.
import { readFileSync } from 'node:fs';
const events = readFileSync(process.argv[2], 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
const calls = items.filter((i) => i.type === 'mcp_tool_call');
const msgs = items.filter((i) => i.type === 'agent_message');
const answer = msgs.at(-1)?.text ?? '';
console.log(`  [codex] mcp_tool_call: ${calls.map((c) => `${c.tool}(${c.status})`).join(', ') || '(none)'}`);
console.log(`  [codex] answer: ${answer.slice(0, 400).replace(/\n/g, ' ⏎ ')}`);
const die = (m) => { console.error(`ASSERT-FAIL [codex]: ${m}`); process.exit(1); };
if (calls.length === 0) die('no mcp_tool_call event in the stream');
if (!calls.some((c) => /list_bots|get_state/.test(c.tool) && c.status === 'completed'))
  die('neither list_bots nor get_state completed');
if (calls.some((c) => c.status === 'failed')) die(`a tool call failed: ${JSON.stringify(calls.find((c) => c.status === 'failed').error)}`);
if (!answer.includes('休假丙')) die('answer does not name the on-leave bot 休假丙');
if (!new RegExp('(^|[^0-9])2([^0-9]|$)').test(answer)) die('answer does not state 2 on-duty bots');
console.log('  [codex] ASSERTIONS OK');
EOF

TASK1='用公司工具列出在岗员工，告诉我谁在休假、在岗（非休假）的共几人。答案里明确给出在岗人数数字。'
TASK2="给公司入职一个新员工：花名'测试员A'，工牌号 'mcp-acc'，岗位 fakeprov，工位 ${D}/work，通道 fakechan（endpoint 填 http://fake.local，secret 填 'x'），先建为调休态（enabled:false）。建好后对新员工做一次岗前测试（测试问题传：只回复：好的），把测试结果告诉我（含结果 code 与回复全文）。"

# —— L0: boot the isolated kernel ————————————————————————————————————————
note "L0 boot isolated kernel (port $PORT, tmp dataDir, repo plugins + fakes)"
boot_kernel
curl -sf "$BASE/healthz" | grep -q '"ok":true' || fail "healthz not ok"
curl -sf "$BASE/api/state" | grep -q '"id":"mcp-gateway","name":"MCP 网关","type":"middleware"[^}]*"status":"active"' \
  || fail "mcp-gateway not active in /api/state"
echo "  healthz ok; mcp-gateway active; plugins: $(curl -sf "$BASE/api/state" | grep -o '"id":"[a-z0-9-]*"' | wc -l | tr -d ' ') loaded"

# —— L1: seed the roster via the kernel API (real HTTP surface) ————————————
note "L1 seed roster: w1 值守甲 + w2 值守乙 on-duty, w3 休假丙 paused"
curl -sf -X POST "$BASE/api/bots" -H 'content-type: application/json' \
  -d "{\"id\":\"w1\",\"name\":\"值守甲\",\"enabled\":true,\"channel\":\"fakechan\",\"account\":{\"endpoint\":\"http://fake.local\"},\"provider\":\"fakeprov\",\"providerConfig\":{\"cwd\":\"$D/w1\"}}" >/dev/null
curl -sf -X POST "$BASE/api/bots" -H 'content-type: application/json' \
  -d "{\"id\":\"w2\",\"name\":\"值守乙\",\"enabled\":true,\"channel\":\"fakechan\",\"account\":{\"endpoint\":\"http://fake.local\"},\"provider\":\"fakeprov\",\"providerConfig\":{\"cwd\":\"$D/w2\"}}" >/dev/null
curl -sf -X POST "$BASE/api/bots" -H 'content-type: application/json' \
  -d "{\"id\":\"w3\",\"name\":\"休假丙\",\"enabled\":false,\"channel\":\"fakechan\",\"account\":{\"endpoint\":\"http://fake.local\"},\"provider\":\"fakeprov\",\"providerConfig\":{\"cwd\":\"$D/w3\"}}" >/dev/null
curl -sf "$BASE/api/agents" | grep -q '"id":"w3","name":"休假丙","enabled":false' || fail "w3 not seeded paused"
echo "  seeded: w1 值守甲(idle) w2 值守乙(idle) w3 休假丙(休假)"

# —— L2: claude task 1 (read) —————————————————————————————————————————————
note "L2 claude task1 (read): roster + who is on leave"
cat > "$D/wao.mcp.json" <<EOF
{ "mcpServers": { "wao-company": { "type": "http", "url": "$MCP" } } }
EOF
claude_run "$TASK1" "$D/claude-task1.jsonl" "$D/claude-task1.err"
node "$D/assert-claude.mjs" "$D/claude-task1.jsonl" task1

# —— L3: claude task 2 (write chain create_bot → test_bot) ————————————————
note "L3 claude task2 (write): create_bot 测试员A/mcp-acc paused, then test_bot"
claude_run "$TASK2" "$D/claude-task2.jsonl" "$D/claude-task2.err"
node "$D/assert-claude.mjs" "$D/claude-task2.jsonl" task2
node - "$D/data/bots.json" "$D/work" <<'EOF'
import { readFileSync } from 'node:fs';
const [file, expectedCwd] = process.argv.slice(2);
const bots = JSON.parse(readFileSync(file, 'utf8')).bots;
const bot = bots.find((b) => b.id === 'mcp-acc');
const die = (m) => { console.error(`ASSERT-FAIL [bots.json]: ${m}`); process.exit(1); };
if (!bot) die('mcp-acc not persisted in the isolated kernel bots.json');
if (bot.enabled !== false) die(`mcp-acc enabled=${bot.enabled}, expected false (调休态)`);
if (bot.name !== '测试员A' || bot.provider !== 'fakeprov' || bot.providerConfig?.cwd !== expectedCwd)
  die(`mcp-acc record wrong: ${JSON.stringify(bot)}`);
if (bot.account?.secret !== 'x') die('mcp-acc secret not stored');
console.log('  [bots.json] mcp-acc persisted: enabled=false, provider=fakeprov, secret stored (never echoed)');
EOF

# —— L4: codex task 1 (isolated CODEX_HOME, config.toml per README §3.2) ——
note "L4 codex task1 (read): roster + who is on leave"
mkdir -p "$D/codex-home"
cp "$HOME/.codex/auth.json" "$D/codex-home/auth.json"
cat > "$D/codex-home/config.toml" <<EOF
[mcp_servers.wao]
url = "$MCP"
EOF
run_with_timeout 240 env CODEX_HOME="$D/codex-home" "$CODEX_BIN" exec --json --skip-git-repo-check \
  --approve-for-me -C "$D" "$TASK1" \
  < /dev/null > "$D/codex-task1.jsonl" 2> "$D/codex-task1.err"
node "$D/assert-codex.mjs" "$D/codex-task1.jsonl"

# —— L5: session recovery across a kernel restart (T1 leftover -32002) ————
note "L5 session recovery: initialize → restart kernel → old session -32002 → re-initialize → fresh claude run"
S1=$(curl -si -X POST "$MCP" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"recovery-probe","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
[ -n "$S1" ] || fail "no Mcp-Session-Id from initialize"
echo "  session S1=$S1"
stop_kernel
boot_kernel
STALE=$(curl -s -X POST "$MCP" -H 'content-type: application/json' -H "mcp-session-id: $S1" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "  stale S1 tools/list → $STALE"
echo "$STALE" | grep -q '"code":-32002' || fail "old session did not get -32002 after restart"
echo "$STALE" | grep -q 're-initialize' || fail "-32002 message lacks the re-initialize hint"
S2=$(curl -si -X POST "$MCP" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"recovery-probe","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
RELIST=$(curl -s -X POST "$MCP" -H 'content-type: application/json' -H "mcp-session-id: $S2" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
N_TOOLS=$(printf '%s' "$RELIST" | grep -o '"name":"[a-z_]*"' | awk 'END { print NR }')
[ "$N_TOOLS" = "13" ] || fail "re-initialized session lists $N_TOOLS tools, expected 13"
echo "  re-initialized S2 → 13 tools; roster on disk survived: $(curl -s -X POST "$MCP" -H 'content-type: application/json' -H "mcp-session-id: $S2" -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_bots","arguments":{}}}' | grep -o '在岗名册（[0-9]* 人）')"
# Real-CLI leg of the recovery story: a fresh headless claude process opens a
# NEW session against the restarted kernel and operates the company again.
claude_run '用公司工具查公司状态（get_state），告诉我现在在册共几人、休假几人。' \
  "$D/claude-recovery.jsonl" "$D/claude-recovery.err"
node "$D/assert-claude.mjs" "$D/claude-recovery.jsonl" recovery

note "ALL LEGS PASSED (L0 boot, L1 seed, L2 claude read, L3 claude write-chain, L4 codex, L5 restart recovery)"
