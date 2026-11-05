#!/usr/bin/env bash
# probe.sh — real-CLI 基线固化 / 漂移检测 (DESIGN §5.1)。
#
#   bash test/probe.sh            # baseline capture (default): minimal probes for
#                                 # dsh / claude / codex → test/probe-baselines/<cli>.ndjson
#                                 # (raw NDJSON + header comments), plus two special
#                                 # probes: dsh kill-then-resume, codex resume+stdin sentinel.
#   bash test/probe.sh --check    # re-run the three minimal probes and compare EVENT-TYPE
#                                 # SEQUENCES against the baselines; drift → diff + exit 1.
#
# Comparison semantics: the baseline stores the RAW type-per-line sequence; the
# check compares run-length-collapsed sequences on both sides — the COUNT of
# repeated events (claude thinking_tokens bursts, dsh text chunks) is model
# behavior, not protocol; the ORDER and presence of event types is the contract.
#
# Never hangs: every probe runs under a 150s kill cap (node-based runner —
# macOS ships no GNU timeout). Missing CLIs are skipped loudly, never fatal.
# All writes are atomic (tmp file + mv in the same directory).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$SCRIPT_DIR/probe-baselines"
TIMEOUT_SECS=150
PROMPT='只回复两个字：收到'
SENTINEL='现在只回复三个字：收到了'
LONG_PROMPT='请慢慢从 1 数到 30，每个数字单独一行输出'

# run_timed <secs> <cmd...> — stdin/stdout/stderr inherited; 124 on timeout
# (timeout(1) convention), 127 when the binary cannot spawn.
run_timed() {
  local secs="$1"; shift
  node -e '
    const { spawn } = require("node:child_process");
    const secs = Number(process.argv[1]);
    const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ["inherit", "inherit", "inherit"] });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, secs * 1000);
    t.unref?.();
    child.on("error", (e) => { console.error("spawn failed:", e.message); process.exit(127); });
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      if (signal === "SIGKILL" && code == null) process.exit(124);
      process.exit(code == null ? 124 : code);
    });
  ' "$secs" "$@"
}

# types_of <file> — one .type per JSON line ('#'-comment lines skipped).
types_of() {
  node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    const out = [];
    for (const l of lines) {
      try { out.push(String(JSON.parse(l).type ?? "(no-type)")); }
      catch { out.push("(nonjson)"); }
    }
    process.stdout.write(out.length ? out.join("\n") + "\n" : "");
  ' types "$1"
}

# collapse_of <file> — run-length-collapsed type sequence (the compared form).
collapse_of() {
  types_of "$1" | node -e '
    let prev = null;
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const out = [];
      for (const l of s.split("\n")) if (l !== "" && l !== prev) { out.push(l); prev = l; }
      process.stdout.write(out.length ? out.join("\n") + "\n" : "");
    });
  '
}

atomic_write() { # atomic_write <dest> <src-tmp>
  mv -f "$2" "$1"
}

have() { command -v "$1" >/dev/null 2>&1; }

# —— the three minimal probes ————————————————————————————————————————————————

capture_dsh() { # capture_dsh <out-tmp>; prints exit code
  printf '%s' "$PROMPT" | run_timed "$TIMEOUT_SECS" dsh --profile headless --json - >"$1" 2>/dev/null
  echo $?
}

capture_claude() {
  run_timed "$TIMEOUT_SECS" claude -p "$PROMPT" --output-format stream-json --verbose >"$1" 2>/dev/null
  echo $?
}

capture_codex() {
  printf '%s' "$PROMPT" | run_timed "$TIMEOUT_SECS" codex exec --json --skip-git-repo-check - >"$1" 2>/dev/null
  echo $?
}

NOW="$(date +%Y-%m-%d)"

