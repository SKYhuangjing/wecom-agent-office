#!/usr/bin/env bash
# probe.sh — real-CLI 基线固化 / 漂移检测 (DESIGN §5.1)。
#
#   bash test/probe.sh            # baseline capture (default): minimal probes for
#                                 # dsh / claude / codex → test/probe-baselines/<cli>.ndjson
#                                 # (raw NDJSON + header comments), plus special probes:
#                                 # dsh kill-then-resume, codex resume+stdin with
#                                 # resume-of-resume thread continuity (Y9 memory),
#                                 # claude resume (X7 memory + session-id contract),
#                                 # claude thinking blocks (informational).
#   bash test/probe.sh --check    # re-run the three minimal probes and compare EVENT-TYPE
#                                 # SEQUENCES against the baselines; drift → diff + exit 1.
#
# Comparison semantics: the baseline stores the RAW type-per-line sequence; the
# check compares run-length-collapsed sequences on both sides — the COUNT of
# repeated events (claude thinking_tokens bursts, dsh text chunks) is model
# behavior, not protocol; the ORDER and presence of event types is the contract.
#
# NOTE-only baselines (claude-resume, claude-thinking, codex-resume-stdin,
# dsh-kill-resume): multi-round / model-output probes whose header comments are
# the deliverable (observed facts for the runners). --check never compares them
# — only the three minimal <cli>.ndjson baselines are compared.
#
# Never hangs: every probe runs under a 150s kill cap (node-based runner —
# macOS ships no GNU timeout). Missing CLIs are skipped loudly, never fatal.
# All writes are atomic (tmp file + mv in the same directory).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$SCRIPT_DIR/probe-baselines"
TIMEOUT_SECS=150
PROMPT='只回复两个字：收到'
LONG_PROMPT='请慢慢从 1 数到 30，每个数字单独一行输出'
CLAUDE_SECRET='记住暗号X7，之后我会问你。现在只回复：好的'
CLAUDE_ASK='暗号是什么？只回复暗号本身'
THINK_PROMPT='先想一下再回答：3的平方加1等于多少？只回复数字'
THINK_MODEL='antigravity/claude-opus-4-6-thinking' # only thinking-branded id in ~/.claude/settings.json modelPicker
CODEX_SECRET='记住暗号Y9，之后我会问你。现在只回复：好的'
CODEX_ASK='暗号是什么？只回复暗号本身'
CODEX_ASK2='暗号还是什么？只回复暗号本身'

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

# claude_sid_of <file> — session_id from the first system/init event ('' if none).
claude_sid_of() {
  node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "system" && o.subtype === "init" && o.session_id) { process.stdout.write(o.session_id); process.exit(0); }
      } catch {}
    }
  ' "$1"
}

# claude_text_of <file> — concatenated assistant text blocks, then result.result
# (the run's final answer; '' if none).
claude_text_of() {
  node -e '
    const fs = require("node:fs");
    let text = "";
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "assistant" && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) if (c.type === "text" && c.text) text += c.text;
        }
        if (o.type === "result" && typeof o.result === "string") text += o.result;
      } catch {}
    }
    process.stdout.write(text.slice(0, 120));
  ' "$1"
}

# claude_thinking_of <file> — 'yes(payload .thinking)' | 'yes(no .thinking field)' | 'no'.
claude_thinking_of() {
  node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "assistant" && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) {
            if (c.type === "thinking") {
              process.stdout.write(c.thinking ? "yes(payload .thinking)" : "yes(no .thinking field)");
              process.exit(0);
            }
          }
        }
      } catch {}
    }
    process.stdout.write("no");
  ' "$1"
}

# codex_tid_of <file> — thread_id from the first thread.started event ('' if none).
codex_tid_of() {
  node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "thread.started" && o.thread_id) { process.stdout.write(o.thread_id); process.exit(0); }
      } catch {}
    }
  ' "$1"
}

# codex_text_of <file> — first agent_message text, 120 chars ('' if none).
codex_text_of() {
  node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "item.completed" && o.item?.type === "agent_message" && o.item.text) {
          process.stdout.write(String(o.item.text).slice(0, 120)); process.exit(0);
        }
      } catch {}
    }
  ' "$1"
}

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
CLAUDE_SECRET='记住暗号X7，之后我会问你。现在只回复：好的'
CLAUDE_ASK='暗号是什么？只回复暗号本身'
THINK_PROMPT='先想一下再回答：3的平方加1等于多少？只回复数字'
THINK_MODEL='antigravity/claude-opus-4-6-thinking' # only thinking-branded id in ~/.claude/settings.json modelPicker
CODEX_SECRET='记住暗号Y9，之后我会问你。现在只回复：好的'
CODEX_ASK='暗号是什么？只回复暗号本身'
CODEX_ASK2='暗号还是什么？只回复暗号本身'

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

# —— special probe: codex resume + stdin + thread continuity (NOTE-only) ———————
# leg1 stores secret Y9 → leg2 resumes and recalls it → leg3 resumes leg2's
# thread (resume-of-resume) and recalls again. All prompts go via stdin '-'.

