#!/usr/bin/env bash
# W3 T5 asset-system end-to-end acceptance (six scenarios, all REAL CLIs):
# a REAL kernel isolated on port 18795 (tmp dataDir, full repo plugins +
# fakechan from test/mcp/real-kernel.mjs — production 8792 never touched) is
# driven through the REST/MCP faces while REAL claude bots consume assets via
# 岗前测试 (POST /api/bots/:id/test):
#   S1 skill+prompt assets  — equipped vs bare bot answer diff (grep-helper → rg)
#   S2 mcp asset            — claude-mcp.json materialized, probe CALLS the
#                             equipped wao-company MCP server (roster answer +
#                             gateway session log evidence)
#   S3 rtk tool asset       — 3-round cumulative token comparison, armed vs
#                             baseline, rtk gain accounting
#   S4 exclusive snapshot   — source PATCH/DELETE never touches the snapshot
#   S5 MCP-face self-service — createAsset origin:mcp, shared bind refused,
#                             claude Agent full create→bind→probation flow
#   S6 doctor drift         — hand-edit a materialized file → wao doctor
#                             reports drift → rematerialize repairs → clean
#
# Usage: bash test/assets-e2e.sh
#   WAO_ASSETS_E2E_KEEP=1  keep the tmp workspace (artifacts inspection)
#   WAO_ASSETS_E2E_PORT=   override the isolated port (default 18795)
# Requires: node >=22.15, claude CLI (authenticated via ~/.claude/settings.json
# env — the magpie gateway route), rtk on PATH, curl. NOT part of npm test
# (real CLIs + real model gateway + 花钱).
#
# Headless tool authorization: probes ride providerConfig.permissionMode
# bypassPermissions; the S5 outer Agent runs --dangerously-skip-permissions
# (same call as test/mcp/real-accept.sh) — acceptable because the target is an
# isolated loopback kernel whose only channel is a fake.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${WAO_ASSETS_E2E_PORT:-18795}
BASE="http://127.0.0.1:${PORT}"
MCP="${BASE}/mcp"
D=$(mktemp -d "/tmp/wao-assets-e2e.XXXXXX")
KEEP=${WAO_ASSETS_E2E_KEEP:-0}
CLAUDE_BIN=$(command -v claude || true)

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "== $*"; }

[ -n "$CLAUDE_BIN" ] || fail "claude CLI not found in PATH"
command -v rtk >/dev/null 2>&1 || fail "rtk CLI not found in PATH"
[ -f "$HOME/.claude/settings.json" ] || fail "~/.claude/settings.json missing (gateway env source)"
curl -s --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && fail "port $PORT already answering — another instance? (refusing to clobber)"
note "workspace: $D (claude=$CLAUDE_BIN, port $PORT)"

run_with_timeout() {
  local secs=$1; shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$waited" -ge "$secs" ] && { kill -9 "$pid" 2>/dev/null || true; fail "timeout after ${secs}s: $*"; }
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid"
}

boot_kernel() {
  WAO_LOG_LEVEL=debug node "$REPO_ROOT/test/mcp/real-kernel.mjs" --port "$PORT" --data-dir "$D/data" --fakes "$D/fakes" \
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

# api <method> <path> <json-body|-> → response body (fails hard on HTTP error)
api() {
  local method=$1 path=$2 body=${3:-}
  if [ "$body" = "-" ]; then
    curl -sf -X "$method" "$BASE$path" -H 'content-type: application/json'
  else
    curl -sf -X "$method" "$BASE$path" -H 'content-type: application/json' -d "$body"
  fi
}
# api_status <method> <path> <json-body> → "HTTPCODE\nbody" (no -f: capture 4xx)
api_status() {
  local method=$1 path=$2 body=$3 out
  out=$(curl -s -X "$method" "$BASE$path" -H 'content-type: application/json' -d "$body" -w '\n%{http_code}')
  printf '%s\n' "$out" | tail -1
  printf '%s\n' "$out" | sed '$d'
}
# probe <botId> <prompt-file> — one 岗前测试 (fresh session); prints response
# JSON to stdout; retries once on a non-completed code (transient gateway).
probe() {
  local bot=$1 prompt=$2 tries=0 resp
  while :; do
    tries=$((tries + 1))
    resp=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({prompt:fs.readFileSync(process.argv[1],"utf8")}))' "$prompt" \
      | curl -s --max-time 100 -X POST "$BASE/api/bots/$bot/test" -H 'content-type: application/json' -d @-)
    if [ -z "$resp" ]; then
      if [ $tries -ge 2 ]; then fail "probe $bot: empty response twice"; fi
      note "probe $bot empty response (try $tries) — retrying once"; sleep 3; continue
    fi
    if printf '%s' "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.exit(r.code==="completed"?0:1)})'; then
      printf '%s' "$resp"; return 0
    fi
    if [ $tries -ge 2 ]; then printf '%s\n' "$resp" >&2; fail "probe $bot not completed after 2 tries"; fi
    note "probe $bot not completed (try $tries) — retrying once"; sleep 3
  done
}