save_minimal() { # save_minimal <cli> <capture-fn>
  local cli="$1" fn="$2" tmp rc
  if ! have "$cli"; then
    echo "skip  $cli: not installed"
    return 0
  fi
  tmp="$(mktemp "$BASE_DIR/.tmp-${cli}.XXXXXX")"
  rc="$("$fn" "$tmp")"
  {
    echo "# ${cli} minimal probe — raw NDJSON as captured (stdin prompt: ${PROMPT})"
    echo "# captured ${NOW}; exit=${rc}; compare = run-length-collapsed .type sequence (bash test/probe.sh --check)"
    cat "$tmp"
  } > "${tmp}.typed"
  local count
  count="$(types_of "${tmp}.typed" | wc -l | tr -d ' ')"
  atomic_write "$BASE_DIR/${cli}.ndjson" "${tmp}.typed"
  rm -f "$tmp"
  echo "saved $BASE_DIR/${cli}.ndjson (exit=${rc}, ${count} event types)"
}

# —— special probe: dsh kill-then-resume ——————————————————————————————————————

probe_dsh_kill_resume() {
  local kill_out resume_out sid rc_kill rc_resume resume_sid first_types
  if ! have dsh; then
    echo "skip  dsh kill-resume probe: dsh not installed"
    return 0
  fi
  kill_out="$(mktemp "$BASE_DIR/.tmp-dkr-a.XXXXXX")"
  resume_out="$(mktemp "$BASE_DIR/.tmp-dkr-b.XXXXXX")"
  printf '%s' "$LONG_PROMPT" | run_timed 2 dsh --profile headless --json - >"$kill_out" 2>/dev/null
  rc_kill=$?
  sid="$(node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const o = JSON.parse(l); if (o.type === "session" && o.sessionId) { process.stdout.write(o.sessionId); process.exit(0); } } catch {}
    }
  ' "$kill_out")"
  if [ -n "$sid" ]; then
    printf '%s' '继续刚才的任务' | run_timed "$TIMEOUT_SECS" dsh --profile headless --json --session-id "$sid" - >"$resume_out" 2>/dev/null
    rc_resume=$?
  else
    rc_resume=skipped
  fi
  resume_sid="$(node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const o = JSON.parse(l); if (o.type === "session" && o.sessionId) { process.stdout.write(o.sessionId); process.exit(0); } } catch {}
    }
  ' "$resume_out")"
  first_types="$(types_of "$resume_out" | head -5 | tr '\n' ' ')"
  {
    echo "# dsh kill-then-resume probe — captured ${NOW}"
    echo "# kill: SIGKILL at 2s on a long prompt → runner exit=${rc_kill}; session line before the kill: $([ -n "$sid" ] && echo yes || echo no)"
    if [ "$rc_resume" = skipped ]; then
      echo "# resume: SKIPPED — the killed run emitted no session line, nothing to resume"
    elif [ "$rc_resume" = 0 ] && [ "$resume_sid" = "$sid" ]; then
      echo "# resume: WORKS — \`dsh --session-id <killed-sid>\` exits 0 and echoes the SAME sessionId (context survived the SIGKILL)"
    else
      echo "# resume: FAILED — exit=${rc_resume}, session echo='${resume_sid:-none}' (expected '${sid}')"
    fi
    echo "# resume first event types: ${first_types:-none}"
    echo "# ---- killed run output (raw, as captured) ----"
    cat "$kill_out"
    echo "# ---- resume run output (raw, first 5 JSON lines) ----"
    head -5 "$resume_out"
  } > "${kill_out}.final"
  atomic_write "$BASE_DIR/dsh-kill-resume.ndjson" "${kill_out}.final"
  rm -f "$kill_out" "$resume_out"
  echo "saved $BASE_DIR/dsh-kill-resume.ndjson (kill exit=${rc_kill}, resume exit=${rc_resume})"
}

# —— special probe: codex resume + stdin sentinel ————————————————————————————