probe_codex_resume_stdin() {
  local out1 out2 out3 tid1 tid2 tid3 resume2 rc1 rc2 rc3 reply2 reply3 mem2=no mem3=no
  if ! have codex; then
    echo "skip  codex resume-stdin probe: codex not installed"
    return 0
  fi
  out1="$(mktemp "$BASE_DIR/.tmp-crs-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-crs-b.XXXXXX")"
  out3="$(mktemp "$BASE_DIR/.tmp-crs-c.XXXXXX")"
  printf '%s' "$CODEX_SECRET" | run_timed "$TIMEOUT_SECS" codex exec --json --skip-git-repo-check - >"$out1" 2>/dev/null
  rc1=$?
  tid1="$(codex_tid_of "$out1")"
  if [ -n "$tid1" ]; then
    printf '%s' "$CODEX_ASK" | run_timed "$TIMEOUT_SECS" codex exec resume "$tid1" --json --skip-git-repo-check - >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  tid2="$(codex_tid_of "$out2")"
  resume2="${tid2:-$tid1}" # resume-of-resume uses leg2's echoed thread id if it emitted a new one
  if [ "$rc2" != skipped ]; then
    printf '%s' "$CODEX_ASK2" | run_timed "$TIMEOUT_SECS" codex exec resume "$resume2" --json --skip-git-repo-check - >"$out3" 2>/dev/null
    rc3=$?
  else
    rc3=skipped
  fi
  tid3="$(codex_tid_of "$out3")"
  reply2="$(codex_text_of "$out2")"
  reply3="$(codex_text_of "$out3")"
  # memory verdicts precomputed before the output block: bash 3.2 (macOS)
  # cannot parse $(case ...) inline in the echo lines below.
  case "$reply2" in *Y9*) mem2=yes ;; esac
  case "$reply3" in *Y9*) mem3=yes ;; esac
  {
    echo "# codex resume+stdin+thread-continuity probe — captured ${NOW} (NOTE-only: multi-round facts, NOT compared in --check)"
    echo "# leg1: \`codex exec --json --skip-git-repo-check -\` (stdin stores Y9) exit=${rc1}; thread_id=$([ -n "$tid1" ] && echo captured || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# leg2: SKIPPED — leg1 emitted no thread.started, nothing to resume"
    else
      echo "# leg2: \`codex exec resume ${tid1} --json -\` (stdin asks the secret) exit=${rc2}"
      echo "# leg2 thread.started: $([ -n "$tid2" ] && ([ "$tid2" = "$tid1" ] && echo "emitted, SAME id as leg1" || echo "emitted, NEW id ${tid2}") || echo "NOT emitted on resume")"
      echo "# leg2 memory: $( [ "$mem2" = yes ] && echo "RECALLED — reply contains Y9" || echo "NO MEMORY — reply lacks Y9") (reply: ${reply2:-none})"
    fi
    if [ "$rc3" = skipped ]; then
      echo "# leg3: SKIPPED — no leg2 thread to resume"
    else
      echo "# leg3: \`codex exec resume ${resume2} --json -\` (resume-of-resume) exit=${rc3}"
      echo "# leg3 thread.started: $([ -n "$tid3" ] && ([ "$tid3" = "$tid1" ] && echo "emitted, SAME id as leg1" || echo "emitted, NEW id ${tid3}") || echo "NOT emitted on resume")"
      echo "# leg3 memory: $( [ "$mem3" = yes ] && echo "RECALLED — reply contains Y9" || echo "NO MEMORY — reply lacks Y9") (reply: ${reply3:-none})"
    fi
    echo "# stdin: every leg passes its prompt via stdin '-' — runner may always feed stdin, resume included"
    echo "# ---- leg1 output (raw) ----"
    cat "$out1"
    echo "# ---- leg2 output (raw, first 6 JSON lines) ----"
    head -6 "$out2"
    echo "# ---- leg3 output (raw, first 6 JSON lines) ----"
    head -6 "$out3"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/codex-resume-stdin.ndjson" "${out1}.final"
  rm -f "$out1" "$out2" "$out3"
  echo "saved $BASE_DIR/codex-resume-stdin.ndjson (leg1 exit=${rc1}, leg2 exit=${rc2}, leg3 exit=${rc3})"
}

# —— special probe: claude resume — memory + session-id contract (NOTE-only) ———
# round1 stores secret X7 → round2 --resume <id> asks it. Records whether the
# memory truly carries over and WHICH session id round2's init emits — run()
# must return "the id to pass next time", so the baseline pins that fact.