# —— node assertion helpers ————————————————————————————————————————————————
cat > "$D/lib.mjs" <<'EOF'
// shared helpers for the per-scenario assert scripts
import { readFileSync } from 'node:fs';
export const die = (m) => { console.error(`ASSERT-FAIL: ${m}`); process.exit(1); };
export const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
export const answerOf = (probeJson) => {
  const r = JSON.parse(readFileSync(probeJson, 'utf8'));
  if (r.code !== 'completed') die(`probe code=${r.code} error=${r.errorText ?? ''}`);
  return r;
};
export const countMatches = (re, s) => (String(s).match(re) ?? []).length;
EOF

# —— L0: boot + seed ————————————————————————————————————————————————————————
note "L0 boot isolated kernel (port $PORT, tmp dataDir, debug log for MCP session evidence)"
boot_kernel
curl -sf "$BASE/healthz" | grep -q '"ok":true' || fail "healthz not ok"

# every claude bot gets its own cwd + claudeConfigDir; the config dir carries
# the SAME gateway env as ~/.claude/settings.json (single-variable design:
# only WAO asset products differ between bots)
node -e 'const s=require(process.env.HOME+"/.claude/settings.json");process.stdout.write(JSON.stringify(s.env??{}))' > "$D/user-env.json"
seed_bot() { # seed_bot <id> <name>
  local id=$1 name=$2
  mkdir -p "$D/work/$id" "$D/cfg/$id"
  printf '{\n  "env": %s\n}\n' "$(cat "$D/user-env.json")" > "$D/cfg/$id/settings.json"
  api POST /api/bots "{\"id\":\"$id\",\"name\":\"$name\",\"enabled\":true,\"channel\":\"fakechan\",\"account\":{\"endpoint\":\"http://fake.local\"},\"provider\":\"claude\",\"providerConfig\":{\"cwd\":\"$D/work/$id\",\"claudeConfigDir\":\"$D/cfg/$id\",\"permissionMode\":\"bypassPermissions\"}}" >/dev/null
}
seed_bot w1 技能员壹
seed_bot m1 连接员贰
seed_bot rb  基线员叁
seed_bot ra  装备员肆
seed_bot e1  独享员伍
seed_bot s1  自助员陆
curl -sf "$BASE/api/agents" | grep -q '"id":"w1","name":"技能员壹"' || fail "w1 not seeded"
echo "  seeded 6 claude bots (w1/m1/rb/ra/e1/s1), each with own cwd+claudeConfigDir(gateway env)"

mkrepo() { # deterministic repo in the T3-proven shape (60 untracked + 10
  # modified + commits + big.txt): rtk's git-status filter measurably trims
  # THIS shape (-302 chars, bisected 2026-11-07 — 200-untracked trims almost
  # nothing), so the armed-vs-baseline diff is a real signal, not noise.
  local repo=$1
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email 'e2e@wao.local'
  git -C "$repo" config user.name 'wao-e2e'
  for i in $(seq 0 9); do printf 'tracked file %s\n%.0s' "$i" $(seq 1 50) > "$repo/tracked-$i.txt"; done
  git -C "$repo" add . && git -C "$repo" commit -q -m init
  for i in $(seq 0 9); do printf 'modified %s\n%.0s' "$i" $(seq 1 50) > "$repo/tracked-$i.txt"; done
  for i in $(seq 1 60); do echo "untracked $i" > "$repo/untracked-$i.txt"; done
  for i in $(seq 1 30); do echo "history line $i" >> "$repo/hist.txt"; git -C "$repo" add hist.txt; git -C "$repo" commit -q -m "c$i"; done
  seq 1 400 > "$repo/big.txt"
}

# —— S1: 真 claude 消费 skill 资产（装备前后对比）———————————————————————————
note "S1 skill asset: bare probe → equip prompt+skill → probe again → diff"
cat > "$D/s1-q.txt" <<'EOF'
怎么在代码里搜函数定义？请给出具体命令。
EOF
probe w1 "$D/s1-q.txt" > "$D/s1-before.json"

