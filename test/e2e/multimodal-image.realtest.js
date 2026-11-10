// Multimodal image golden path over the REAL claude CLI (DESIGN-MULTIMODAL
// 收尾 16) — 全链路金标准：
//   本地 http 假源站（自造 aeskey，AES-256-CBC 加密一张真实 1×1 红 PNG）
//     → fake WS（aibot_msg_callback: single image {url, aeskey}）
//     → 真 channel adapter（下载+解密+落盘 media store）
//     → 真 Engine（真 Ledger/SessionCache，tmp dataDir）
//     → 真 provider-claude runner（stdin stream-json 信封 + base64 图片块，
//       模型经本机 ~/.claude 网关路由——同 switch-matrix 的机器事实）
//     → 断言最终回复真的提到图片内容（红）。
// 钉的是「纯图消息」这条最脆弱的路径：text 空串 + 附件（占位 text 块 +
// base64 块），与 probe 的图文混合腿互补。
// NOT part of `npm test`（真 CLI + token）：显式运行：
//   WAO_E2E_MULTIMODAL=1 node --test test/e2e/multimodal-image.realtest.js
// （probe 预算口径：本文件每次运行 1 次真 claude 调用。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { createAdapter } from '../../plugins/channel-wecom/adapter.js';
import { createMediaStore } from '../../plugins/channel-wecom/media.js';
import { createRunner as createClaudeRunner } from '../../plugins/provider-claude/runner.js';
import { Engine } from '../../plugins/core-engine/engine.js';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';

const RUN = process.env.WAO_E2E_MULTIMODAL === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeoutMs = 150_000, everyMs = 100) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return fn();
    await sleep(everyMs);
  }
};

// 1×1 红 PNG（与 probe-baselines 同图）与 SDK 同构加密器（32 字节块 PKCS#7）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const encryptLikeWecom = (plain, keyBuf) => {
  const mod = plain.length % 32;
  const pad = mod === 0 ? 32 : 32 - mod;
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv('aes-256-cbc', keyBuf, keyBuf.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]);
};

test('multimodal image golden path: encrypted wecom image → adapter → engine → real claude answers about the pixels', { skip: !RUN }, async () => {
  const aesKeyBuf = randomBytes(32);
  const aeskeyB64 = aesKeyBuf.toString('base64');
  const cipher = encryptLikeWecom(PNG_BYTES, aesKeyBuf);

  // 本地假源站：出企微同构的加密图片字节流
  const origin = createServer((req, res) => {
    if (req.url === '/img.png') {
      res.setHeader('content-disposition', 'attachment; filename="photo.png"');
      res.end(cipher);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originUrl = `http://127.0.0.1:${origin.address().port}`;

  // fake WS：subscribe ack + respond 帧 ack + msg_callback 注入口
  const wsSrv = createServer();
  const wss = new WebSocketServer({ server: wsSrv });
  const outboundTexts = [];
  let sock;
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.cmd === 'aibot_subscribe') {
        ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0, errmsg: 'ok' }));
      } else if (msg.cmd === 'aibot_respond_msg') {
        outboundTexts.push(String(msg.body?.stream?.content ?? msg.body?.markdown?.content ?? ''));
        ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0 }));
      }
    });
  });
  await new Promise((r) => wsSrv.listen(0, '127.0.0.1', r));

  const dataDir = mkdtempSync(join(tmpdir(), 'wao-e2e-mm-'));
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const ledger = new Ledger({ file: join(dataDir, 'ledger.jsonl'), log });
  const cache = new SessionCache({ file: join(dataDir, 'sessions.json'), log, ledger });

  const bot = {
    id: 'e2e-mm-bot', name: 'e2e', provider: 'claude', channel: 'wecom',
    providerConfig: { cwd: dataDir, visionInput: true },
  };
  const runner = createClaudeRunner({ bot, providerConfig: bot.providerConfig, log });

  // core-engine plugin.js channelFacadeFor 的手写等价物（botFeatures 打开视觉）
  const facade = {
    onMessage: (m) => engine.onMessage(bot, m),
    onChannelEvent: () => false,
    botFeatures: () => ({ visionSupported: true, vision: true }),
  };
  let adapter;
  const engine = new Engine({
    log,
    getRunner: () => runner,
    getAdapter: () => adapter,
    ledgerFactory: () => ({ ledger, cache }),
    middleware: { maskOutbound: (t) => t },
    limits: { minIntervalMs: 0, heartbeatMs: 10_000, hardTimeoutMs: 150_000, streamDeadlineMs: 140_000, warnLeadMs: 90_000 },
  });
  engine.attachBot(bot, { adapter: null, runner });
  adapter = createAdapter({
    account: { botId: 'B1', secret: 'S1', wsUrl: `ws://127.0.0.1:${wsSrv.address().port}` },
    bot, log, engine: facade, WebSocket,
    mediaStore: createMediaStore({ root: join(dataDir, 'media'), log }),
  });

  try {
    adapter.start();
    await until(() => adapter.status().state === 'online', 10_000);

    // 纯图消息（text 空）：附件下载解密落盘 → 引擎 → claude 信封
    sock.send(JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'e2e-mm-img' },
      body: {
        chattype: 'single', from: { userid: 'e2e-user' }, msgtype: 'image',
        image: { url: `${originUrl}/img.png`, aeskey: aeskeyB64 },
      },
    }));

    const finalText = await until(() => {
      const hits = outboundTexts.filter((t) => t.includes('红') || /red/i.test(t));
      return hits.length > 0 ? hits[hits.length - 1] : null;
    }, 150_000);
    assert.ok(finalText, `model answer mentions the image color (got: ${JSON.stringify(outboundTexts)})`);

    // 台账行带附件摘要（name 来自下载响应的 Content-Disposition）
    const rows = ledger.turns({ chatKey: 'wecom:single:e2e-user' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attachments.length, 1);
    assert.equal(rows[0].attachments[0].kind, 'image');
    assert.equal(rows[0].attachments[0].name, 'photo.png');
    assert.equal(rows[0].reason, 'completed');
  } finally {
    try { adapter.stop(); } catch {}
    for (const c of wss.clients) { try { c.terminate(); } catch {} }
    await new Promise((r) => wss.close(() => r()));
    await new Promise((r) => wsSrv.close(() => r()));
    await new Promise((r) => origin.close(() => r()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
