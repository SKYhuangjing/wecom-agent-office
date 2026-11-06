#!/usr/bin/env bash
# probe.sh — real-CLI 基线固化 / 漂移检测 (DESIGN §5.1)。
#
#   bash test/probe.sh            # baseline capture (default): minimal probes for
#                                 # dsh / claude / codex / pi → test/probe-baselines/<cli>.ndjson
#                                 # (raw NDJSON + header comments), plus special probes:
#                                 # dsh kill-then-resume, codex resume+stdin with
#                                 # resume-of-resume thread continuity (Y9 memory),
#                                 # claude resume (random-passcode carryover with a
#                                 # fresh-session control leg + session-id contract),
#                                 # claude thinking blocks (informational),
#                                 # claude history roundtrip (two-round real session
#                                 # in a tmp cwd parsed through the production
#                                 # history.js reader — M2-T3 committed artifact),
#                                 # codex history roundtrip (same shape for the
#                                 # rollout reader: two-round real thread parsed
#                                 # through provider-codex/history.js — M2-T5),
#                                 # pi resume+stdin with resume-of-resume session
#                                 # continuity + pi history roundtrip (same shape,
#                                 # through provider-pi/history.js — pi needs a
#                                 # models.json probe agent dir, see ensure_pi_agent_dir).
#   bash test/probe.sh --check    # re-run the four minimal probes and compare EVENT-TYPE
#                                 # SEQUENCES against the baselines; drift → diff + exit 1.
#
# Comparison semantics: the baseline stores the RAW type-per-line sequence; the
# check compares run-length-collapsed sequences on both sides — the COUNT of
# repeated events (claude thinking_tokens bursts, dsh text chunks) is model
# behavior, not protocol; the ORDER and presence of event types is the contract.
#
# NOTE-only baselines (claude-resume, claude-thinking, claude-history-
# roundtrip, codex-resume-stdin, codex-history-roundtrip, dsh-kill-resume,
# pi-resume-stdin, pi-history-roundtrip):
# multi-round / model-output probes whose header comments are the deliverable
# (observed facts for the runners). --check never compares them — only the
# four minimal <cli>.ndjson baselines are compared.
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
CLAUDE_ASK='暗号是什么？只回复暗号本身'
THINK_PROMPT='先想一下再回答：3的平方加1等于多少？只回复数字'
THINK_MODEL='antigravity/claude-opus-4-6-thinking' # only thinking-branded id in ~/.claude/settings.json modelPicker
CODEX_SECRET='记住暗号Y9，之后我会问你。现在只回复：好的'
CODEX_ASK='暗号是什么？只回复暗号本身'
CODEX_ASK2='暗号还是什么？只回复暗号本身'
# pi probes run through the local magpie gateway (same route the production
# bot uses): models.json is written into a temp agent dir per invocation, the
# key rides in WAO_PROBE_MAGPIE_KEY. The gateway does not enforce caller auth
# on localhost (verified 2026-11-07), so the default literal is a placeholder
# that matches how this machine's own claude CLI is wired — on a stricter
# gateway export WAO_PROBE_MAGPIE_KEY with a real caller key.
PI_MODEL='auto/glm-5.3-flash'
PI_PROBE_KEY="${WAO_PROBE_MAGPIE_KEY:-magpie}"
PI_SECRET='记住暗号P8，之后我会问你。现在只回复：好的'
PI_ASK='暗号是什么？只回复暗号本身'
PI_ASK2='暗号还是什么？只回复暗号本身'

# ensure_pi_agent_dir <dir> — write the probe agent dir's models.json (magpie
# gateway, $ENV apiKey reference — the literal never lands in the file).
ensure_pi_agent_dir() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/models.json" <<EOF
{
  "waoManaged": true,
  "waoBotId": "probe",
  "providers": {
    "magpie": {
      "baseUrl": "http://127.0.0.1:3425",
      "api": "anthropic-messages",
      "apiKey": "\$WAO_PROBE_MAGPIE_KEY",
      "models": [
        {
          "id": "${PI_MODEL}",
          "name": "${PI_MODEL} (magpie probe)",
          "contextWindow": 272000,
          "maxTokens": 131072
        }
      ]
    }
  }
}
EOF
}

# pi_probe_env <dir> — prints the env prefix for a pi probe leg.
pi_probe_env() {
  printf 'env PI_CODING_AGENT_DIR=%s WAO_PROBE_MAGPIE_KEY=%s' "$1" "$PI_PROBE_KEY"
}

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

# pi_sid_of <file> — session id from the first session event ('' if none).
pi_sid_of() {
  node -e '
    const fs = require("node:fs");
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "session" && o.id) { process.stdout.write(o.id); process.exit(0); }
      } catch {}
    }
  ' "$1"
}

# pi_text_of <file> — LAST assistant text block (the final answer), 120 chars
# ('' if none). Thinking blocks are skipped; the last text block wins (the
# same rule the runner uses).
pi_text_of() {
  node -e '
    const fs = require("node:fs");
    let text = "";
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "message_end" && o.message?.role === "assistant" && Array.isArray(o.message.content)) {
          for (const c of o.message.content) if (c.type === "text" && c.text) text = c.text;
        }
      } catch {}
    }
    process.stdout.write(text.slice(0, 120));
  ' "$1"
}