PROMPT_AST=$(api POST /api/assets '{"type":"prompt","name":"w1-persona","description":"技能员人设","content":{"text":"你是公司里最务实的高级工程师，回答不超过 150 字，直接给可执行的命令。"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).asset.id))')
SKILL_AST=$(api POST /api/assets '{"type":"skill","name":"grep-helper","description":"代码搜索问答规范","content":{"name":"grep-helper","description":"被问如何搜索代码时用 rg 回答","body":"被问如何搜索代码时，回答用 rg 命令并给出三个常用模式示例。"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).asset.id))')
echo "  assets: prompt=$PROMPT_AST skill=$SKILL_AST"
api POST /api/bots/w1/assets "{\"assetId\":\"$PROMPT_AST\",\"mode\":\"shared\"}" > "$D/s1-bind-prompt.json"
api POST /api/bots/w1/assets "{\"assetId\":\"$SKILL_AST\",\"mode\":\"shared\"}" > "$D/s1-bind-skill.json"
node - "$D/s1-bind-skill.json" "$D/cfg/w1/skills/grep-helper/SKILL.md" "$D/s1-before.json" <<'EOF'
import { readFileSync, existsSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S1]: ${m}`); process.exit(1); };
const [bindFile, skillFile, beforeFile] = process.argv.slice(2);
const bind = JSON.parse(readFileSync(bindFile, 'utf8'));
if (!bind.ok || bind.binding.mode !== 'shared') die(`bind receipt not ok/shared: ${JSON.stringify(bind.binding ?? {})}`);
if (!(bind.writes ?? []).some((w) => /skills\/grep-helper\/SKILL\.md$/.test(w.path))) die(`receipt writes lack SKILL.md: ${JSON.stringify(bind.writes)}`);
if (!existsSync(skillFile)) die(`SKILL.md not materialized at ${skillFile}`);
const skill = readFileSync(skillFile, 'utf8');
if (!/^\s*x-wao-asset:\s*\S+/m.test(skill) || !skill.includes('回答用 rg 命令')) die(`SKILL.md content wrong:\n${skill}`);
const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
console.log(`  [S1] materialized: ${skillFile} (x-wao-asset annotated)`);
console.log(`  [S1] BEFORE (bare)  answer: ${String(before.finalText).slice(0, 220).replace(/\n/g, ' ⏎ ')}`);
EOF
probe w1 "$D/s1-q.txt" > "$D/s1-after.json"
node - "$D/s1-after.json" <<'EOF'
import { readFileSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S1]: ${m}`); process.exit(1); };
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (r.code !== 'completed') die(`probe code=${r.code} error=${r.errorText ?? ''}`);
const text = String(r.finalText);
const rgCount = (text.match(/rg/g) ?? []).length;
console.log(`  [S1] AFTER (equipped) answer: ${text.slice(0, 220).replace(/\n/g, ' ⏎ ')}`);
console.log(`  [S1] 'rg' occurrences in equipped answer: ${rgCount}`);
if (!/rg/.test(text)) die('equipped answer does not mention rg at all');
if (rgCount < 3) die(`equipped answer has only ${rgCount} rg mentions — skill said THREE rg pattern examples`);
console.log('  [S1] ASSERTIONS OK (rg usage present with >=3 patterns; bare-vs-equipped answers above are the diff evidence)');
EOF

