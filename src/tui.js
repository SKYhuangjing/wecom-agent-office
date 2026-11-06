// W2: `wao tui` — 运维仪表盘（owner dashboard）. Client view over an
// ALREADY-RUNNING service (default 127.0.0.1:8792): polls GET /api/agents
// every 2s and tails data/logs/wao.log when --data-dir is locally readable.
// Zero dependencies: node:readline (keypress) + hand-rolled ANSI.
//
// Architecture for testability — three modules under src/tui/, this file is
// the public barrel (import surface unchanged for src/index.js and tests):
//   engine.js  handleKey/applyResult/genBadgeId — pure key→state machine,
//              effects are plain descriptors (terminal-free testable)
//   render.js  computeFrame — pure state→frame (ANSI included), the whole
//              visual contract is snapshot-testable without a terminal
//   attach.js  makeLogTailer/openInBrowser/attachTUI/runTUI — the thin
//              shell: raw mode, 1s tick, dispatch effects against the SAME
//              /api the Web console uses, full-frame repaint on the
//              alternate screen. Ctrl-C / q restore the terminal and quit.
export { KEYBAR, computeFrame } from './tui/render.js';
export { genBadgeId, handleKey, applyResult } from './tui/engine.js';
export { makeLogTailer, openInBrowser, attachTUI, runTUI } from './tui/attach.js';