# pi_stop_of <file> — the last assistant message_end stopReason ('' if none).
# The exit-0-is-not-success fact rides on this: a failed run says "error".
pi_stop_of() {
  node -e '
    const fs = require("node:fs");
    let stop = "";
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "message_end" && o.message?.role === "assistant" && typeof o.message.stopReason === "string") stop = o.message.stopReason;
      } catch {}
    }
    process.stdout.write(stop);
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

# pi runs through the magpie gateway: --no-session keeps the minimal probe
# ephemeral (no sessions/ writes), the prompt rides on stdin (probe-proven).
capture_pi() { # capture_pi <out-tmp>; prints exit code
  local agent_dir
  agent_dir="$(mktemp -d "${TMPDIR:-/tmp}/wao-pi-probe-agent-XXXXXX")"
  ensure_pi_agent_dir "$agent_dir"
  printf '%s' "$PROMPT" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-session --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" >"$1" 2>/dev/null
  local rc=$?
  rm -rf "$agent_dir"
  echo $rc
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
      echo "# leg2: \`codex exec resume ${tid1} --json --skip-git-repo-check -\` (stdin asks the secret) exit=${rc2}"
      echo "# leg2 thread.started: $([ -n "$tid2" ] && ([ "$tid2" = "$tid1" ] && echo "emitted, SAME id as leg1" || echo "emitted, NEW id ${tid2}") || echo "NOT emitted on resume")"
      echo "# leg2 memory: $( [ "$mem2" = yes ] && echo "RECALLED — reply contains Y9" || echo "NO MEMORY — reply lacks Y9") (reply: ${reply2:-none})"
    fi
    if [ "$rc3" = skipped ]; then
      echo "# leg3: SKIPPED — no leg2 thread to resume"
    else
      echo "# leg3: \`codex exec resume ${resume2} --json --skip-git-repo-check -\` (resume-of-resume) exit=${rc3}"
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

# —— special probe: claude resume — carryover + session-id contract (NOTE-only) —
# round1 stores a RANDOM passcode in-conversation (told NOT to write it to any
# file or memory) → round2 --resume <id> asks it → CONTROL: a fresh session
# (no --resume) asks the same question. If the control ALSO answers, the recall
# came from claude auto-memory (same-cwd sessions share the project memory
# dir), not from resume context — the header then records carryover as
# UNPROVEN. The passcode is random per run so earlier runs' memory entries
# cannot answer this run's question.

probe_claude_resume() {
  local out1 out2 outc pass rc1 rc2 rcc sid sid2 sidc ans_r ans_c mem_r=no mem_c=no think_r
  if ! have claude; then
    echo "skip  claude resume probe: claude not installed"
    return 0
  fi
  pass="X7-${RANDOM}${RANDOM}"
  out1="$(mktemp "$BASE_DIR/.tmp-clr-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-clr-b.XXXXXX")"
  outc="$(mktemp "$BASE_DIR/.tmp-clr-c.XXXXXX")"
  run_timed "$TIMEOUT_SECS" claude -p "记住暗号${pass}，只把它记在心里，不要写入任何文件或记忆。现在只回复：好的" --output-format stream-json --verbose >"$out1" 2>/dev/null
  rc1=$?
  sid="$(claude_sid_of "$out1")"
  if [ -n "$sid" ]; then
    run_timed "$TIMEOUT_SECS" claude -p "$CLAUDE_ASK" --resume "$sid" --output-format stream-json --verbose >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  run_timed "$TIMEOUT_SECS" claude -p "$CLAUDE_ASK" --output-format stream-json --verbose >"$outc" 2>/dev/null
  rcc=$?
  sid2="$(claude_sid_of "$out2")"
  sidc="$(claude_sid_of "$outc")"
  ans_r="$(claude_text_of "$out2")"
  ans_c="$(claude_text_of "$outc")"
  think_r="$(claude_thinking_of "$out2")"
  # verdicts precomputed before the output block: bash 3.2 (macOS) cannot parse $(case ...) inline
  case "$ans_r" in *"$pass"*) mem_r=yes ;; esac
  case "$ans_c" in *"$pass"*) mem_c=yes ;; esac
  {
    echo "# claude resume probe — captured ${NOW} (NOTE-only: multi-round facts, NOT compared in --check)"
    echo "# passcode ${pass} is RANDOM per run; round1 was told to keep it in-conversation only (no file/memory writes)"
    echo "# round1: \`claude -p <记住随机暗号> --output-format stream-json --verbose\` exit=${rc1}; session_id from system/init: $([ -n "$sid" ] && echo captured || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# round2: SKIPPED — round1 emitted no system/init session_id, nothing to resume"
    else
      echo "# round2: \`claude -p <${CLAUDE_ASK}> --resume <id> --output-format stream-json --verbose\` exit=${rc2}; answered passcode: ${mem_r} (reply: ${ans_r:-none}); thinking blocks: ${think_r}"
      echo "# PROVEN: --resume is accepted (exit=${rc2}) and the resume turn emits assistant events like a first turn (incl. thinking blocks)"
    fi
    echo "# control: FRESH session, no --resume, same question — exit=${rcc}; answered passcode: ${mem_c} (reply: ${ans_c:-none}); control session id: ${sidc:-none}"
    if [ "$rc2" = skipped ]; then
      echo "# carryover: NOT TESTED — round1 gave no session id to resume"
    elif [ "$mem_r" = no ]; then
      echo "# carryover: NOT SHOWN — the resume round did not answer the passcode"
    elif [ "$mem_c" = no ]; then
      echo "# carryover: CONFIRMED — the resume round recalled the passcode while a fresh control session could not (recall must come from --resume context)"
    else
      echo "# carryover: UNPROVEN — the CONTROL also answered from claude auto-memory, so round2's recall cannot be attributed to --resume context"
    fi
    echo "# auto-memory risk (observed in an earlier fixed-passcode capture): same-cwd claude sessions share project auto-memory (~/.claude/projects/<cwd>/memory) — a secret told to one session can surface in OTHER same-cwd sessions; multi-bot same-cwd deployments must treat memory as shared state (M3 runbook material)"
    if [ -z "$sid2" ]; then
      echo "# session-id contract: round2 emitted NO system/init — run() falls back to returning the input id"
    elif [ "$sid2" = "$sid" ]; then
      echo "# session-id contract: round2 system/init echoes the SAME id as round1 — returning the input id stays correct"
    else
      echo "# session-id contract: round2 system/init emits a NEW id (${sid2}) ≠ resumed id — run() must return round2's OWN init id, not the input id"
    fi
    echo "# ---- round1 output (raw, as captured) ----"
    cat "$out1"
    echo "# ---- round2 output (raw, as captured) ----"
    cat "$out2"
    echo "# ---- control output (raw, first 6 JSON lines) ----"
    head -6 "$outc"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/claude-resume.ndjson" "${out1}.final"
  rm -f "$out1" "$out2" "$outc"
  echo "saved $BASE_DIR/claude-resume.ndjson (round1 exit=${rc1}, round2 exit=${rc2}, resume-answered=${mem_r}, control-answered=${mem_c})"
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

# —— special probe: claude history roundtrip (NOTE-only, M2-T3 artifact) ————————
# Runs a REAL two-round claude conversation in a FRESH tmp cwd — round1 stores a
# RANDOM passcode (told to write it to no file or memory), round2 --resume asks
# it back — then parses THAT brand-new session file through the PRODUCTION
# reader plugins/provider-claude/history.js (readHistory({cwd:<tmp>}, sid),
# default claudeConfigDir resolution, exactly like a bot turn would). Deliverable
# = the header verdict: session id, turn count, both passcode texts present in
# the parsed turns, warnings count. Recall-attribution (resume vs auto-memory)
# is claude-resume.ndjson's job; here the passcode texts only need to appear in
# the session FILE's turns, whichever route produced them (random per run, so
# earlier runs' memory cannot answer this run).

probe_claude_history_roundtrip() {
  local out1 out2 workdir pass sid sid2 rc1 rc2 verdict pass_ok
  local hist_turns hist_trunc hist_warn hist_rem hist_rec hist_ask
  if ! have claude; then
    echo "skip  claude history-roundtrip probe: claude not installed"
    return 0
  fi
  pass="Z3-${RANDOM}${RANDOM}"
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/wao-clhr-XXXXXX")"
  out1="$(mktemp "$BASE_DIR/.tmp-chr-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-chr-b.XXXXXX")"
  ( cd "$workdir" && run_timed "$TIMEOUT_SECS" claude -p "记住暗号${pass}，只记在心里不要写入任何文件或记忆" --output-format stream-json --verbose ) >"$out1" 2>/dev/null
  rc1=$?
  sid="$(claude_sid_of "$out1")"
  if [ -n "$sid" ]; then
    ( cd "$workdir" && run_timed "$TIMEOUT_SECS" claude -p "暗号是什么？只回复暗号" --resume "$sid" --output-format stream-json --verbose ) >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  sid2="$(claude_sid_of "$out2")"

  # Direct node harness: readHistory via the production reader. Emits strict
  # `KEY value` single lines (turn texts whitespace-collapsed + capped, so
  # model output can never break the bash assembly below).
  if [ -n "$sid" ]; then
    verdict="$(node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { readHistory } = await import(pathToFileURL(process.argv[4]).href);
      const r = readHistory({ cwd: process.argv[2] }, process.argv[3]);
      const pass = process.argv[5];
      const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const has = (fn) => (r.turns.some(fn) ? "yes" : "no");
      const out = [
        `TURNS ${r.turns.length}`,
        `TRUNCATED ${r.truncated}`,
        `WARNINGS ${r.warnings.length}`,
        `REMEMBER ${has((t) => (t.user ?? "").includes(pass))}`,
        `RECALLED ${has((t) => (t.assistant ?? "").includes(pass))}`,
        `ASK ${has((t) => (t.user ?? "").includes("暗号是什么"))}`,
        ...r.warnings.map((w) => `WARNING ${clean(w)}`),
        ...r.turns.map((t, i) => `TURN ${i + 1} [${clean(t.user)}] => [${clean(t.assistant)}]`),
      ];
      process.stdout.write(out.join("\n") + "\n");
    ' hr "$workdir" "$sid" "$SCRIPT_DIR/../plugins/provider-claude/history.js" "$pass")"
    hist_turns="$(sed -n 's/^TURNS //p' <<<"$verdict")"
    hist_trunc="$(sed -n 's/^TRUNCATED //p' <<<"$verdict")"
    hist_warn="$(sed -n 's/^WARNINGS //p' <<<"$verdict")"
    hist_rem="$(sed -n 's/^REMEMBER //p' <<<"$verdict")"
    hist_rec="$(sed -n 's/^RECALLED //p' <<<"$verdict")"
    hist_ask="$(sed -n 's/^ASK //p' <<<"$verdict")"
  fi
  # verdict precomputed: bash 3.2 (macOS) cannot parse $(case…) inline below
  pass_ok=no
  if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ -n "$sid" ] && [ "$sid2" = "$sid" ] \
     && [ "${hist_turns:-0}" -ge 2 ] && [ "$hist_rem" = yes ] && [ "$hist_rec" = yes ] \
     && [ "${hist_warn:-1}" -eq 0 ]; then
    pass_ok=yes
  fi
  {
    echo "# claude history roundtrip probe — captured ${NOW} (NOTE-only: real-data artifact, NOT compared in --check)"
    echo "# purpose: prove plugins/provider-claude/history.js end-to-end against a brand-new REAL session file"
    echo "# method: fresh tmp cwd; round1 tells claude a RANDOM passcode ${pass} (no file/memory writes), round2 --resume asks it back,"
    echo "#         then readHistory({cwd:<tmp>}, sid) parses THAT session via the production reader (default claudeConfigDir)"
    echo "# round1: \`claude -p <记住暗号${pass}，只记在心里不要写入任何文件或记忆> --output-format stream-json --verbose\` (tmp cwd) exit=${rc1}; session id from system/init: $([ -n "$sid" ] && echo "$sid" || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# round2: SKIPPED — round1 emitted no session id, nothing to resume"
    else
      echo "# round2: \`claude -p <暗号是什么？只回复暗号> --resume <id> --output-format stream-json --verbose\` exit=${rc2}; system/init: $([ -n "$sid2" ] && ([ "$sid2" = "$sid" ] && echo "echoes the SAME id (session-id contract)" || echo "NEW id ${sid2}") || echo "NOT emitted — run() falls back to the input id")"
    fi
    echo "# readHistory result (turn texts whitespace-collapsed, 80 chars each):"
    echo "#   session id: ${sid:-none} | turn count: ${hist_turns:-n/a} | warnings: ${hist_warn:-n/a} | truncated: ${hist_trunc:-n/a}"
    echo "#   passcode texts in turns: remember-prompt=${hist_rem:-n/a} recalled-passcode=${hist_rec:-n/a} ask-present=${hist_ask:-n/a}"
    sed -n 's/^WARNING /#   WARNING: /p' <<<"$verdict"
    sed -n 's/^TURN /#   TURN: /p' <<<"$verdict"
    if [ "$pass_ok" = yes ]; then
      echo "# verdict: PASS — real 2-round session parsed clean: both passcode texts present in turns, 0 warnings"
    else
      echo "# verdict: FAIL — rc1=${rc1} rc2=${rc2} sid-echo=$([ "$sid2" = "$sid" ] && echo same || echo differs) turns=${hist_turns:-n/a} remember=${hist_rem:-n/a} recalled=${hist_rec:-n/a} warnings=${hist_warn:-n/a}"
    fi
    echo "# ---- round1 output (raw, as captured) ----"
    cat "$out1"
    echo "# ---- round2 output (raw, as captured) ----"
    cat "$out2"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/claude-history-roundtrip.ndjson" "${out1}.final"
  rm -f "$out1" "$out2"
  rm -rf "$workdir"
  echo "saved $BASE_DIR/claude-history-roundtrip.ndjson (roundtrip=${pass_ok}, turns=${hist_turns:-n/a}, warnings=${hist_warn:-n/a})"
}

# —— special probe: codex history roundtrip (NOTE-only, M2-T5 artifact) ————————
# Same shape as the claude T3 roundtrip, for the codex rollout reader: runs a
# REAL two-round codex thread — round1 `exec` stores a RANDOM passcode (told to
# write it to no file or memory), round2 `exec resume <tid>` asks it back (both
# prompts via stdin '-') — then parses THAT brand-new rollout file through the
# PRODUCTION reader plugins/provider-codex/history.js (readHistory({cwd:<tmp>},
# tid), default codexHome resolution exactly like a bot turn: the rollout lives
# under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*<tid>.jsonl regardless of cwd).
# Deliverable = the header verdict: thread id, same-id echo on resume, turn
# count, both passcode texts present in the parsed turns, warnings count.
# Recall-attribution is codex-resume-stdin.ndjson's domain (its Y9 legs); here
# the passcode texts only need to appear in the rollout FILE's turns, whichever
# route produced them (random per run — no earlier thread can answer this run).

probe_codex_history_roundtrip() {
  local out1 out2 workdir pass tid tid2 rc1 rc2 verdict pass_ok
  local hist_turns hist_trunc hist_warn hist_rem hist_rec hist_ask
  if ! have codex; then
    echo "skip  codex history-roundtrip probe: codex not installed"
    return 0
  fi
  pass="C5-${RANDOM}${RANDOM}"
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/wao-cohr-XXXXXX")"
  out1="$(mktemp "$BASE_DIR/.tmp-chr2-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-chr2-b.XXXXXX")"
  ( cd "$workdir" && printf '%s' "记住暗号${pass}，只记在心里不要写入任何文件或记忆" | run_timed "$TIMEOUT_SECS" codex exec --json --skip-git-repo-check - ) >"$out1" 2>/dev/null
  rc1=$?
  tid="$(codex_tid_of "$out1")"
  if [ -n "$tid" ]; then
    ( cd "$workdir" && printf '%s' "暗号是什么？只回复暗号" | run_timed "$TIMEOUT_SECS" codex exec resume "$tid" --json --skip-git-repo-check - ) >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  tid2="$(codex_tid_of "$out2")"

  # Direct node harness: readHistory via the production reader. Emits strict
  # `KEY value` single lines (turn texts whitespace-collapsed + capped, so
  # model output can never break the bash assembly below).
  if [ -n "$tid" ]; then
    verdict="$(node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { readHistory } = await import(pathToFileURL(process.argv[4]).href);
      const r = readHistory({ cwd: process.argv[2] }, process.argv[3]);
      const pass = process.argv[5];
      const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const has = (fn) => (r.turns.some(fn) ? "yes" : "no");
      const out = [
        `TURNS ${r.turns.length}`,
        `TRUNCATED ${r.truncated}`,
        `WARNINGS ${r.warnings.length}`,
        `REMEMBER ${has((t) => (t.user ?? "").includes(pass))}`,
        `RECALLED ${has((t) => (t.assistant ?? "").includes(pass))}`,
        `ASK ${has((t) => (t.user ?? "").includes("暗号是什么"))}`,
        ...r.warnings.map((w) => `WARNING ${clean(w)}`),
        ...r.turns.map((t, i) => `TURN ${i + 1} [${clean(t.user)}] => [${clean(t.assistant)}]`),
      ];
      process.stdout.write(out.join("\n") + "\n");
    ' hr "$workdir" "$tid" "$SCRIPT_DIR/../plugins/provider-codex/history.js" "$pass")"
    hist_turns="$(sed -n 's/^TURNS //p' <<<"$verdict")"
    hist_trunc="$(sed -n 's/^TRUNCATED //p' <<<"$verdict")"
    hist_warn="$(sed -n 's/^WARNINGS //p' <<<"$verdict")"
    hist_rem="$(sed -n 's/^REMEMBER //p' <<<"$verdict")"
    hist_rec="$(sed -n 's/^RECALLED //p' <<<"$verdict")"
    hist_ask="$(sed -n 's/^ASK //p' <<<"$verdict")"
  fi
  # verdict precomputed: bash 3.2 (macOS) cannot parse $(case…) inline below
  pass_ok=no
  if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ -n "$tid" ] && [ "$tid2" = "$tid" ] \
     && [ "${hist_turns:-0}" -ge 2 ] && [ "$hist_rem" = yes ] && [ "$hist_rec" = yes ] \
     && [ "${hist_warn:-1}" -eq 0 ]; then
    pass_ok=yes
  fi
  {
    echo "# codex history roundtrip probe — captured ${NOW} (NOTE-only: real-data artifact, NOT compared in --check)"
    echo "# purpose: prove plugins/provider-codex/history.js end-to-end against a brand-new REAL rollout file"
    echo "# method: fresh tmp cwd; round1 tells codex a RANDOM passcode ${pass} (no file/memory writes), round2 \`exec resume <tid>\` asks it back"
    echo "#         (both prompts via stdin '-'), then readHistory({cwd:<tmp>}, tid) parses THAT rollout via the production reader"
    echo "#         (default codexHome resolution — rollouts live under \$CODEX_HOME/sessions/YYYY/MM/DD/, cwd-independent)"
    echo "# round1: \`printf <记住暗号${pass}，只记在心里不要写入任何文件或记忆> | codex exec --json --skip-git-repo-check -\` (tmp cwd) exit=${rc1}; thread id from thread.started: $([ -n "$tid" ] && echo "$tid" || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# round2: SKIPPED — round1 emitted no thread.started, nothing to resume"
    else
      echo "# round2: \`printf <暗号是什么？只回复暗号> | codex exec resume <tid> --json --skip-git-repo-check -\` exit=${rc2}; thread.started: $([ -n "$tid2" ] && ([ "$tid2" = "$tid" ] && echo "echoes the SAME thread id (session-id contract, baseline leg2/leg3)" || echo "NEW id ${tid2}") || echo "NOT emitted — run() falls back to the input id")"
    fi
    echo "# readHistory result (turn texts whitespace-collapsed, 80 chars each):"
    echo "#   thread id: ${tid:-none} | turn count: ${hist_turns:-n/a} | warnings: ${hist_warn:-n/a} | truncated: ${hist_trunc:-n/a}"
    echo "#   passcode texts in turns: remember-prompt=${hist_rem:-n/a} recalled-passcode=${hist_rec:-n/a} ask-present=${hist_ask:-n/a}"
    sed -n 's/^WARNING /#   WARNING: /p' <<<"$verdict"
    sed -n 's/^TURN /#   TURN: /p' <<<"$verdict"
    if [ "$pass_ok" = yes ]; then
      echo "# verdict: PASS — real 2-round thread parsed clean: both passcode texts present in turns, 0 warnings, same-id echo"
    else
      echo "# verdict: FAIL — rc1=${rc1} rc2=${rc2} tid-echo=$([ "$tid2" = "$tid" ] && echo same || echo differs) turns=${hist_turns:-n/a} remember=${hist_rem:-n/a} recalled=${hist_rec:-n/a} warnings=${hist_warn:-n/a}"
    fi
    echo "# ---- round1 output (raw, as captured) ----"
    cat "$out1"
    echo "# ---- round2 output (raw, as captured) ----"
    cat "$out2"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/codex-history-roundtrip.ndjson" "${out1}.final"
  rm -f "$out1" "$out2"
  rm -rf "$workdir"
  echo "saved $BASE_DIR/codex-history-roundtrip.ndjson (roundtrip=${pass_ok}, turns=${hist_turns:-n/a}, warnings=${hist_warn:-n/a})"
}

# —— special probe: pi resume + stdin + session continuity (NOTE-only) ————————
# leg1 stores secret P8 → leg2 `--session <id>` asks it back → leg3 resumes
# leg2 (resume-of-resume) and asks again. All prompts go via stdin; the
# session id is echoed by the `session` event on every leg (baseline-proven).

probe_pi_resume_stdin() {
  local agent_dir out1 out2 out3 sid1 sid2 sid3 rc1 rc2 rc3 reply2 reply3 mem2=no mem3=no stop2 stop3
  if ! have pi; then
    echo "skip  pi resume-stdin probe: pi not installed"
    return 0
  fi
  agent_dir="$(mktemp -d "${TMPDIR:-/tmp}/wao-pi-crs-agent-XXXXXX")"
  ensure_pi_agent_dir "$agent_dir"
  out1="$(mktemp "$BASE_DIR/.tmp-prs-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-prs-b.XXXXXX")"
  out3="$(mktemp "$BASE_DIR/.tmp-prs-c.XXXXXX")"
  printf '%s' "$PI_SECRET" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" >"$out1" 2>/dev/null
  rc1=$?
  sid1="$(pi_sid_of "$out1")"
  if [ -n "$sid1" ]; then
    printf '%s' "$PI_ASK" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" --session "$sid1" >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  sid2="$(pi_sid_of "$out2")"
  if [ "$rc2" != skipped ]; then
    printf '%s' "$PI_ASK2" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" --session "${sid2:-$sid1}" >"$out3" 2>/dev/null
    rc3=$?
  else
    rc3=skipped
  fi
  sid3="$(pi_sid_of "$out3")"
  reply2="$(pi_text_of "$out2")"
  reply3="$(pi_text_of "$out3")"
  stop2="$(pi_stop_of "$out2")"
  stop3="$(pi_stop_of "$out3")"
  # memory verdicts precomputed before the output block: bash 3.2 (macOS)
  # cannot parse $(case ...) inline in the echo lines below.
  case "$reply2" in *P8*) mem2=yes ;; esac
  case "$reply3" in *P8*) mem3=yes ;; esac
  {
    echo "# pi resume+stdin+session-continuity probe — captured ${NOW} (NOTE-only: multi-round facts, NOT compared in --check)"
    echo "# gateway: magpie (${PI_MODEL} via anthropic-messages); models.json probe agent dir with \$ENV apiKey reference; key=${PI_PROBE_KEY:0:3}…"
    echo "# leg1: \`pi -p --mode json … --provider magpie --model ${PI_MODEL}\` (stdin stores P8) exit=${rc1}; session id from session event: $([ -n "$sid1" ] && echo captured || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# leg2: SKIPPED — leg1 emitted no session event, nothing to resume"
    else
      echo "# leg2: \`pi -p --mode json … --session ${sid1}\` (stdin asks the secret) exit=${rc2}; final stopReason=${stop2:-none}"
      echo "# leg2 session event: $([ -n "$sid2" ] && ([ "$sid2" = "$sid1" ] && echo "emitted, SAME id as leg1" || echo "emitted, NEW id ${sid2}") || echo "NOT emitted on resume")"
      echo "# leg2 memory: $( [ "$mem2" = yes ] && echo "RECALLED — reply contains P8" || echo "NO MEMORY — reply lacks P8") (reply: ${reply2:-none})"
    fi
    if [ "$rc3" = skipped ]; then
      echo "# leg3: SKIPPED — no leg2 session to resume"
    else
      echo "# leg3: \`pi -p --mode json … --session ${sid2:-$sid1}\` (resume-of-resume) exit=${rc3}; final stopReason=${stop3:-none}"
      echo "# leg3 session event: $([ -n "$sid3" ] && ([ "$sid3" = "$sid1" ] && echo "emitted, SAME id as leg1" || echo "emitted, NEW id ${sid3}") || echo "NOT emitted on resume")"
      echo "# leg3 memory: $( [ "$mem3" = yes ] && echo "RECALLED — reply contains P8" || echo "NO MEMORY — reply lacks P8") (reply: ${reply3:-none})"
    fi
    echo "# stdin: every leg passes its prompt via stdin (no positional arg) — runner may always feed stdin, resume included"
    echo "# ---- leg1 output (raw) ----"
    cat "$out1"
    echo "# ---- leg2 output (raw, first 6 JSON lines) ----"
    head -6 "$out2"
    echo "# ---- leg3 output (raw, first 6 JSON lines) ----"
    head -6 "$out3"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/pi-resume-stdin.ndjson" "${out1}.final"
  rm -f "$out1" "$out2" "$out3"
  rm -rf "$agent_dir"
  echo "saved $BASE_DIR/pi-resume-stdin.ndjson (leg1 exit=${rc1}, leg2 exit=${rc2}, leg3 exit=${rc3})"
}

