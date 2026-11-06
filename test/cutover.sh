#!/bin/bash
# Cutover helper (M3 T9) — SEMI-AUTOMATED, deliberately NOT self-running.
#
# Each subcommand covers one runbook step-group (docs/CUTOVER.md) with the
# step's assertions built in; the controller invokes them ONE AT A TIME and
# eyeballs the output between steps. Nothing here is scheduled or chained.
#
#   usage: bash test/cutover.sh baseline|stage1-main|stage2-bot2|drill|rollback
#
# Idempotent: sub-steps already done (bot created / table archived / old
# bridge dead) are skipped with a note. A failed assertion exits 1 — fix the
# cause and re-run the SAME subcommand to resume from where it stopped.
#
# Targets PRODUCTION endpoints (default: new service 127.0.0.1:8792, old
# bridge 127.0.0.1:8791). This is the cutover tool, not part of `npm test`.
# Secrets only ever flow old-bots.json -> temp request file (0600) -> curl;
# never echoed, never logged.
#
# Env overrides: WAO_PORT, OLD_HEALTH_PORT, OLD_BRIDGE_DIR, ARCHIVE_DIR.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WAO_PORT="${WAO_PORT:-8792}"
OLD_HEALTH_PORT="${OLD_HEALTH_PORT:-8791}"
OLD_BRIDGE_DIR="${OLD_BRIDGE_DIR:-$REPO/../wecom-bridge}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/tmp/wao-cutover}"
NEW="http://127.0.0.1:${WAO_PORT}"
OLD="http://127.0.0.1:${OLD_HEALTH_PORT}"

ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; }
die()  { bad "$1"; exit 1; }
skip() { echo "  - $1 (skip: already done)"; }
note() { echo "  · $1"; }

need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

# HTTP body via temp file (0600) so secrets never touch argv/ps.
body_file() { mkdir -p "$ARCHIVE_DIR"; chmod 700 "$ARCHIVE_DIR" 2>/dev/null; touch "$ARCHIVE_DIR/req.json"; chmod 600 "$ARCHIVE_DIR/req.json"; echo "$ARCHIVE_DIR/req.json"; }

http_code() { # http_code <url> [curl args...] -> "code body"
  local url="$1"; shift
  local out; out=$(curl -sS --max-time 5 -w '\n%{http_code}' "$@" "$url" 2>/dev/null) || return 1
  echo "$out"
}