probe_codex_resume_stdin() {
  local first_out resume_out tid rc1 rc2 reply
  if ! have codex; then
    echo "skip  codex resume-stdin probe: codex not installed"
    return 0
  fi
  first_out="$(mktemp "$BASE_DIR/.tmp-crs-a.XXXXXX")"
  resume_out="$(mktemp "$BASE_DIR/.tmp-crs-b.XXXXXX")"
  printf '%s' "$PROMPT" | run_timed "$TIMEOUT_SECS" codex exec --json --skip-git-repo-check - >"$first_out" 2>/dev/null
  rc1=$?
  tid="$(node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const o = JSON.parse(l); if (o.type === "thread.started" && o.thread_id) { process.stdout.write(o.thread_id); process.exit(0); } } catch {}
    }
  ' "$first_out")"
  if [ -n "$tid" ]; then
    printf '%s' "$SENTINEL" | run_timed "$TIMEOUT_SECS" codex exec resume "$tid" --json --skip-git-repo-check - >"$resume_out" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  reply="$(node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const o = JSON.parse(l); if (o.type === "item.completed" && o.item?.text) { process.stdout.write(String(o.item.text).slice(0, 60)); process.exit(0); } } catch {}
    }
  ' "$resume_out")"
  {
    echo "# codex resume+stdin sentinel probe — captured ${NOW}"
    echo "# first run: \`codex exec --json --skip-git-repo-check -\` exit=${rc1}; thread_id=$([ -n "$tid" ] && echo captured || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# resume: SKIPPED — first run emitted no thread.started, nothing to resume"
    elif [ "$rc2" = 0 ]; then
      echo "# resume: WORKS — \`codex exec resume <tid> --json -\` accepts the STDIN sentinel prompt and answers it"
      echo "# sentinel reply (first 60 chars): ${reply:-none}"
    else
      echo "# resume: FAILED — exit=${rc2}; sentinel reply: ${reply:-none}"
    fi
    echo "# ---- first run output (raw) ----"
    cat "$first_out"
    echo "# ---- resume run output (raw, first 6 JSON lines) ----"
    head -6 "$resume_out"
  } > "${first_out}.final"
  atomic_write "$BASE_DIR/codex-resume-stdin.ndjson" "${first_out}.final"
  rm -f "$first_out" "$resume_out"
  echo "saved $BASE_DIR/codex-resume-stdin.ndjson (first exit=${rc1}, resume exit=${rc2})"
}

# —— check mode ——————————————————————————————————————————————————————————————

check_minimal() { # check_minimal <cli> <capture-fn>
  local cli="$1" fn="$2" base tmp drift=0
  base="$BASE_DIR/${cli}.ndjson"
  if ! have "$cli"; then
    echo "skip  $cli: not installed"
    return 0
  fi
  if [ ! -f "$base" ]; then
    echo "DRIFT $cli: no baseline at $base (run: bash test/probe.sh)"
    return 1
  fi
  tmp="$(mktemp)"
  "$fn" "$tmp" >/dev/null
  if [ "$(collapse_of "$base")" = "$(collapse_of "$tmp")" ]; then
    echo "ok    $cli: event-type sequence matches the baseline"
    rm -f "$tmp"
    return 0
  fi
  echo "DRIFT $cli: event-type sequence changed vs $base"
  diff -u <(collapse_of "$base") <(collapse_of "$tmp") | sed 's/^/      /'
  rm -f "$tmp"
  return 1
}

# —— main —————————————————————————————————————————————————————————————————————

MODE="${1:-capture}"
mkdir -p "$BASE_DIR"

case "$MODE" in
  capture)
    echo "probe: capturing baselines into $BASE_DIR (timeout ${TIMEOUT_SECS}s per probe)"
    save_minimal dsh capture_dsh
    save_minimal claude capture_claude
    save_minimal codex capture_codex
    probe_dsh_kill_resume
    probe_codex_resume_stdin
    echo "probe: baselines captured (git add $BASE_DIR/*.ndjson)"
    ;;
  --check)
    echo "probe: checking event-type sequences against $BASE_DIR"
    fail=0
    check_minimal dsh capture_dsh || fail=1
    check_minimal claude capture_claude || fail=1
    check_minimal codex capture_codex || fail=1
    if [ "$fail" = 1 ]; then
      echo "probe: DRIFT detected — update baselines deliberately (bash test/probe.sh && git add), never blindly"
      exit 1
    fi
    echo "probe: all event-type sequences match the baselines"
    ;;
  *)
    echo "usage: bash test/probe.sh [--check]" >&2
    exit 2
    ;;
esac