# —— S2: 真 claude 消费 mcp 资产 ————————————————————————————————————————————
note "S2 mcp asset: wao-company http server → claude-mcp.json → probe CALLS it"
MCP_AST=$(api POST /api/assets "{\"type\":\"mcp\",\"name\":\"wao-company\",\"description\":\"公司 MCP 网关\",\"content\":{\"servers\":{\"wao-company\":{\"type\":\"http\",\"url\":\"$MCP\"}}}}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).asset.id))')
api POST /api/bots/m1/assets "{\"assetId\":\"$MCP_AST\",\"mode\":\"shared\"}" > "$D/s2-bind.json"
MCP_SESS_BEFORE=$(grep -c 'mcp: session .* initialized' "$D/data/logs/wao.log" 2>/dev/null || true)
cat > "$D/s2-q.txt" <<'EOF'
用公司工具（list_bots）查一下公司在册员工名单和总人数，把名单里每个人的名字完整念出来，并明确给出总人数。
EOF
probe m1 "$D/s2-q.txt" > "$D/s2-probe.json"
MCP_SESS_AFTER=$(grep -c 'mcp: session .* initialized' "$D/data/logs/wao.log" 2>/dev/null || true)
node - "$D/s2-bind.json" "$D/data/assets/m1/claude-mcp.json" "$D/s2-probe.json" "$MCP_SESS_BEFORE" "$MCP_SESS_AFTER" <<'EOF'
import { readFileSync, existsSync, statSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S2]: ${m}`); process.exit(1); };
const [bindFile, mcpFile, probeFile, before, after] = process.argv.slice(2);
const bind = JSON.parse(readFileSync(bindFile, 'utf8'));
if (!bind.ok) die('bind failed');
if (!(bind.writes ?? []).some((w) => /claude-mcp\.json$/.test(w.path))) die(`receipt writes lack claude-mcp.json: ${JSON.stringify(bind.writes)}`);
if (!existsSync(mcpFile)) die(`${mcpFile} missing`);
const doc = readFileSync(mcpFile, 'utf8');
if (!doc.includes('"wao-wao-company"') || !doc.includes('"url":"http://127.0.0.1:18795/mcp"')) die(`claude-mcp.json wrong:\n${doc}`);
const mode = statSync(mcpFile).mode & 0o777;
if (mode !== 0o600) die(`claude-mcp.json mode ${mode.toString(8)} != 600`);
const r = JSON.parse(readFileSync(probeFile, 'utf8'));
if (r.code !== 'completed') die(`probe code=${r.code} error=${r.errorText ?? ''}`);
const text = String(r.finalText);
const names = ['技能员壹', '连接员贰', '基线员叁', '装备员肆', '独享员伍', '自助员陆'].filter((n) => text.includes(n));
console.log(`  [S2] materialized: ${mcpFile} (wao-wao-company, mode 600)`);
console.log(`  [S2] roster names relayed: ${names.join('/')} | 总人数 mentioned: ${/(^|[^0-9])6([^0-9]|$)/.test(text) ? 'yes(6)' : 'NO'}`);
console.log(`  [S2] gateway sessions during probe: ${before} → ${after}`);
if (names.length < 2) die(`answer names ${names.length} seeded bots — the equipped mcp server was not consulted:\n${text.slice(0, 300)}`);
if (!/(^|[^0-9])6([^0-9]|$)/.test(text)) die(`answer does not state the 6-bot count:\n${text.slice(0, 300)}`);
if (Number(after) - Number(before) < 1) die('no new MCP session in the kernel log during the probe — claude never connected to the equipped server');
console.log('  [S2] ASSERTIONS OK (tool call happened: roster facts + gateway session delta)');
EOF

# —— S3: rtk 装备真 bot — 多轮累计 token 对比 ———————————————————————————————
note "S3 rtk asset: bind r-armed (ra) → 3 rounds each side, cumulative tokens"
mkrepo "$D/work/rb"
mkrepo "$D/work/ra"
RTK_AST=$(api POST /api/assets '{"type":"tool","name":"rtk","description":"rtk token 削减","content":{"kind":"rtk"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).asset.id))')
api POST /api/bots/ra/assets "{\"assetId\":\"$RTK_AST\",\"mode\":\"shared\"}" > "$D/s3-bind.json"
node - "$D/s3-bind.json" "$D/cfg/ra/settings.json" <<'EOF'
import { readFileSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S3]: ${m}`); process.exit(1); };
const [bindFile, settingsFile] = process.argv.slice(2);
const bind = JSON.parse(readFileSync(bindFile, 'utf8'));
const notes = (bind.notes ?? []).map((n) => n.detail).join(' | ');
console.log(`  [S3] bind notes: ${notes}`);
if (!notes.includes('rtk 已装备')) die('bind notes lack rtk 已装备');
const doc = JSON.parse(readFileSync(settingsFile, 'utf8'));
const hook = (doc.hooks?.PreToolUse ?? []).find((e) => JSON.stringify(e).includes('rtk hook claude'));
if (hook == null) die(`settings.json lacks rtk PreToolUse hook: ${JSON.stringify(doc.hooks ?? null)}`);
console.log(`  [S3] rtk PreToolUse hook present in ${settingsFile}`);
EOF
gain_snapshot() {
  rtk gain 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s;const n=(re)=>Number((re.exec(t)||[])[1]??0);process.stdout.write(`${n(/Total commands:\s*(\d+)/)} ${n(/Tokens saved:\s*(\d+)/)}`)})'
}
GAIN_BEFORE=$(gain_snapshot)
ROUNDS=('git status' 'git log --oneline -n 30' 'cat big.txt')
for i in 1 2 3; do
  cat > "$D/s3-q.txt" <<EOF
请用 Bash 工具执行一次 ${ROUNDS[$((i - 1))]}（不要加任何别的参数），然后把工具输出的完整内容原样贴出，不要省略任何行。
EOF
  for side in rb ra; do
    probe "$side" "$D/s3-q.txt" > "$D/s3-$side-r$i.json"
  done
