#!/bin/bash
# M1 acceptance run (Task 20) — the scripted, reproducible REAL-dsh acceptance:
# boots the real kernel (`node src/index.js start`), creates a bot over the
# real API (provider dsh, real ~/.dsh profile materialization), runs the real
# /api/bots/:id/test probe TWICE against the local dsh CLI (no WeCom — the bot
# is saved enabled:false so the channel never connects), then deletes the bot
# and asserts the materialized profile went with it, stops the server with
# SIGINT and asserts the lock released + port freed.
#
# Not part of `npm test`: it needs a real dsh install (and its credentials).
# Skips cleanly (exit 0) when dsh is not on PATH (same convention as
# smoke-dsh.sh / probe.sh).
#
#   usage: bash test/accept-m1.sh
#
# Session/resume note: the /api/bots/:id/test endpoint passes sessionId:null
# on every call by contract (a probe run is engine-independent), so round 2
# mints a NEW session — the script prints both sessionIds and this behavior.
# Cross-round resume evidence lives in test/smoke-dsh.sh (round 2 resumes
# round 1's sessionId and must remember the code word).
set -u
cd "$(dirname "$0")/.."

if ! command -v dsh >/dev/null 2>&1; then
  echo "accept-m1: skip (dsh not found in PATH)"
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "accept-m1: FAIL (curl required but not found in PATH)"
  exit 1
fi

PORT=18792
BASE="http://127.0.0.1:${PORT}"
DATADIR="$(mktemp -d /tmp/wao-accept-data.XXXXXX)"
BOTCWD="$(mktemp -d /tmp/wao-accept-cwd.XXXXXX)"
SERVER_LOG="$(mktemp /tmp/wao-accept-server.XXXXXX.log)"
BOT=m1-accept
PROFILE=wecom-m1-accept
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
  rm -rf "$DATADIR" "$BOTCWD" "$SERVER_LOG"
  rm -rf "$PROFILE_DIR"   # leftover profile must not outlive a failed run
}
trap cleanup EXIT

jget() { # jget <file> <js-expr over o> — extract from a JSON file
  node -e 'const o=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(eval(process.argv[2])??"")' "$1" "$2"
}

echo "accept-m1: $(date '+%Y-%m-%d %H:%M:%S')  node $(node --version)  $(dsh --version 2>/dev/null | head -1)"
echo "accept-m1: data $DATADIR / bot cwd $BOTCWD / profile $PROFILE_DIR"

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

# —— create the bot (enabled:false — wecom never connects in M1 acceptance) ———
CREATE_BODY=$(cat <<JSON
{
  "id": "$BOT",
  "name": "M1 验收",
  "enabled": false,
  "channel": "wecom",
  "account": { "botId": "accept-test", "secret": "x" },
  "provider": "dsh",
  "providerConfig": { "cwd": "$BOTCWD", "profile": "$PROFILE", "dshBin": "dsh", "permission": "workspace-write" }
}
JSON
)
HTTP=$(curl -sS --max-time 10 -o "$DATADIR/create.json" -w '%{http_code}' \
  -X POST -H 'content-type: application/json' -d "$CREATE_BODY" "$BASE/api/bots")
if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/create.json" 'o.bot.id')" = "$BOT" ]; then
  ok "POST /api/bots → 200, bot $BOT persisted (enabled:false, wecom untouched)"
else
  bad "POST /api/bots → HTTP $HTTP: $(cat "$DATADIR/create.json")"
fi
if grep -q '"secret"' "$DATADIR/create.json"; then bad "create response echoed the secret"; else ok "create response does not echo the secret"; fi

# —— materializeConfig evidence: the real dsh profile exists on disk —————————
if [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  ok "materializeConfig: $PROFILE_DIR/cordis.patch.yml written"
else
  bad "materializeConfig: $PROFILE_DIR/cordis.patch.yml missing"
fi
if grep -q 'agent-default-model' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  ok "profile patch carries the agent-default-model row"
else
  bad "profile patch lacks agent-default-model row"
fi

# —— real dsh probe, round 1 ———————————————————————————————————————————————
HTTP=$(curl -sS --max-time 90 -o "$DATADIR/test1.json" -w '%{http_code}' -X POST "$BASE/api/bots/$BOT/test")
CODE1="$(jget "$DATADIR/test1.json" 'o.code')"
FINAL1="$(jget "$DATADIR/test1.json" 'o.finalText')"
SID1="$(jget "$DATADIR/test1.json" 'o.sessionId')"
if [ "$HTTP" = 200 ] && [ "$CODE1" = completed ] && [ -n "$FINAL1" ]; then
  ok "POST /api/bots/$BOT/test round 1 → completed, finalText='${FINAL1}'"
else
  bad "test round 1 → HTTP $HTTP code=${CODE1:-none} finalText='${FINAL1:-}' : $(cat "$DATADIR/test1.json")"
fi

# —— real dsh probe, round 2 (probe contract: sessionId:null → NEW session) ——
HTTP=$(curl -sS --max-time 90 -o "$DATADIR/test2.json" -w '%{http_code}' -X POST "$BASE/api/bots/$BOT/test")
CODE2="$(jget "$DATADIR/test2.json" 'o.code')"
FINAL2="$(jget "$DATADIR/test2.json" 'o.finalText')"
SID2="$(jget "$DATADIR/test2.json" 'o.sessionId')"
if [ "$HTTP" = 200 ] && [ "$CODE2" = completed ] && [ -n "$FINAL2" ]; then
  ok "POST /api/bots/$BOT/test round 2 → completed, finalText='${FINAL2}'"
else
  bad "test round 2 → HTTP $HTTP code=${CODE2:-none} finalText='${FINAL2:-}' : $(cat "$DATADIR/test2.json")"
fi
echo "  sessionId round1=${SID1:-none} round2=${SID2:-none}"
if [ -n "$SID1" ] && [ -n "$SID2" ] && [ "$SID1" != "$SID2" ]; then
  ok "round 2 minted a new session (expected: /test passes sessionId:null by contract; cross-round resume evidence = test/smoke-dsh.sh)"
elif [ -n "$SID1" ]; then
  echo "  ! rounds share sessionId ($SID1) — not the /test contract's promise; check provider-dsh"
fi

# —— delete → removeConfig evidence ————————————————————————————————————————
HTTP=$(curl -sS --max-time 10 -o "$DATADIR/del.json" -w '%{http_code}' -X DELETE "$BASE/api/bots/$BOT")
if [ "$HTTP" = 200 ] && [ "$(jget "$DATADIR/del.json" 'o.ok')" = true ]; then
  ok "DELETE /api/bots/$BOT → ok"
else
  bad "DELETE /api/bots/$BOT → HTTP $HTTP: $(cat "$DATADIR/del.json")"
fi
if [ ! -e "$PROFILE_DIR" ]; then
  ok "removeConfig: profile dir $PROFILE_DIR removed with the bot"
else
  bad "removeConfig: profile dir $PROFILE_DIR still exists after DELETE"
fi
HTTP=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/bots/$BOT/test")
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
  echo "accept-m1: PASS (real dsh probe ×2 completed, profile materialized+removed, SIGINT clean stop)"
  exit 0
fi
echo "accept-m1: FAIL (see ✗ lines above; server log tail below)"
tail -30 "$SERVER_LOG"
exit 1
