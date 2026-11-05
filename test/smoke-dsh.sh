#!/bin/bash
# Real dsh smoke (Task 18) — drives plugins/provider-dsh/runner.js against the
# LOCAL dsh CLI (no WeCom, no server). Not part of `npm test`: it needs a real
# dsh install (and its credentials), so it runs on demand (T20 boot checklist).
# Two rounds: round 1 mints a session and tells it a code word; round 2
# resumes with --session-id and must remember it — then readHistory must
# decode the REAL ~/.dsh session file with both turns.
#   usage: bash test/smoke-dsh.sh
# Skips cleanly (exit 0) when dsh is not on PATH.
set -u
cd "$(dirname "$0")/.."

if ! command -v dsh >/dev/null 2>&1; then
  echo "smoke-dsh: skip (dsh not found in PATH)"
  exit 0
fi

WORKDIR="$(mktemp -d /tmp/wao-dsh-smoke.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

OUT="$WORKDIR/result.json"
if ! node --input-type=module - "$OUT" "$WORKDIR" <<'NODE'
  // Tiny harness: createRunner → round 1 (mint) → round 2 (resume) →
  // readHistory on the real session file → dump everything as JSON.
  import { writeFileSync } from 'node:fs';
  import { createRunner } from './plugins/provider-dsh/runner.js';
  import { readHistory } from './plugins/provider-dsh/history.js';
  const [out, cwd] = process.argv.slice(2);
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mk = () => createRunner({
    bot: { id: 'smoke', provider: 'dsh' },
    providerConfig: { dshBin: 'dsh', cwd, profile: 'headless' },
    log,
  });
  const run = (prompt, sessionId) => mk().run({
    prompt, sessionId, signal: new AbortController().signal, timeoutMs: 180_000,
  });

  const r1 = await run('我的代号是菠萝。只回复两个字：记住了', null);
  const r2 = await run('我们刚才说的水果是什么？只回答水果名', r1.sessionId);
  const hist = r2.sessionId ? readHistory({ dshBin: 'dsh', cwd }, r2.sessionId) : null;
  writeFileSync(out, JSON.stringify({ r1, r2, hist }, null, 2));
NODE
then
  echo "smoke-dsh: FAIL (harness crashed)"
  exit 1
fi

echo "smoke-dsh: result →"
cat "$OUT"
echo

CODE1="$(node -e 'console.log(require(process.argv[1]).r1.code)' "$OUT")"
SID="$(node -e 'console.log(require(process.argv[1]).r1.sessionId??"" )' "$OUT")"
CODE2="$(node -e 'console.log(require(process.argv[1]).r2.code)' "$OUT")"
FINAL2="$(node -e 'console.log(require(process.argv[1]).r2.finalText??"" )' "$OUT")"
HIST="$(node -e 'const h=require(process.argv[1]).hist;console.log(h?`${h.turns.length}|${h.warnings.length}`:"none")' "$OUT")"

FAIL=0
[ "$CODE1" = "completed" ] && [ -n "$SID" ] || { echo "smoke-dsh: FAIL round1 (code=$CODE1, sid=${SID:-none})"; FAIL=1; }
[ "$CODE2" = "completed" ] || { echo "smoke-dsh: FAIL round2 code (got $CODE2)"; FAIL=1; }
case "$FINAL2" in *菠萝*) ;; *) echo "smoke-dsh: FAIL round2 memory (finalText=${FINAL2:-empty} lacks 菠萝)"; FAIL=1;; esac
[ "$HIST" != "none" ] || { echo "smoke-dsh: FAIL history (no readHistory result)"; FAIL=1; }
if [ "$HIST" != "none" ]; then
  TURNS="${HIST%%|*}"; WARNS="${HIST##*|}"
  [ "$TURNS" -ge 2 ] 2>/dev/null || { echo "smoke-dsh: FAIL history turns (got ${TURNS})"; FAIL=1; }
  [ "$WARNS" = "0" ] || echo "smoke-dsh: note history warnings=$WARNS"
fi

if [ "$FAIL" = "0" ]; then
  echo "smoke-dsh: PASS (round1 completed sid=$SID; round2 completed remembered 菠萝; history turns=$TURNS)"
  exit 0
fi
exit 1