# —— special probe: pi history roundtrip (NOTE-only artifact) ———————————————
# Same shape as the claude/codex roundtrips, for the pi session reader: runs a
# REAL two-round pi conversation in a FRESH tmp cwd — round1 stores a RANDOM
# passcode (told to write it to no file or memory), round2 --session <id> asks
# it back — then parses THAT brand-new session file through the PRODUCTION
# reader plugins/provider-pi/history.js (readHistory({cwd:<tmp>, piAgentDir},
# sid) — piAgentDir explicit because the probe agent dir is a temp dir; the
# default ~/.pi/agent-wao-<botId> resolution shares the same lookup code and
# is unit-covered).
# Deliverable = the header verdict: session id, same-id echo on resume, turn
# count, both passcode texts present in the parsed turns, warnings count.

probe_pi_history_roundtrip() {
  local agent_dir out1 out2 workdir pass sid sid2 rc1 rc2 verdict pass_ok
  local hist_turns hist_trunc hist_warn hist_rem hist_rec hist_ask
  if ! have pi; then
    echo "skip  pi history-roundtrip probe: pi not installed"
    return 0
  fi
  pass="Q9-${RANDOM}${RANDOM}"
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/wao-pihr-XXXXXX")"
  agent_dir="$(mktemp -d "${TMPDIR:-/tmp}/wao-pihr-agent-XXXXXX")"
  ensure_pi_agent_dir "$agent_dir"
  out1="$(mktemp "$BASE_DIR/.tmp-phr-a.XXXXXX")"
  out2="$(mktemp "$BASE_DIR/.tmp-phr-b.XXXXXX")"
  ( cd "$workdir" && printf '%s' "记住暗号${pass}，只记在心里不要写入任何文件或记忆" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" ) >"$out1" 2>/dev/null
  rc1=$?
  sid="$(pi_sid_of "$out1")"
  if [ -n "$sid" ]; then
    ( cd "$workdir" && printf '%s' "暗号是什么？只回复暗号" | run_timed "$TIMEOUT_SECS" env PI_CODING_AGENT_DIR="$agent_dir" WAO_PROBE_MAGPIE_KEY="$PI_PROBE_KEY" pi -p --mode json --no-context-files --no-extensions --provider magpie --model "$PI_MODEL" --session "$sid" ) >"$out2" 2>/dev/null
    rc2=$?
  else
    rc2=skipped
  fi
  sid2="$(pi_sid_of "$out2")"

  # Direct node harness: readHistory via the production reader. Emits strict
  # `KEY value` single lines (turn texts whitespace-collapsed + capped, so
  # model output can never break the bash assembly below).
  if [ -n "$sid" ]; then
    verdict="$(node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { readHistory } = await import(pathToFileURL(process.argv[4]).href);
      const r = readHistory({ cwd: process.argv[2], piAgentDir: process.argv[6] }, process.argv[3]);
      const pass = process.argv[5];
      const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const has = (fn) => (r.turns.some(fn) ? "yes" : "no");
      const out = [
        `TURNS ${r.turns.length}`,
        `TRUNCATED ${r.truncated}`,
        `WARNINGS ${r.warnings.length}`,
        `REMEMBER ${has((t) => (t.user ?? "").includes(pass))}`,
        `RECALLED ${has((t) => (t.assistant ?? "").includes(pass))}`,
        `ASK ${has((t) => (t.user ?? "").includes("暗号是什么"))}`,
        ...r.warnings.map((w) => `WARNING ${clean(w)}`),
        ...r.turns.map((t, i) => `TURN ${i + 1} [${clean(t.user)}] => [${clean(t.assistant)}]`),
      ];
      process.stdout.write(out.join("\n") + "\n");
    ' hr "$workdir" "$sid" "$SCRIPT_DIR/../plugins/provider-pi/history.js" "$pass" "$agent_dir")"
    hist_turns="$(sed -n 's/^TURNS //p' <<<"$verdict")"
    hist_trunc="$(sed -n 's/^TRUNCATED //p' <<<"$verdict")"
    hist_warn="$(sed -n 's/^WARNINGS //p' <<<"$verdict")"
    hist_rem="$(sed -n 's/^REMEMBER //p' <<<"$verdict")"
    hist_rec="$(sed -n 's/^RECALLED //p' <<<"$verdict")"
    hist_ask="$(sed -n 's/^ASK //p' <<<"$verdict")"
  fi
  # verdict precomputed: bash 3.2 (macOS) cannot parse $(case…) inline below
  pass_ok=no
  if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ -n "$sid" ] && [ "$sid2" = "$sid" ] \
     && [ "${hist_turns:-0}" -ge 2 ] && [ "$hist_rem" = yes ] && [ "$hist_rec" = yes ] \
     && [ "${hist_warn:-1}" -eq 0 ]; then
    pass_ok=yes
  fi
  {
    echo "# pi history roundtrip probe — captured ${NOW} (NOTE-only: real-data artifact, NOT compared in --check)"
    echo "# purpose: prove plugins/provider-pi/history.js end-to-end against a brand-new REAL session file"
    echo "# method: fresh tmp cwd; round1 tells pi a RANDOM passcode ${pass} (no file/memory writes), round2 \`--session <id>\` asks it back"
    echo "#         (both prompts via stdin), then readHistory({cwd:<tmp>, piAgentDir}, sid) parses THAT session via the production reader"
    echo "#         (piAgentDir explicit — the probe agent dir is a temp dir; sessions live under <piAgentDir>/sessions/<cwdSlug>/)"
    echo "# round1: \`pi -p --mode json … --provider magpie --model ${PI_MODEL}\` (tmp cwd, stdin stores passcode) exit=${rc1}; session id from session event: $([ -n "$sid" ] && echo "$sid" || echo MISSING)"
    if [ "$rc2" = skipped ]; then
      echo "# round2: SKIPPED — round1 emitted no session id, nothing to resume"
    else
      echo "# round2: \`pi -p --mode json … --session <id>\` (stdin asks the passcode) exit=${rc2}; session event: $([ -n "$sid2" ] && ([ "$sid2" = "$sid" ] && echo "echoes the SAME id (session-id contract)" || echo "NEW id ${sid2}") || echo "NOT emitted — run() falls back to the input id")"
    fi
    echo "# readHistory result (turn texts whitespace-collapsed, 80 chars each):"
    echo "#   session id: ${sid:-none} | turn count: ${hist_turns:-n/a} | warnings: ${hist_warn:-n/a} | truncated: ${hist_trunc:-n/a}"
    echo "#   passcode texts in turns: remember-prompt=${hist_rem:-n/a} recalled-passcode=${hist_rec:-n/a} ask-present=${hist_ask:-n/a}"
    sed -n 's/^WARNING /#   WARNING: /p' <<<"$verdict"
    sed -n 's/^TURN /#   TURN: /p' <<<"$verdict"
    if [ "$pass_ok" = yes ]; then
      echo "# verdict: PASS — real 2-round session parsed clean: both passcode texts present in turns, 0 warnings, same-id echo"
    else
      echo "# verdict: FAIL — rc1=${rc1} rc2=${rc2} sid-echo=$([ "$sid2" = "$sid" ] && echo same || echo differs) turns=${hist_turns:-n/a} remember=${hist_rem:-n/a} recalled=${hist_rec:-n/a} warnings=${hist_warn:-n/a}"
    fi
    echo "# ---- round1 output (raw, as captured) ----"
    cat "$out1"
    echo "# ---- round2 output (raw, as captured) ----"
    cat "$out2"
  } > "${out1}.final"
  atomic_write "$BASE_DIR/pi-history-roundtrip.ndjson" "${out1}.final"
  rm -f "$out1" "$out2"
  rm -rf "$workdir" "$agent_dir"
  echo "saved $BASE_DIR/pi-history-roundtrip.ndjson (roundtrip=${pass_ok}, turns=${hist_turns:-n/a}, warnings=${hist_warn:-n/a})"
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
    save_minimal pi capture_pi
    probe_dsh_kill_resume
    probe_codex_resume_stdin
    probe_claude_resume
    probe_claude_thinking
    probe_claude_history_roundtrip
    probe_codex_history_roundtrip
    probe_pi_resume_stdin
    probe_pi_history_roundtrip
    echo "probe: baselines captured (git add $BASE_DIR/*.ndjson)"
    ;;
  --check)
    echo "probe: checking event-type sequences against $BASE_DIR"
    fail=0
    check_minimal dsh capture_dsh || fail=1
    check_minimal claude capture_claude || fail=1
    check_minimal codex capture_codex || fail=1
    check_minimal pi capture_pi || fail=1
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
