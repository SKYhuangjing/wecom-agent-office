#!/bin/bash
# M2 acceptance run (Task 7) — the scripted, reproducible REAL-CLI acceptance
# across ALL THREE providers (dsh / claude / codex), the M2 counterpart of
# accept-m1.sh: doctor, real kernel boot (tmp dataDir, port 18796), three
# enabled:false bots (wecom never connects — the channel stays untouched),
# per-bot /test round 1 (no body → fresh session) + round 2 (body
# {sessionId} → the M2 Task 6 passthrough; dsh resumes the same session,
# claude the same session, codex the same thread), a real provider SWITCH on
# the dsh bot (PATCH dsh→claude → probe, PATCH back → probe), the /api/agents
# and /api/ledger operator views, then DELETE (dsh profile cleanup asserted)
# and a SIGINT clean stop.
#
# Not part of `npm test`: it needs real dsh/claude/codex installs (and their
# credentials). Skips cleanly (exit 0) when any CLI is missing (probe.sh
# convention). FULL switching semantics (handoff prefix, delta-only replay,
# functional recall over 7 real turns) live in `npm run test:matrix`
# (test/e2e/switch-matrix.realtest.js) — this script pins the OPERATIONAL
# essentials: probe, resume, switch, clean up.
#
#   usage: bash test/accept-m2.sh
set -u
cd "$(dirname "$0")/.."

for CLI in dsh claude codex; do
  if ! command -v "$CLI" >/dev/null 2>&1; then
    echo "accept-m2: skip ($CLI not found in PATH)"
    exit 0
  fi
done
if ! command -v curl >/dev/null 2>&1; then
  echo "accept-m2: FAIL (curl required but not found in PATH)"
  exit 1
fi

PORT=18796
BASE="http://127.0.0.1:${PORT}"
DATADIR="$(mktemp -d /tmp/wao-accept2-data.XXXXXX)"
CW="$(mktemp -d /tmp/wao-accept2-cwd.XXXXXX)"
SERVER_LOG="$(mktemp /tmp/wao-accept2-server.XXXXXX.log)"
BOTD=m2-accept-dsh
BOTC=m2-accept-claude
BOTX=m2-accept-codex
PROFILE=wecom-m2-accept
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
SERVER_PID=""

FAIL=0
ok() { echo "✓ $1"; }
bad() { echo "✗ $1"; FAIL=1; }

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$DATADIR" "$CW" "$SERVER_LOG"
  rm -rf "$PROFILE_DIR"   # leftover profile must not outlive a failed run
}
trap cleanup EXIT

jget() { # jget <file> <js-expr over o> — extract from a JSON file
  node -e 'const o=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(eval(process.argv[2])??"")' "$1" "$2"
}

# runner spawn cwd must EXIST before any probe (a missing cwd is a bare ENOENT
# — first-run lesson of the switch-matrix suite)
mkdir -p "$CW/dsh" "$CW/claude" "$CW/codex" "$CW/switch"

echo "accept-m2: $(date '+%Y-%m-%d %H:%M:%S')  node $(node --version)  dsh $(dsh --version 2>/dev/null | head -1)  claude $(claude --version 2>/dev/null | head -1)  codex $(codex --version 2>/dev/null | head -1)"
echo "accept-m2: data $DATADIR / cwds $CW/{dsh,claude,codex,switch} / profile $PROFILE_DIR"

# —— doctor: the operator pre-flight, against THIS run's port + data dir ————
DOCTOR_OUT="$(node src/index.js doctor --port "$PORT" --data-dir "$DATADIR" 2>&1)"; DOCTOR_RC=$?
if [ "$DOCTOR_RC" = 0 ] && ! printf '%s\n' "$DOCTOR_OUT" | grep -q '✗'; then
  ok "doctor → exit 0, no ✗ ($(printf '%s\n' "$DOCTOR_OUT" | grep -c '✓') ✓ lines; port $PORT free, lock probe ok)"
else
  bad "doctor → exit $DOCTOR_RC:"
  printf '%s\n' "$DOCTOR_OUT" | sed 's/^/    /'
fi

# —— boot the real server ————————————————————————————————————————————————
node src/index.js start --port "$PORT" --data-dir "$DATADIR" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

UP=0
for _ in $(seq 1 80); do
  if curl -sS --max-time 2 -o /dev/null "$BASE/healthz" 2>/dev/null; then UP=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
if [ "$UP" = 1 ]; then ok "server up (pid $SERVER_PID), /healthz 200 on :$PORT"; else
  bad "server failed to come up on :$PORT (log tail below)"
  tail -30 "$SERVER_LOG"
  exit 1
fi

