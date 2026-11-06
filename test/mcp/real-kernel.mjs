#!/usr/bin/env node
// Standalone ISOLATED kernel for the real-CLI MCP acceptance (W1 T4,
// test/mcp/real-accept.sh). Production 8792 is NEVER touched: this boots
// createKernel on an explicit port with a tmp dataDir and the FULL repo
// plugins (core-engine, mcp-gateway, providers, ui …) plus the two fake port
// plugins from test/mcp/tools.test.js (channel-fake 'fakechan' / provider-fake
// 'fakeprov') so a real Agent CLI can safely operate the company — tool
// surface only, no real WeCom, the fake provider just echoes prompts.
//
// Usage: node test/mcp/real-kernel.mjs --port 18793 --data-dir <dir> --fakes <dir>
//   --fakes dir receives the fake plugin dirs (rewritten idempotently each boot)
// Prints `REAL-KERNEL READY port=<p>` on STDOUT once listening (kernel logs go
// to stderr + <dataDir>/logs/wao.log). SIGINT/SIGTERM run the four-phase stop
// and exit 0 — rerunning with the same --data-dir is the restart-recovery leg.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) throw new Error(`missing --${name}`);
  return argv[i + 1];
};
const port = Number(flag('port'));
const dataDir = flag('data-dir');
const fakesDir = flag('fakes');
if (!Number.isInteger(port) || port <= 0) throw new Error(`bad --port: ${argv}`);

// Fake port plugins — byte-for-byte the same shapes as test/mcp/tools.test.js:
// a recording channel adapter and a scripted provider runner (echoes prompts in
// finalText: 'fake 完成：<prompt>'). The globalThis recording hooks are inert
// in this standalone process but kept so the two definitions cannot drift.
const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [
        { key: 'endpoint', label: 'Endpoint', type: 'string', required: true },
        { key: 'secret', label: 'Secret', type: 'password', required: false },
      ],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ bot, engine }) {
        const adapter = {
          engine, pushes: [],
          start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {},
          push(chatRef, text) { adapter.pushes.push({ chatRef, text }); },
        };
        (globalThis.__waoMcpAdapters ??= new Map()).set(bot.id, adapter);
        return adapter;
      },
    });
  },
};`;

const FAKE_PROVIDER = `
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
        { key: 'mode', label: 'Mode', type: 'enum', options: ['a', 'b'], required: false },
        { key: 'extra', label: 'Extra object', type: 'object' },
      ],
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig?.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig() { return { changed: true }; },
      removeConfig() { return { removed: true }; },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, onEvent }) {
            (globalThis.__waoMcpPrompts ??= []).push(prompt);
            if (onEvent) onEvent({ type: 'text', text: '好的：' + prompt });
            return { ok: true, code: 'completed', finalText: 'fake 完成：' + prompt, aborted: false, sessionId: sessionId || 'session-fake-' + bot.id, reason: null, detail: { exitCode: 0 } };
          },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
      describeError(r) { return 'fake error: ' + (r?.code ?? 'unknown'); },
    });
  },
};`;

const writePluginDir = (dir, src) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), src);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};
writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);

const kernel = await createKernel({ port, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
process.stdout.write(`REAL-KERNEL READY port=${kernel.http.port} pid=${process.pid}\n`);

let stopping = false;
const shutdown = async (sig) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`REAL-KERNEL stopping (${sig})\n`);
  try {
    await kernel.stop();
  } finally {
    process.stdout.write('REAL-KERNEL stopped\n');
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
