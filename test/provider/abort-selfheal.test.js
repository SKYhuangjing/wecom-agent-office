// Runner abort-kill 自愈存在性契约（2026-11-10 PC1 真机 P0 回归钉）。
// 真机形状：熔断/drain 的 abort 触发后无 SIGTERM 日志（一次性 abort 监听器
// 未触发），claude 又跑 13 分钟。修复=stdout(/stderr) data 处理器自检
// `signal?.aborted && !abortedBySignal` → 补触发 onAbort。
//
// 为什么是「存在性契约」而非行为测试：监听器在 run() 的 Promise executor 内
// 同步注册（数据事件最早在后续 tick），进程内无法从外部制造「监听器已注册
// 但漏触发」的窗口——那只在真实 OS 时序异常下出现。故此处钉「自检代码在位」
// （删除即挂），行为正确性由引擎侧 settle-watchdog 测试兜底（同一真机症状：
// 就算 runner 真漏杀，run 也必然结算、链条不楔）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('abort self-heal check present in ALL five runners (claude/codex/pi/dsh/cursor)', () => {
  for (const p of ['claude', 'codex', 'pi', 'dsh', 'cursor']) {
    const src = readFileSync(join(REPO, 'plugins', `provider-${p}`, 'runner.js'), 'utf8');
    assert.match(
      src,
      /if \(signal\?\.aborted && !abortedBySignal\) onAbort\(\);/,
      `${p}: stdout data 处理器必须带 abort 自检（2026-11-10 PC1 真机 P0）`,
    );
  }
});