done
GAIN_AFTER=$(gain_snapshot)
node - "$D" "$GAIN_BEFORE" "$GAIN_AFTER" <<'EOF'
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const die = (m) => { console.error(`ASSERT-FAIL [S3]: ${m}`); process.exit(1); };
const [D, gainBefore, gainAfter] = process.argv.slice(2);
// one probe's session jsonl → { usage (last assistant usage), toolResultChars,
// toolUses } — tool_result sizes are deterministic given the repo (same bytes
// both sides; the ONLY variable is the rtk hook), usage tokens ride along as
// the report's cost picture (in/ctx vary with per-run prompt-cache hits).
const sessionOf = (bot, sessionId) => {
  const projDir = join(D, 'cfg', bot, 'projects');
  for (const ent of readdirSync(projDir)) {
    try {
      const lines = readFileSync(join(projDir, ent, `${sessionId}.jsonl`), 'utf8').trim().split('\n');
      return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* next project dir */ }
  }
  return null;
};
const analyze = (bot, sessionId) => {
  const evs = sessionOf(bot, sessionId);
  if (evs == null) die(`${bot}: session ${sessionId} not found`);
  let usage = null;
  for (const ev of evs) {
    const u = ev?.message?.usage;
    if (u != null && typeof u.input_tokens === 'number') usage = u;
  }
  const uses = evs.flatMap((e) => (e.type === 'assistant' ? e.message?.content ?? [] : []))
    .filter((c) => c.type === 'tool_use' && c.name === 'Bash').map((c) => String(c.input?.command ?? ''));
  const results = evs.flatMap((e) => (e.type === 'user' ? e.message?.content ?? [] : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => (Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join('') : String(c.content ?? '')));
  if (usage == null) die(`${bot} ${sessionId}: no usage recorded`);
  return { usage, commands: uses, resultChars: results.reduce((a, t) => a + t.length, 0) };
};
const ctxTokens = (u) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
const rounds = ['git status', 'git log --oneline -n 30', 'cat big.txt'];
const rows = { rb: [], ra: [] };
for (const bot of ['rb', 'ra']) {
  for (let i = 1; i <= 3; i++) {
    const probe = JSON.parse(readFileSync(join(D, `s3-${bot}-r${i}.json`), 'utf8'));
    if (probe.code !== 'completed') die(`${bot} round ${i} code=${probe.code} error=${probe.errorText ?? ''}`);
    const a = analyze(bot, probe.sessionId);
    if (!a.commands.some((c) => c.includes(rounds[i - 1]))) die(`${bot} round ${i}: Bash did not run "${rounds[i - 1]}" (saw ${JSON.stringify(a.commands)})`);
    rows[bot].push({ cmd: rounds[i - 1], in: a.usage.input_tokens, ctx: ctxTokens(a.usage), out: a.usage.output_tokens, res: a.resultChars });
  }
}
const sum = (xs, k) => xs.reduce((a, r) => a + r[k], 0);
const fmt = (bot) => rows[bot].map((r, i) => `    round${i + 1} ${r.cmd}: tool_result=${r.res} chars | in=${r.in} ctx(in+cache)=${r.ctx} out=${r.out}`).join('\n');
const tot = (bot) => `    TOTAL tool_result=${sum(rows[bot], 'res')} chars | in=${sum(rows[bot], 'in')} ctx=${sum(rows[bot], 'ctx')} out=${sum(rows[bot], 'out')}`;
console.log('  [S3] baseline (rb, no rtk) 3 rounds:');
console.log(`${fmt('rb')}\n${tot('rb')}`);
console.log('  [S3] armed (ra, rtk via WAO) 3 rounds:');
console.log(`${fmt('ra')}\n${tot('ra')}`);
const [bCmd, bTok] = gainBefore.split(' ').map(Number);
const [aCmd, aTok] = gainAfter.split(' ').map(Number);
const dCmd = aCmd - bCmd;
const dTok = aTok - bTok;
console.log(`  [S3] rtk gain delta over the armed rounds: commands rewritten=${dCmd}, tokens saved=${dTok}`);
if (dCmd < 3) die(`rtk gain recorded ${dCmd} rewritten commands (<3) — hook did not intercept every round`);
if (dTok <= 0) die('rtk gain recorded zero tokens saved — trim not effective');
if (rows.ra[0].res >= rows.rb[0].res) die(`git-status round: armed tool_result ${rows.ra[0].res} chars not below baseline ${rows.rb[0].res} — rtk trim not visible where it should be`);
if (sum(rows.ra, 'res') >= sum(rows.rb, 'res')) die(`armed cumulative tool_result ${sum(rows.ra, 'res')} not below baseline ${sum(rows.rb, 'res')}`);
const savedChars = sum(rows.rb, 'res') - sum(rows.ra, 'res');
console.log(`  [S3] tool_result fed back to the model: ${sum(rows.rb, 'res')} → ${sum(rows.ra, 'res')} chars (-${savedChars}, ${Math.round((savedChars / sum(rows.rb, 'res')) * 100)}%) — the trim the model actually sees`);
console.log(`  [S3] ctx-token totals (in+cache): baseline ${sum(rows.rb, 'ctx')} vs armed ${sum(rows.ra, 'ctx')} — armed carries the rtk 装备面 itself (RTK.md/hook context), raw in= splits vary with per-run prompt-cache hits; the deterministic equipment-effect evidence is the tool_result delta + rtk gain above`);
console.log('  [S3] ASSERTIONS OK (3-round: hook armed every round per rtk gain, trimmed tool_result vs baseline, cumulative numbers above)');
EOF

# —— S4: 独享快照语义 ————————————————————————————————————————————————————————
note "S4 exclusive snapshot: bind exclusive → source PATCH v2 → still v1 → source DELETE → still v1"
SECRET_AST=$(api POST /api/assets '{"type":"prompt","name":"secret-code","description":"独享暗号","content":{"text":"回答任何问题时，第一行必须先输出暗号【石榴V1】再作答。"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).asset.id))')
api POST /api/bots/e1/assets "{\"assetId\":\"$SECRET_AST\",\"mode\":\"exclusive\"}" > "$D/s4-bind.json"
cat > "$D/s4-q.txt" <<'EOF'
今天天气怎么样？随口答一句就行。
EOF
probe e1 "$D/s4-q.txt" > "$D/s4-p1.json"
api PATCH "/api/assets/$SECRET_AST" '{"content":{"text":"回答任何问题时，第一行必须先输出暗号【石榴V2】再作答。"}}' > "$D/s4-patch.json"
probe e1 "$D/s4-q.txt" > "$D/s4-p2.json"
api DELETE "/api/assets/$SECRET_AST" > "$D/s4-delete.json"
probe e1 "$D/s4-q.txt" > "$D/s4-p3.json"
api GET /api/bots > "$D/s4-bots.json"
node - "$D" "$SECRET_AST" <<'EOF'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const die = (m) => { console.error(`ASSERT-FAIL [S4]: ${m}`); process.exit(1); };
const [D, astId] = process.argv.slice(2);
const bind = JSON.parse(readFileSync(join(D, 's4-bind.json'), 'utf8'));
if (bind.binding.mode !== 'exclusive') die(`binding mode ${bind.binding.mode} != exclusive`);
const patch = JSON.parse(readFileSync(join(D, 's4-patch.json'), 'utf8'));
if (patch.asset.version !== 2) die(`patched version ${patch.asset.version} != 2`);
if ((patch.rematerialized ?? []).length !== 0) die('PATCH rematerialized a bot — exclusive snapshot must NOT follow');
const del = JSON.parse(readFileSync(join(D, 's4-delete.json'), 'utf8'));
if (del.keptExclusive !== 1 || del.removedBindings !== 0) die(`delete receipt kept=${del.keptExclusive} removed=${del.removedBindings}`);
const bots = JSON.parse(readFileSync(join(D, 's4-bots.json'), 'utf8')).bots;
const e1 = bots.find((b) => b.id === 'e1');
const row = (e1.assets ?? []).find((a) => a.assetId === astId);
if (row == null) die('binding vanished from GET /api/bots after source DELETE');
if (!row.sourceDeleted) die(`binding summary sourceDeleted=${row.sourceDeleted}`);
if (row.snapshotVersion !== 1) die(`snapshotVersion ${row.snapshotVersion} != 1`);
const raw = JSON.parse(readFileSync(join(D, 'data', 'bots.json'), 'utf8'));
const rawBind = raw.bots.find((b) => b.id === 'e1').assets.find((a) => a.assetId === astId);
if (rawBind.snapshot?.text?.includes('石榴V1') !== true) die('bots.json snapshot does not carry the v1 text');
for (const [f, label] of [['s4-p1.json', 'after bind'], ['s4-p2.json', 'after source PATCH→v2'], ['s4-p3.json', 'after source DELETE']]) {
  const r = JSON.parse(readFileSync(join(D, f), 'utf8'));
  if (r.code !== 'completed') die(`${label}: probe code=${r.code}`);
  const text = String(r.finalText);
  console.log(`  [S4] ${label}: ${text.slice(0, 100).replace(/\n/g, ' ⏎ ')}`);
  if (!text.includes('石榴V1')) die(`${label}: answer lost the 石榴V1 snapshot`);
  if (text.includes('石榴V2')) die(`${label}: answer followed the SOURCE v2 — snapshot semantics broken`);
}
console.log('  [S4] ASSERTIONS OK (exclusive snapshot survived source PATCH and DELETE; behind-version + sourceDeleted echoed)');
EOF

# —— S5: MCP 面 Agent 自助配资产 ———————————————————————————————————————————
note "S5 MCP-face self-service: curl legs (origin:mcp, shared refused) + claude Agent full flow"
MCP_SESSION=$(curl -si -X POST "$MCP" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"assets-e2e","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
[ -n "$MCP_SESSION" ] || fail "no MCP session from initialize"
curl -s -X POST "$MCP" -H 'content-type: application/json' -H "mcp-session-id: $MCP_SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_asset","arguments":{"asset":{"type":"skill","name":"curl-probe-skill","content":{"name":"curl-probe-skill","body":"占位"}}}}}' > "$D/s5-create.json"
CURL_AST=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;const a=r.structuredContent.asset;console.error(`  [S5] create_asset via MCP: id=${a.id} origin=${a.origin}`);if(a.origin!=="mcp"){console.error("origin not mcp");process.exit(1)}process.stdout.write(a.id)})' < "$D/s5-create.json") || fail "create_asset origin!=mcp"
curl -s -X POST "$MCP" -H 'content-type: application/json' -H "mcp-session-id: $MCP_SESSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"bind_asset\",\"arguments\":{\"botId\":\"s1\",\"assetId\":\"$CURL_AST\",\"mode\":\"shared\"}}}" > "$D/s5-shared-bind.json"
node - "$D/s5-shared-bind.json" <<'EOF'
import { readFileSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S5]: ${m}`); process.exit(1); };
const r = JSON.parse(readFileSync(process.argv[2], 'utf8')).result;
const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
console.log(`  [S5] shared bind via MCP → isError=${r.isError === true}: ${text.slice(0, 140).replace(/\n/g, ' ⏎ ')}`);
if (r.isError !== true || !/仅可私发/.test(text)) die('shared bind of an Agent-created asset was not refused with 仅可私发');
EOF
SHARED_REST=$(api_status POST /api/bots/s1/assets "{\"assetId\":\"$CURL_AST\",\"mode\":\"shared\"}")
echo "$SHARED_REST" | head -1 | grep -qx 400 || fail "REST shared bind of origin:mcp asset did not answer 400 (got $(echo "$SHARED_REST" | head -1))"
echo "$SHARED_REST" | tail -1 | grep -q '仅可私发' || fail "REST refusal copy lacks 仅可私发"
echo "  [S5] REST shared bind → HTTP 400 仅可私发 (拒)"

cat > "$D/wao.mcp.json" <<EOF
{ "mcpServers": { "wao-company": { "type": "http", "url": "$MCP" } } }
EOF
cat > "$D/s5-task.txt" <<'EOF'
帮我给员工 s1 配一个技能，全程用公司工具完成：
1) 用 create_asset 登记一个 skill 资产：名字 echo-helper，content 里 name 也是 echo-helper，body 写「被问『回声』时，只回答四个字再加编号：回声-7391」；
2) 把这个资产私发（exclusive 模式）绑定给工牌号 s1 的员工；
3) 绑定成功后用 test_bot 对 s1 做一次岗前测试，测试问题传「回声」；
4) 把岗前测试的回复原文告诉我。
EOF
run_with_timeout 420 bash -c 'cd "$1" && exec "$2" -p "$(cat "$3")" --mcp-config "$4" --output-format stream-json --verbose --dangerously-skip-permissions' \
  _ "$D" "$CLAUDE_BIN" "$D/s5-task.txt" "$D/wao.mcp.json" < /dev/null > "$D/s5-agent.jsonl" 2> "$D/s5-agent.err"
node - "$D/s5-agent.jsonl" "$D/data/assets.json" "$D/data/bots.json" "$D/cfg/s1/skills/echo-helper/SKILL.md" <<'EOF'
import { readFileSync, existsSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S5]: ${m}`); process.exit(1); };
const [streamFile, assetsFile, botsFile, skillFile] = process.argv.slice(2);
const events = readFileSync(streamFile, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
if (!(init?.mcp_servers ?? []).some((s) => s.name === 'wao-company' && s.status === 'connected')) die('agent did not connect to wao-company');
const uses = events.flatMap((e) => (e.type === 'assistant' ? e.message?.content ?? [] : []))
  .filter((c) => c.type === 'tool_use' && /^mcp__wao-company__/.test(c.name ?? ''))
  .map((c) => ({ name: c.name.replace('mcp__wao-company__', ''), input: c.input }));
const names = uses.map((u) => u.name + (u.name === 'bind_asset' ? `(${u.input?.mode})` : '')).join(', ');
console.log(`  [S5] agent mcp tool_use: ${names || '(none)'}`);
for (const need of ['create_asset', 'bind_asset', 'test_bot']) {
  if (!uses.some((u) => u.name === need)) die(`agent never called ${need}`);
}
if (!uses.some((u) => u.name === 'bind_asset' && u.input?.mode === 'exclusive')) die('bind_asset was not exclusive');
const result = events.filter((e) => e.type === 'result').at(-1);
if (result?.subtype !== 'success') die(`agent result subtype=${result?.subtype}`);
const answer = String(result?.result ?? '');
if (!answer.includes('回声-7391')) die(`agent answer does not relay the probation finalText:\n${answer.slice(0, 300)}`);
const assets = JSON.parse(readFileSync(assetsFile, 'utf8')).assets;
const ast = assets.find((a) => a.name === 'echo-helper');
if (ast?.origin !== 'mcp') die(`echo-helper origin=${ast?.origin} != mcp`);
const bind = JSON.parse(readFileSync(botsFile, 'utf8')).bots.find((b) => b.id === 's1').assets ?? [];
const row = bind.find((x) => x.assetId === ast.id);
if (row?.mode !== 'exclusive' || row.snapshot?.body?.includes('回声-7391') !== true) die(`s1 binding wrong: ${JSON.stringify(row)}`);
if (!existsSync(skillFile)) die(`${skillFile} missing`);
console.log(`  [S5] persisted: asset origin=mcp, s1 exclusive snapshot, ${skillFile}`);
console.log(`  [S5] agent answer: ${answer.slice(0, 180).replace(/\n/g, ' ⏎ ')}`);
console.log('  [S5] ASSERTIONS OK (Agent self-served: create → exclusive bind → probation echoed the skill)');
EOF

# —— S6: doctor 漂移 ————————————————————————————————————————————————————————
note "S6 doctor drift: hand-edit SKILL.md → wao doctor reports → rematerialize repairs → clean"
SKILL_FILE="$D/cfg/w1/skills/grep-helper/SKILL.md"
printf '\nHAND-EDITED DRIFT LINE (e2e)\n' >> "$SKILL_FILE"
stop_kernel
node "$REPO_ROOT/src/index.js" doctor --data-dir "$D/data" --port "$PORT" > "$D/doctor-drift.txt" 2>&1 || true
grep -q "assets w1.*漂移" "$D/doctor-drift.txt" || { echo "---- doctor output ----"; cat "$D/doctor-drift.txt"; fail "doctor did not report the w1 drift"; }
grep "assets " "$D/doctor-drift.txt" | sed 's/^/  [S6 doctor drift] /'
boot_kernel
grep -q '资产物化漂移' "$D/data/logs/wao.log" && echo "  [S6] startup sweep also logged 资产物化漂移 (restart evidence)" || fail "startup sweep did not log drift after hand-edit"
api POST /api/bots/w1/rematerialize-assets '{}' > "$D/s6-remat.json"
node - "$D/s6-remat.json" "$SKILL_FILE" <<'EOF'
import { readFileSync } from 'node:fs';
const die = (m) => { console.error(`ASSERT-FAIL [S6]: ${m}`); process.exit(1); };
const [rematFile, skillFile] = process.argv.slice(2);
const r = JSON.parse(readFileSync(rematFile, 'utf8'));
if (!r.ok || !(r.writes ?? []).some((w) => /SKILL\.md$/.test(w.path))) die(`rematerialize receipt lacks SKILL.md: ${JSON.stringify(r.writes)}`);
const text = readFileSync(skillFile, 'utf8');
if (text.includes('HAND-EDITED DRIFT LINE')) die('hand-edit survived rematerialize');
if (!/^\s*x-wao-asset:\s*\S+/m.test(text)) die('rematerialized SKILL.md lost the annotation');
console.log(`  [S6] rematerialize rewrote ${skillFile} back to expected bytes`);
EOF
stop_kernel
node "$REPO_ROOT/src/index.js" doctor --data-dir "$D/data" --port "$PORT" > "$D/doctor-clean.txt" 2>&1 || true
if grep -q "漂移：" "$D/doctor-clean.txt"; then cat "$D/doctor-clean.txt"; fail "doctor still reports drift after repair"; fi
grep "assets " "$D/doctor-clean.txt" | sed 's/^/  [S6 doctor clean] /'
boot_kernel # leave a running kernel for any post-run inspection until cleanup

note "ALL SCENARIOS PASSED (S1 skill, S2 mcp, S3 rtk 3-round tokens, S4 exclusive snapshot, S5 MCP self-service, S6 doctor drift)"
