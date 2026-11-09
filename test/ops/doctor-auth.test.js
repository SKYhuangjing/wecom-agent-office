// doctor auth 输出三分支 (2026-11-09 评审残留): 未设 env 必须明确宣告「跳过」，
// 不能静默——否则接手者会把「doctor 没有 auth 行」误读为检查通过。三分支都用
// 真 CLI 进程跑（spawnSync），断言逐字输出；--port 取空闲高位避免碰生产 8792。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'src', 'index.js');

const runDoctor = (envValue) => {
  const env = { ...process.env };
  if (envValue === undefined) delete env.WAO_TOKEN;
  else env.WAO_TOKEN = envValue;
  // Port 0 → kernel picks a free port; doctor's auth probe then finds no live
  // service, which is exactly the informational branch we assert below.
  const r = spawnSync(process.execPath, [entry, 'doctor', '--port', '0'], {
    env, encoding: 'utf8', timeout: 20_000, cwd: repoRoot,
  });
  assert.equal(r.error, undefined, `doctor spawn failed: ${r.error?.message}`);
  return r.stdout + r.stderr;
};

test('doctor: 未设 WAO_TOKEN env → 明确输出「跳过」，不静默', () => {
  const out = runDoctor(undefined);
  assert.match(out, /auth: 未设 env，跳过 WAO_TOKEN 生效性实测/);
  assert.match(out, /export WAO_TOKEN 后复跑 doctor/);
  assert.doesNotMatch(out, /✓ auth: WAO_TOKEN 鉴权生效/);
});

test('doctor: WAO_TOKEN 为空 → 明确输出「鉴权未启用」', () => {
  const out = runDoctor('');
  assert.match(out, /auth: WAO_TOKEN 设置为空——鉴权未启用/);
  assert.doesNotMatch(out, /未设 env，跳过/);
});

test('doctor: WAO_TOKEN 非空但无服务 → 信息性「未验证」，不是 ✓ 也不是 ✗', () => {
  const out = runDoctor('{{SECRET_s1cupphz}}');
  assert.match(out, /auth: WAO_TOKEN 已设置，但 .* 无服务应答——鉴权生效性未验证/);
  assert.doesNotMatch(out, /✓ auth: WAO_TOKEN 鉴权生效/);
});