wait_until() { # wait_until <seconds> <desc> <cmd...>
  local secs="$1" desc="$2"; shift 2
  local i
  for ((i = 0; i < secs * 2; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "  ✗ timeout ${secs}s: $desc"; return 1
}

agent_online() { # agent_online <botId> -> 0 when that bot reports channelState online
  local bot="$1"
  curl -s --max-time 3 "$NEW/api/agents" | jq -e --arg b "$bot" \
    'any(.agents[]; .id==$b and .channelState.state=="online")' >/dev/null
}

old_health() { curl -s --max-time 2 "$OLD/healthz" 2>/dev/null; }

# ————————————————————————————————— baseline —————————————————————————————————
cmd_baseline() {
  echo "baseline: 前置检查（CUTOVER.md §1） — $(date '+%F %T')"
  need curl "curl required"; need jq "jq required"
  mkdir -p "$ARCHIVE_DIR"; chmod 700 "$ARCHIVE_DIR" 2>/dev/null

  # 1. new service alive + plugins all active
  local body
  body=$(curl -s --max-time 3 "$NEW/healthz" || true)
  echo "$body" | jq -e '.ok == true' >/dev/null || die "new service /healthz not ok on :$WAO_PORT (launchctl list | grep wecom-agent-office; 先起服再跑 baseline)"
  ok "new /healthz ok (:$WAO_PORT)"

  body=$(curl -s --max-time 3 "$NEW/api/state")
  echo "$body" | jq -e '[.plugins[] | select(.status=="failed")] | length == 0' >/dev/null \
    || die "plugin(s) failed: $(echo "$body" | jq -c '[.plugins[] | select(.status=="failed") | .id]')"
  ok "plugins all active: $(echo "$body" | jq -r '[.plugins[].id] | join(", ")')"

  # 2. new bots table empty (escape hatch for reruns)
  body=$(curl -s --max-time 3 "$NEW/api/bots")
  local n; n=$(echo "$body" | jq '.bots | length')
  if [ "$n" = "0" ]; then ok "new bots table empty"; else
    if [ "${WAO_ALLOW_BOTS:-0}" = "1" ]; then note "bots table has $n entr(y|ies) — allowed via WAO_ALLOW_BOTS=1: $(echo "$body" | jq -c '[.bots[].id]')"; else
      die "new bots table not empty: $(echo "$body" | jq -c '[.bots[].id]') — 误带历史 bot 会连线；确认预期后 WAO_ALLOW_BOTS=1 重跑"
    fi
  fi

  # 3. launchd PATH covers the three CLI bins
  local plist="$HOME/Library/LaunchAgents/com.wecom-agent-office.plist"
  [ -f "$plist" ] || die "launchd plist not installed at $plist (docs/launchd.plist 三步)"
  local plpath
  plpath=$(sed -n '/<key>PATH<\/key>/,/<\/string>/p' "$plist" | grep -o '<string>.*</string>' | sed 's/<[^>]*>//g')
  [ -n "$plpath" ] || die "cannot read PATH from $plist"
  local cli ok3=0
  for cli in dsh claude codex; do
    local bin; bin=$(command -v "$cli" 2>/dev/null) || { note "cli $cli 不在本机 PATH（信息行，不拦截）"; continue; }
    case "$plpath" in
      *"$(dirname "$bin")"*) ok "plist PATH covers $cli ($bin)"; ok3=$((ok3+1)) ;;
      *) bad "plist PATH misses $cli bin dir ($(dirname "$bin")) — launchd 下 provider 将静默失联，先修 plist 再切换" && return 1 ;;
    esac
  done
  note "PATH 检查完成（在位 CLI $ok3/3 覆盖）"

  # 4. old bridge baseline (rollback reference)
  body=$(old_health)
  if [ -n "$body" ] && echo "$body" | jq -e '.ok == true' >/dev/null 2>&1; then
    printf '%s\n' "$body" > "$ARCHIVE_DIR/old-healthz-baseline.json"; chmod 600 "$ARCHIVE_DIR/old-healthz-baseline.json"
    ok "old bridge ALIVE on :$OLD_HEALTH_PORT — baseline saved to $ARCHIVE_DIR/old-healthz-baseline.json"
    echo "$body" | jq -c '.bots[] | {id, connected, subscribed, callbacks: .inbound.callbacks}' | sed 's/^/    /'
  else
    printf '{"ok":false,"observed":"%s"}\n' "$(date '+%F %T')" > "$ARCHIVE_DIR/old-healthz-baseline.json"
    note "old bridge NOT serving on :$OLD_HEALTH_PORT（撰写时观测一致）——记录为基线；§2.5/2.6 将幂等直过，SIGTERM 无对象"
  fi

  echo "baseline: PASS — 逐条核对上面输出后进入 stage1-main（CUTOVER.md §2）"
}

# ————————————————— stage (per bot) ————————————————————————————————————————
latest_archive() { ls -1t "$OLD_BRIDGE_DIR"/bots.json.archive-* 2>/dev/null | head -1; }

creds_source() { # -> file containing the real (non-empty) bot table
  local live="$OLD_BRIDGE_DIR/bots.json"
  if [ -f "$live" ] && [ "$(jq '.bots | length' "$live" 2>/dev/null || echo 0)" != "0" ]; then echo "$live"; return 0; fi
  local arch; arch=$(latest_archive) || true
  [ -n "$arch" ] && echo "$arch" && return 0
  return 1
}