probe_claude_resume() {
  local out1 out2 sid rc1 rc2 sid2 answer memory
  if ! have claude; then
    echo "skip  claude resume probe: claude not installed"
    return 0
  fi
  out1="$(mktemp "$BASE_DIR/.tmp-clr-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-clr-b.XXXXXX")"
  run_timed "$TIMEOUT_SECS" claude -p "$CLAUDE_SECRET" --output-format stream-json --verbose >"$out1" 2>/dev/null
  rc1=$?
  sid="$(claude_sid_of "$out1")"
  if [ -n "$sid" ]; then
    run_timed "$TIMEOUT_SECS" claude -p "$CLAUDE_ASK" --resume "$sid" --output-format stream-json --verbose >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  sid2="$(claude_sid_of "$out2")"
  answer="$(claude_text_of "$out2")"
  case "$answer" in
    *X7*) memory=yes ;;
    *) memory=no ;;
  esac
  {
    echo "# claude resume probe — captured ${NOW} (NOTE-only: multi-round facts, NOT compared in --check)"
    echo "# round1: \`claude -p <记住暗号X7> --output-format stream-json --verbose\` exit=${rc1}; session_id from system/init: $([ -n "$sid" ] && echo captured || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# round2: SKIPPED — round1 emitted no system/init session_id, nothing to resume"
    else
      echo "# round2: \`claude -p <暗号是什么> --resume <id> --output-format stream-json --verbose\` exit=${rc2}"
      echo "# memory: $( [ "$memory" = yes ] && echo "TRUE RESUME — final text contains X7" || echo "NO MEMORY — final text lacks X7") (reply: ${answer:-none})"
      if [ -z "$sid2" ]; then
        echo "# session-id contract: round2 emitted NO system/init — run() falls back to returning the input id"
      elif [ "$sid2" = "$sid" ]; then
        echo "# session-id contract: round2 system/init echoes the SAME id as round1 — returning the input id stays correct"
      else
        echo "# session-id contract: round2 system/init emits a NEW id (${sid2}) ≠ resumed id — run() must return round2's OWN init id, not the input id"
      fi
    fi
    echo "# ---- round1 output (raw, as captured) ----"
    cat "$out1"
    echo "# ---- round2 output (raw, as captured) ----"
    cat "$out2"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/claude-resume.ndjson" "${out1}.final"
  rm -f "$out1" "$out2"
  echo "saved $BASE_DIR/claude-resume.ndjson (round1 exit=${rc1}, round2 exit=${rc2}, memory=${memory:-n/a})"
}

# —— special probe: claude thinking blocks (NOTE-only, informational) ——————————
# Asks a small arithmetic question three ways and records whether assistant
# message.content[] ever contains a {type:'thinking'} block. Model output
# varies → never compared in --check.

probe_claude_thinking() {
  local outd outm rc_d rc_m think_d think_m
  if ! have claude; then
    echo "skip  claude thinking probe: claude not installed"
    return 0
  fi
  outd="$(mktemp "$BASE_DIR/.tmp-clt-a.XXXXXX")"  # (c) plain default
  outm="$(mktemp "$BASE_DIR/.tmp-clt-b.XXXXXX")"  # (a) --model thinking-branded
  run_timed "$TIMEOUT_SECS" claude -p "$THINK_PROMPT" --output-format stream-json --verbose >"$outd" 2>/dev/null
  rc_d=$?
  think_d="$(claude_thinking_of "$outd")"
  run_timed "$TIMEOUT_SECS" claude -p "$THINK_PROMPT" --model "$THINK_MODEL" --output-format stream-json --verbose >"$outm" 2>/dev/null
  rc_m=$?
  think_m="$(claude_thinking_of "$outm")"
  {
    echo "# claude thinking probe — captured ${NOW} (NOTE-only: model output varies, NOT compared in --check)"
    echo "# question: does assistant message.content[] ever contain a {type:'thinking'} block on this machine?"
    echo "# (a) --model ${THINK_MODEL} (the only thinking-branded id in ~/.claude/settings.json modelPicker): exit=${rc_m}, thinking=${think_m}"
    echo "# (b) CLI-level thinking flag: NONE — \`claude --help\` (2.1.318) exposes no thinking/extended-thinking flag (only --forward-subagent-text mentions thinking blocks); thinking is model/gateway behavior"
    echo "# (c) plain default (this machine routes auto/glm-5.3-flash[1m] via magpie gateway): exit=${rc_d}, thinking=${think_d}"
    if [ "$think_d" = no ] && [ "$think_m" = no ]; then
      echo "# verdict: no thinking blocks on this gateway/model — mapping stays conditional (map thinking IF present)"
    else
      echo "# verdict: thinking blocks DO appear — runner must map content[].type 'thinking' (payload .thinking||.text)"
    fi
    echo "# ---- variant (a) output (raw, as captured) ----"
    cat "$outm"
    echo "# ---- variant (c) output (raw, as captured) ----"
    cat "$outd"
  } > "${outd}.final"
  atomic_write "$BASE_DIR/claude-thinking.ndjson" "${outd}.final"
  rm -f "$outd" "$outm"
  echo "saved $BASE_DIR/claude-thinking.ndjson (default thinking=${think_d}, ${THINK_MODEL} thinking=${think_m})"
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
    probe_claude_resume
    probe_claude_thinking
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
