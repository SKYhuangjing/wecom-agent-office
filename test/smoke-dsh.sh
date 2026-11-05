#!/bin/bash
# Real dsh smoke (Task 18) — drives plugins/provider-dsh/runner.js against the
# LOCAL dsh CLI (no WeCom, no server). Not part of `npm test`: it needs a real
# dsh install (and its credentials), so it runs on demand (T20 boot checklist).
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
  // Tiny harness: createRunner → run() → dump the result envelope as JSON.
  import { writeFileSync } from 'node:fs';
  import { createRunner } from './plugins/provider-dsh/runner.js';
  const [out, cwd] = process.argv.slice(2);
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const runner = createRunner({
    bot: { id: 'smoke', provider: 'dsh' },
    providerConfig: { dshBin: 'dsh', cwd, profile: 'headless' },
    log,
  });
  const events = [];
  const res = await runner.run({
    prompt: '只回复两个字：收到',
    sessionId: null,
    signal: new AbortController().signal,
    timeoutMs: 180_000,
    onEvent: (ev) => events.push(ev.type),
  });
  writeFileSync(out, JSON.stringify({ ...res, events }, null, 2));
NODE
then
  echo "smoke-dsh: FAIL (harness crashed)"
  exit 1
fi

echo "smoke-dsh: result →"
cat "$OUT"
echo

CODE="$(node -e 'const r=require(process.argv[1]);console.log(r.code)' "$OUT")"
FINAL="$(node -e 'const r=require(process.argv[1]);console.log(r.finalText??"" )' "$OUT")"
if [ "$CODE" = "completed" ] && [ -n "$FINAL" ]; then
  echo "smoke-dsh: PASS (code=completed, finalText=${#FINAL} chars)"
  exit 0
fi
echo "smoke-dsh: FAIL (code=$CODE, finalText empty? $([ -n "$FINAL" ] && echo no || echo yes))"
exit 1