# —— create the three bots (enabled:false — wecom never connects) ——————————
create_bot() { # create_bot <id> <name> <provider> <providerConfig json>
  local body
  body=$(printf '{"id":"%s","name":"%s","enabled":false,"channel":"wecom","account":{"botId":"accept-test","secret":"x"},"provider":"%s","providerConfig":%s}' "$1" "$2" "$3" "$4")
  HTTP=$(curl -sS --max-time 60 -o "$DATADIR/$1.create.json" -w '%{http_code}' \
    -X POST -H 'content-type: application/json' -d "$body" "$BASE/api/bots")
  if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/$1.create.json" 'o.bot.provider')" = "$3" ]; then
    ok "POST /api/bots $1 → 200 ($3, enabled:false)"
  else
    bad "POST /api/bots $1 → HTTP $HTTP: $(cat "$DATADIR/$1.create.json")"
  fi
  if grep -q '"secret"' "$DATADIR/$1.create.json"; then bad "$1: create response echoed the secret"; fi
}

create_bot "$BOTD" 'M2 验收 dsh' dsh "{\"cwd\":\"$CW/dsh\",\"profile\":\"$PROFILE\",\"dshBin\":\"dsh\",\"permission\":\"workspace-write\"}"
create_bot "$BOTC" 'M2 验收 claude' claude "{\"cwd\":\"$CW/claude\"}"
create_bot "$BOTX" 'M2 验收 codex' codex "{\"cwd\":\"$CW/codex\"}"

# materializeConfig evidence: the dsh bot's profile is on disk (claude/codex
# need no side files — materializeConfig null by contract)
if [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  ok "materializeConfig: $PROFILE_DIR/cordis.patch.yml written"
else
  bad "materializeConfig: $PROFILE_DIR/cordis.patch.yml missing"
fi

# —— per-bot probe: round 1 fresh, round 2 resume via {sessionId} ——————————
probe() { # probe <bot> <outfile> [sessionId] — sets HTTP/CODE/FINAL/SID
  if [ -n "${3:-}" ]; then
    HTTP=$(curl -sS --max-time 90 -o "$2" -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d "{\"sessionId\":\"$3\"}" "$BASE/api/bots/$1/test")
  else
    HTTP=$(curl -sS --max-time 90 -o "$2" -w '%{http_code}' -X POST "$BASE/api/bots/$1/test")
  fi
  CODE="$(jget "$2" 'o.code')"
  # display copy: first line only — a chatty claude reply must not break the ✓ line
  FINAL="$(jget "$2" '(o.finalText??"").split("\n")[0].slice(0,80)')"
  SID="$(jget "$2" 'o.sessionId')"
}

two_rounds() { # two_rounds <bot> <label> — round 1 fresh + round 2 resume
  local bot="$1" label="$2" sid1
  probe "$bot" "$DATADIR/$bot.r1.json"
  if [ "$HTTP" = 200 ] && [ "$CODE" = completed ] && [ -n "$SID" ]; then
    ok "$label round 1 (no body → fresh session) → completed, sessionId=$SID finalText='${FINAL}'"
  else
    bad "$label round 1 → HTTP $HTTP code=${CODE:-none}: $(cat "$DATADIR/$bot.r1.json")"
    return
  fi
  sid1="$SID"
  probe "$bot" "$DATADIR/$bot.r2.json" "$sid1"
  if [ "$HTTP" = 200 ] && [ "$CODE" = completed ] && [ "$SID" = "$sid1" ]; then
    ok "$label round 2 (body {sessionId}) → completed, SAME id echoed ($SID) finalText='${FINAL}'"
  else
    bad "$label round 2 → HTTP $HTTP code=${CODE:-none} sessionId=${SID:-none} (want $sid1): $(cat "$DATADIR/$bot.r2.json")"
  fi
}

two_rounds "$BOTD" 'dsh'
two_rounds "$BOTC" 'claude'
two_rounds "$BOTX" 'codex'

# —— switch essentials: PATCH the dsh bot to claude, probe, PATCH back ——————
HTTP=$(curl -sS --max-time 60 -o "$DATADIR/switch1.json" -w '%{http_code}' -X PATCH \
  -H 'content-type: application/json' \
  -d "{\"provider\":\"claude\",\"providerConfig\":{\"cwd\":\"$CW/switch\"}}" "$BASE/api/bots/$BOTD")
if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/switch1.json" 'o.bot.provider')" = claude ]; then
  ok "PATCH $BOTD provider dsh→claude → 200 (record + runtime re-targeted; enabled:false → no wecom attach)"
else
  bad "PATCH $BOTD dsh→claude → HTTP $HTTP: $(cat "$DATADIR/switch1.json")"
fi
probe "$BOTD" "$DATADIR/switch1.test.json"
if [ "$HTTP" = 200 ] && [ "$CODE" = completed ]; then
  ok "switch round 1: $BOTD on claude → /test completed, sessionId=$SID finalText='${FINAL}'"
else
  bad "switch round 1 (claude) → HTTP $HTTP code=${CODE:-none}: $(cat "$DATADIR/switch1.test.json")"
fi

HTTP=$(curl -sS --max-time 60 -o "$DATADIR/switch2.json" -w '%{http_code}' -X PATCH \
  -H 'content-type: application/json' \
  -d "{\"provider\":\"dsh\",\"providerConfig\":{\"cwd\":\"$CW/dsh\",\"profile\":\"$PROFILE\",\"dshBin\":\"dsh\",\"permission\":\"workspace-write\"}}" "$BASE/api/bots/$BOTD")