cmd_stage() { # cmd_stage <botId>
  local BOT="${1:?bot id required}"
  echo "stage-$BOT: 逐 bot 切换（CUTOVER.md §2，先 main 后 bot2） — $(date '+%F %T')"
  need curl "curl required"; need jq "jq required"
  mkdir -p "$ARCHIVE_DIR"; chmod 700 "$ARCHIVE_DIR" 2>/dev/null

  # 2.1 read old credentials (secret stays out of the terminal)
  local src; src=$(creds_source) || die "no non-empty bots.json and no bots.json.archive-* under $OLD_BRIDGE_DIR"
  note "credentials source: $src"
  local old
  old=$(jq -e --arg id "$BOT" '.bots[] | select(.id==$id)' "$src") || die "bot $BOT not found in $src"
  echo "$old" | jq -e '.botId and .secret' >/dev/null || die "old record missing botId/secret"
  ok "old record loaded: id=$BOT name=$(echo "$old" | jq -r .name) profile=$(echo "$old" | jq -r .profile) (secret not shown)"

  # 2.2 create on the new service, enabled:false (idempotent on rerun)
  local exists
  exists=$(curl -s --max-time 3 "$NEW/api/bots" | jq --arg b "$BOT" '[.bots[] | select(.id==$b)] | length')
  if [ "$exists" != "0" ]; then
    local cur0; cur0=$(curl -s --max-time 3 "$NEW/api/bots" | jq --arg b "$BOT" '.bots[] | select(.id==$b)')
    if echo "$cur0" | jq -e '.enabled == false' >/dev/null; then
      skip "bot $BOT already exists on :$WAO_PORT (enabled:false)"
    else
      skip "bot $BOT already exists AND enabled — cutover moment already passed; resuming checks"
    fi
  else
    local req; req=$(body_file)
    jq -n --argjson o "$old" '{
        id: $o.id, name: $o.name, enabled: false, channel: "wecom",
        account: ({botId: $o.botId, secret: $o.secret}
                   + (if $o.wsUrl then {wsUrl: $o.wsUrl} else {} end)),
        allowedUsers: ($o.allowedUsers // []),
        provider: "dsh",
        providerConfig: ({cwd: $o.cwd, model: $o.model, permission: $o.permission,
                          prompt: $o.prompt, writableDirs: $o.writableDirs, compaction: $o.compaction}
                         + (if $o.profile then {profile: $o.profile} else {} end))
      }' > "$req"
    local out; out=$(http_code "$NEW/api/bots" -X POST -H 'content-type: application/json' --data-binary "@$req")
    local code; code=$(echo "$out" | tail -1); local resp; resp=$(echo "$out" | sed '$d')
    [ "$code" = "200" ] || die "POST /api/bots -> $code: $resp"
    echo "$resp" | grep -q '"secret"' && die "create response echoed the secret (不可能——API 清洗面破坏，立即人工排查)"
    echo "$resp" | jq -e '.bot.enabled == false' >/dev/null || die "created bot is not enabled:false"
    ok "POST /api/bots -> 200, enabled:false, secret not echoed; dsh profile materialized: ~/.dsh/profiles/$(echo "$old" | jq -r '.profile // "wecom-" + .id')/"
    rm -f "$req"
  fi

  # 2.3 config cross-check against the old record (hash compare, no dump)
  local cur; cur=$(curl -s --max-time 3 "$NEW/api/bots" | jq --arg b "$BOT" '.bots[] | select(.id==$b)')
  local a b
  a=$(echo "$cur" | jq -cS '{name, botId: .account.botId, allowedUsers: (.allowedUsers // []), pc: (.providerConfig | {cwd, profile, model, permission, prompt, writableDirs, compaction})}' | shasum | cut -d' ' -f1)
  b=$(echo "$old" | jq -cS '{name, botId, allowedUsers: (.allowedUsers // []), pc: ({cwd, model, permission, prompt, writableDirs, compaction} + (if .profile then {profile} else {} end))}' | shasum | cut -d' ' -f1)
  [ "$a" = "$b" ] || die "config mismatch new-vs-old (逐字段 PATCH 修正后重跑本步): new=$(echo "$cur" | jq -c '{name, botId:.account.botId, allowedUsers, pc:(.providerConfig|{cwd,profile,model,permission,writableDirs,compaction})}')"
  ok "config matches the old record (name/botId/allowedUsers/cwd/profile/model/permission/prompt/writableDirs/compaction)"

  # 2.4 archive old bots.json: cp backup + write empty table (idempotent)
  local live="$OLD_BRIDGE_DIR/bots.json"
  if [ "$(jq '.bots | length' "$live" 2>/dev/null || echo 0)" != "0" ]; then
    local arch="$OLD_BRIDGE_DIR/bots.json.archive-$(date +%Y%m%d-%H%M%S)"
    cp "$live" "$arch" && printf '{"bots":[]}' > "$live"
    [ "$(jq '.bots | length' "$live")" = "0" ] && [ "$(jq '.bots | length' "$arch")" != "0" ] \
      || die "archive/empty-table verification failed — inspect $OLD_BRIDGE_DIR manually before continuing"
    ok "archived -> $arch ; bots.json now {\"bots\":[]}（旧桥即便被插件拉起也无 bot 可连）"
  else
    skip "old bots.json already empty (archived: $(latest_archive || echo '—'))"
  fi

  # 2.5 + 2.6 SIGTERM the old bridge (pid from its healthz) and wait it out
  local pid; pid=$(old_health | jq -r '.pid // empty' 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" && ok "SIGTERM sent to old bridge (pid $pid from :$OLD_HEALTH_PORT healthz)"
    wait_until 15 "old bridge pid $pid still alive" bash -c "! kill -0 $pid" || die "old bridge still alive after 15s"
    ok "old bridge exited"
  else
    skip "old bridge not running (no pid via healthz) — nothing to SIGTERM"
  fi
  wait_until 10 ":$OLD_HEALTH_PORT still serving" bash -c "! curl -s --max-time 1 $OLD/healthz" || die "8791 still up — 旧连接未让位，勿继续（互踢风险）"
  ok "old healthz down — 连接已让位（或本就未跑）"

  # 2.7 enable on the new service = the cutover moment
  local cur_en; cur_en=$(echo "$cur" | jq -r '.enabled')
  if [ "$cur_en" = "true" ]; then skip "bot $BOT already enabled (cutover moment passed)"; else
    local out; out=$(http_code "$NEW/api/bots/$BOT/toggle" -X POST)
    [ "$(echo "$out" | tail -1)" = "200" ] || die "toggle -> $(echo "$out" | tail -1): $(echo "$out" | sed '$d')"
    ok "toggle -> enabled:true（切换点：新系统连接企微）"
  fi
  wait_until 30 "bot $BOT not online on :$WAO_PORT" agent_online "$BOT" || {
    curl -s --max-time 3 "$NEW/api/agents" | jq -c --arg b "$BOT" '.agents[] | select(.id==$b) | {status, reason, channelState}' | sed 's/^/    /'
    die "bot $BOT did not reach online — lastError 若为鉴权失败则 secret 抄错（回 2.2 核对；toggle 回 false 即回滚）"
  }
  curl -s --max-time 3 "$NEW/api/agents" | jq -c --arg b "$BOT" '.agents[] | select(.id==$b) | {id, status, channelState: .channelState.state}' | sed 's/^/    /'
  ok "bot $BOT online (idle)"

  # 2.8 outbound verification on an existing chatKey from the old state
  local sess="$OLD_BRIDGE_DIR/state/sessions-$BOT.json"
  [ -f "$sess" ] || die "no $sess — 无既有会话可验证（人工在企微里向该 bot 发一条消息，以回复为终验）"
  local key; key=$(jq -r 'keys[] | select(startswith("single:"))' "$sess" | head -1)
  [ -n "$key" ] || key=$(jq -r 'keys[0]' "$sess")
  [ -n "$key" ] || die "$sess has no chat keys"
  local chatKey="wecom:$key"
  local req; req=$(body_file)
  jq -n --arg b "$BOT" --arg k "$chatKey" \
     '{botId: $b, chatKey: $k, content: ("【wao 切换验证】" + $b + " 出站推送测试 — 收到本条即代表新系统已接管 (" + (now | todate) + ")")}' > "$req"
  local out; out=$(http_code "$NEW/api/send" -X POST -H 'content-type: application/json' --data-binary "@$req"); rm -f "$req"
  [ "$(echo "$out" | tail -1)" = "200" ] || die "POST /api/send -> $(echo "$out" | tail -1): $(echo "$out" | sed '$d')（409=bot offline；400=chatKey 形状）"
  ok "outbound push sent via /api/send to $chatKey"
  note "人工确认：手机/企微客户端真实收到该条后再继续（脚本无法替验送达）"
  echo "stage-$BOT: PASS — main 全绿后跑 stage2-bot2；两 bot 都绿后跑 drill"
}

# ————————————————————————————————— drill —————————————————————————————————
cmd_drill() {
  echo "drill: 冷启动演练（CUTOVER.md §4） — $(date '+%F %T')"
  local uid; uid=$(id -u)
  local label="gui/$uid/com.wecom-agent-office"
  local oldpid; oldpid=$(launchctl list 2>/dev/null | awk '/com\.wecom-agent-office/{print $1}')
  [ -n "$oldpid" ] && [ "$oldpid" != "-" ] || die "launchd service not running: launchctl list | grep wecom-agent-office 首列为 '$oldpid'"
  ok "service running under launchd (pid $oldpid)"

  echo "  · launchctl kickstart -k $label ..."
  launchctl kickstart -k "$label" || die "kickstart failed"
  sleep 2

  wait_until 60 "service not back after kickstart" bash -c "curl -s --max-time 2 $NEW/healthz | jq -e '.ok==true'" \
    || die "service did not come back — 看 DATA_DIR/logs/launchd.err.log"
  ok "KeepAlive 拉活：/healthz ok"

  local bots; bots=$(curl -s --max-time 3 "$NEW/api/bots" | jq -r '[.bots[].id] | join(",")')
  [ -n "$bots" ] || note "bots table empty — drill 只验服务自愈（无 bot 可验自动重连）"
  local b
  for b in $(curl -s --max-time 3 "$NEW/api/bots" | jq -r '.bots[].id'); do
    wait_until 60 "bot $b did not reconnect after cold start" agent_online "$b" \
      || die "bot $b offline after cold start — 查 wao.log 该 bot 段"
    ok "bot $b auto-reconnected (online)"
  done

  local newpid; newpid=$(launchctl list 2>/dev/null | awk '/com\.wecom-agent-office/{print $1}')
  [ "$newpid" != "$oldpid" ] && ok "pid $oldpid -> $newpid (fresh process)" || note "pid 未变（$newpid）——检查 kickstart 是否真的 -k"
  echo "drill: PASS — 冷启动自愈验证完成；24h 检查点见 CUTOVER.md §4 末"
}

# ————————————————————————————————— rollback ——————————————————————————————
cmd_rollback() {
  echo "rollback: 回滚第 1 步（新服让位）+ 2-4 步人工指引（CUTOVER.md §5，顺序固定） — $(date '+%F %T')"
  local out b
  for b in $(curl -s --max-time 3 "$NEW/api/bots" | jq -r '.bots[] | select(.enabled == true) | .id'); do
    out=$(http_code "$NEW/api/bots/$b/toggle" -X POST)
    [ "$(echo "$out" | tail -1)" = "200" ] || die "disable $b failed: $(echo "$out" | sed '$d')"
    echo "$out" | sed '$d' | jq -e '.bot.enabled == false' >/dev/null || die "$b still enabled after toggle"
    ok "step1: new bot $b disabled（防新旧互踢——必须先于一切旧系统操作）"
  done
  curl -s --max-time 3 "$NEW/api/bots" | jq -r '.bots[] | select(.enabled == true) | .id' | grep -q . \
    && die "仍有 enabled bot——重跑本命令"
  ok "step1: 新服已无 enabled bot"
  note "（可选）整服下线：launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist"

  echo "  以下 2-4 步为人工操作（DSH GUI 不由脚本代点），逐条执行并核对："
  local arch; arch=$(latest_archive 2>/dev/null)
  [ -n "$arch" ] || arch="$OLD_BRIDGE_DIR/bots.json.archive-<ts>"
  cat <<EOF
    step2: DSH GUI enable 旧 wecom-bots 插件（自动拉起旧桥，约 1.2s）
    step3: 验证   curl -s localhost:$OLD_HEALTH_PORT/healthz | jq '.bots[] | {id,connected,subscribed}'   # 两 bot connected:true
    step4: 恢复   cp "$arch" "$OLD_BRIDGE_DIR/bots.json"
           （bots.json 由插件写入：GUI 配置在则以 GUI 为准，归档件是文件级兜底；恢复后再看一遍 step3）
    (可选) 留档   curl -s '$NEW/api/export?bot=main' > $ARCHIVE_DIR/main-ledger.md
                  curl -s '$NEW/api/export?bot=bot2' > $ARCHIVE_DIR/bot2-ledger.md
EOF
  echo "rollback: step1 done — 完成 2-4 人工步后，旧系统即恢复承接真实企微流量"
}

case "${1:-}" in
  baseline)     cmd_baseline ;;
  stage1-main)  cmd_stage main ;;
  stage2-bot2)  cmd_stage bot2 ;;
  drill)        cmd_drill ;;
  rollback)     cmd_rollback ;;
  *) cat <<EOF
usage: bash test/cutover.sh baseline|stage1-main|stage2-bot2|drill|rollback

  baseline      CUTOVER.md §1 前置检查（launchd PATH/新旧 healthz/插件/bots 表/基线落盘）
  stage1-main   CUTOVER.md §2 八步，bot=main（读旧凭据→建 bot→核对→归档→停旧桥→接管→出站验证）
  stage2-bot2   同上，bot=bot2（归档/停旧桥步幂等直过；凭据自动改读归档件）
  drill         CUTOVER.md §4 冷启动演练（kickstart -k → healthz/agents 自动恢复）
  rollback      CUTOVER.md §5 固定顺序第 1 步 + 2-4 步人工指引

env: WAO_PORT=$WAO_PORT OLD_HEALTH_PORT=$OLD_HEALTH_PORT OLD_BRIDGE_DIR=$OLD_BRIDGE_DIR ARCHIVE_DIR=$ARCHIVE_DIR
EOF
     exit 2 ;;
esac