if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/switch2.json" 'o.bot.provider')" = dsh ]; then
  ok "PATCH $BOTD provider claude→dsh → 200 (dsh profile re-materialized on the switch back)"
else
  bad "PATCH $BOTD claude→dsh → HTTP $HTTP: $(cat "$DATADIR/switch2.json")"
fi
probe "$BOTD" "$DATADIR/switch2.test.json"
if [ "$HTTP" = 200 ] && [ "$CODE" = completed ]; then
  ok "switch round 2: $BOTD back on dsh → /test completed, sessionId=$SID finalText='${FINAL}'"
else
  bad "switch round 2 (dsh) → HTTP $HTTP code=${CODE:-none}: $(cat "$DATADIR/switch2.test.json")"
fi

# —— operator views ————————————————————————————————————————————————————————
# /test is the PROBE contract: it runs the runner directly and never journals
# a ledger row — so the honest assertion is that the ledger STAYS empty across
# every probe above. Real cross-provider row growth (7 rows, provider sequence
# dsh,dsh,claude,claude,codex,codex,dsh) is proven by `npm run test:matrix` S3.
for B in "$BOTD" "$BOTC" "$BOTX"; do
  HTTP=$(curl -sS --max-time 10 -o "$DATADIR/$B.ledger.json" -w '%{http_code}' "$BASE/api/ledger?bot=$B")
  N="$(jget "$DATADIR/$B.ledger.json" 'Array.isArray(o)?o.length:"not-an-array"')"
  if [ "$HTTP" = 200 ] && [ "$N" = 0 ]; then
    ok "GET /api/ledger?bot=$B → 200, 0 rows (probe isolation: /test never journals)"
  else
    bad "GET /api/ledger?bot=$B → HTTP $HTTP rows=${N:-none}: $(cat "$DATADIR/$B.ledger.json")"
  fi
done

HTTP=$(curl -sS --max-time 10 -o "$DATADIR/agents.json" -w '%{http_code}' "$BASE/api/agents")
N="$(jget "$DATADIR/agents.json" 'o.agents.length')"
BADAG="$(jget "$DATADIR/agents.json" 'o.agents.filter(a=>a.status!=="offline"||a.enabled!==false).length')"
HAVE="$(jget "$DATADIR/agents.json" "['$BOTD','$BOTC','$BOTX'].every(id=>o.agents.some(a=>a.id===id))")"
if [ "$HTTP" = 200 ] && [ "$N" = 3 ] && [ "$BADAG" = 0 ] && [ "$HAVE" = true ]; then
  ok "GET /api/agents → 3 bots present, all offline + disabled (enabled:false — wecom never attached)"
else
  bad "GET /api/agents → HTTP $HTTP n=${N:-none} bad=${BADAG:-none}: $(cat "$DATADIR/agents.json")"
fi

# —— delete → removeConfig evidence ————————————————————————————————————————
for B in "$BOTD" "$BOTC" "$BOTX"; do
  HTTP=$(curl -sS --max-time 10 -o "$DATADIR/$B.del.json" -w '%{http_code}' -X DELETE "$BASE/api/bots/$B")
  if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/$B.del.json" 'o.ok')" = true ]; then
    ok "DELETE /api/bots/$B → ok"
  else
    bad "DELETE /api/bots/$B → HTTP $HTTP: $(cat "$DATADIR/$B.del.json")"
  fi
done
if [ ! -e "$PROFILE_DIR" ]; then
  ok "removeConfig: profile dir $PROFILE_DIR removed with the bot"
else
  bad "removeConfig: profile dir $PROFILE_DIR still exists after DELETE"
fi
HTTP=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/bots/$BOTD/test")
if [ "$HTTP" = 404 ]; then ok "bot gone: POST /test now 404"; else bad "bot still reachable after DELETE (POST /test → HTTP $HTTP)"; fi

# —— SIGINT stop → lock released + port free ————————————————————————————————
kill -INT "$SERVER_PID"
STOP_RC=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  bad "server did not exit within 15s of SIGINT"
  kill -TERM "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
else
  wait "$SERVER_PID" 2>/dev/null; STOP_RC=$?
  if [ "$STOP_RC" = 0 ]; then ok "SIGINT → graceful stop (exit 0)"; else bad "SIGINT stop exited $STOP_RC"; fi
fi
if [ ! -e "$DATADIR/.lock" ]; then ok "data dir lock released ($DATADIR/.lock gone)"; else bad "lock dir still present after stop"; fi
if ! curl -sS --max-time 2 -o /dev/null "$BASE/healthz" 2>/dev/null; then
  ok "port $PORT free after stop"
else
  bad "something still answers on $PORT after stop"
fi
SERVER_PID=""

echo
if [ "$FAIL" = 0 ]; then
  echo "accept-m2: PASS (doctor clean, dsh+claude+codex probe×2 each with resume, switch dsh→claude→dsh, agents/ledger views, profile cleanup, SIGINT clean stop)"
  exit 0
fi
echo "accept-m2: FAIL (see ✗ lines above; server log tail below)"
tail -30 "$SERVER_LOG"
exit 1
