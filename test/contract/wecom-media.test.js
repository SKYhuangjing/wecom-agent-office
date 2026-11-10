// channel-wecom media contract tests (DESIGN-MULTIMODAL Phase 1/2):
//   1) decryptMedia —— AES-256-CBC + 32 字节 PKCS#7 手工去填，与官方 SDK
//      @wecom/aibot-node-sdk src/crypto.ts (1.0.6, MIT) 同构。官方
//      __tests__/wecom-crypto.test.ts 是占位模板（密钥栏写着 <your
//      encodingAESKey>），没有可直接平移的已知密文对——向量改为「SDK 同构
//      加密器自产 + 解密器还原」并在逐字节上断言（含恰好 32 倍数块加整块
//      填充、坏 padding、坏 key 长度三条边界，等价锁行为）。
//   2) sniffType / sanitizeName / filenameFromDisposition —— magic bytes 与
//      展示名清洗（不可信数据红线）。
//   3) fetchBytes —— 本地 http 假源站：成功 / 超时 / 非 2xx / 超限。
//   4) createMediaStore —— 落盘路径形状（sha256 寻址）、去重、图片大小与
//      格式婉拒、per-bot 配额 LRU、7 天过期清理。
//   5) adapter 附件信封 —— fake WS（channel-wecom.test.js startFakeWecom 的
//      精简复制）+ 加密图片源站 + engine.botFeatures：vision 开关、单聊图、
//      mixed 图文、下载失败分级文案、attachments/attachmentFailures 信封。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import {
  MEDIA_LIMITS, MediaError, decryptMedia, sniffType, sanitizeName,
  filenameFromDisposition, fetchBytes, createMediaStore,
} from '../../plugins/channel-wecom/media.js';
import { createAdapter } from '../../plugins/channel-wecom/adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeoutMs = 8000, everyMs = 25) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return fn();
    await sleep(everyMs);
  }
};

// —— SDK 同构加密器（仅测试用）：32 字节块 PKCS#7 填充 + AES-256-CBC，
// IV=key 前 16 字节 —— 与企微服务端下发的密文同构。加密侧同样必须
// setAutoPadding(false)：Node 默认按 16 字节块 autopad，会把手工填好的
// 32 字节块密文再垫一块（解密侧就得靠手工去填还原）。
const encryptLikeWecom = (plain, keyBuf) => {
  const mod = plain.length % 32;
  const pad = mod === 0 ? 32 : 32 - mod; // SDK pkcs7Pad：整块时加一整块
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv('aes-256-cbc', keyBuf, keyBuf.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]);
};

// 1×1 红色 PNG（与 probe-baselines 同一张图）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const AESKEY_B64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'); // 32 字节 key

// --- decryptMedia ------------------------------------------------------------

test('decryptMedia: SDK-shaped AES-256-CBC ciphertext round-trips (incl. exact-32-byte-block padding)', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  // 通用例：PNG（69 字节 → pad 27）
  assert.deepEqual(decryptMedia(encryptLikeWecom(PNG_BYTES, key), AESKEY_B64), PNG_BYTES);
  // 恰好 32 倍数：必须加整块 32 字节填充（SDK pkcs7Pad 语义）
  const exact = Buffer.alloc(64, 0xab);
  assert.deepEqual(decryptMedia(encryptLikeWecom(exact, key), AESKEY_B64), exact);
  // 空明文（pad=32 整块）也合法
  assert.equal(decryptMedia(encryptLikeWecom(Buffer.alloc(0), key), AESKEY_B64).length, 0);
});

test('decryptMedia: bad padding / bad key length / empty input → MediaError(decrypt-failed)', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  // 篡改末字节 → padding 校验失败（或 CBC 解密乱码后 padding 值非法）
  const bad = encryptLikeWecom(PNG_BYTES, key);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => decryptMedia(bad, AESKEY_B64), (e) => e instanceof MediaError && e.code === 'decrypt-failed');
  // key 解码后非 32 字节
  assert.throws(() => decryptMedia(bad, Buffer.from('short').toString('base64')),
    (e) => e instanceof MediaError && e.code === 'decrypt-failed');
  // 空密文
  assert.throws(() => decryptMedia(Buffer.alloc(0), AESKEY_B64),
    (e) => e instanceof MediaError && e.code === 'decrypt-failed');
});

// --- sniffType / sanitizeName / disposition -----------------------------------

test('sniffType: magic bytes decide png/jpg/gif/webp/pdf/zip; suffix lies never trusted', async () => {
  assert.deepEqual(sniffType(PNG_BYTES), { ext: 'png', mediaType: 'image/png' });
  assert.deepEqual(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { ext: 'jpg', mediaType: 'image/jpeg' });
  assert.deepEqual(sniffType(Buffer.from('GIF89a\x01\x00', 'latin1')), { ext: 'gif', mediaType: 'image/gif' });
  assert.deepEqual(sniffType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), { ext: 'webp', mediaType: 'image/webp' });
  assert.deepEqual(sniffType(Buffer.from('%PDF-1.7\n', 'latin1')), { ext: 'pdf', mediaType: 'application/pdf' });
  assert.deepEqual(sniffType(Buffer.from('PK\x03\x04xxxx', 'latin1')), { ext: 'zip', mediaType: 'application/zip' });
  // 纯文本（无 magic）与截断短 buffer → null（file 落 bin、image 直接婉拒）
  assert.equal(sniffType(Buffer.from('hello world this is text')), null);
  assert.equal(sniffType(Buffer.from('ab')), null);
});

test('sanitizeName: strips control chars and path separators, caps length', async () => {
  assert.equal(sanitizeName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeName('a\\b\r\nc\td\0e'), 'a_b  c d e'); // \r\n → 两个空格
  assert.equal(sanitizeName('x'.repeat(500)).length, 120);
  assert.equal(sanitizeName(undefined), '');
});

test('filenameFromDisposition: quoted, bare and RFC 5987 forms', async () => {
  assert.equal(filenameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf');
  assert.equal(filenameFromDisposition('attachment; filename=report.pdf'), 'report.pdf');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"), '报告.pdf');
  assert.equal(filenameFromDisposition(''), '');
  assert.equal(filenameFromDisposition('inline'), '');
});

// --- fetchBytes against a local origin ----------------------------------------

function startOrigin(routes) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const r = routes[req.url];
      if (r == null) { res.statusCode = 404; res.end('nope'); return; }
      r(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r2) => server.close(() => r2())) });
    });
  });
}

test('fetchBytes: ok / HTTP error / timeout / oversize — all structured', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  const cipher = encryptLikeWecom(PNG_BYTES, key);
  const origin = await startOrigin({
    '/ok.png': (_q, res) => { res.end(cipher); },
    '/boom': (_q, res) => { res.statusCode = 500; res.end('server exploded'); },
    '/slow': () => { /* never responds */ },
    '/huge': (_q, res) => {
      res.setHeader('content-length', String(MEDIA_LIMITS.maxDownloadBytes + 1));
      res.end();
    },
  });
  try {
    assert.deepEqual(await fetchBytes(`${origin.url}/ok.png`), cipher);
    await assert.rejects(() => fetchBytes(`${origin.url}/boom`), (e) => e.code === 'download-failed');
    await assert.rejects(() => fetchBytes(`${origin.url}/slow`, { timeoutMs: 300 }), (e) => e.code === 'download-timeout');
    await assert.rejects(() => fetchBytes(`${origin.url}/huge`), (e) => e.code === 'too-large');
    await assert.rejects(() => fetchBytes('ftp://nope/x'), (e) => e.code === 'download-failed');
  } finally {
    await origin.close();
  }
});

// 盲评 P1-1 回归钉：headers 已回但 body 拖住（弱网/CDN 截断/代理挂起）——
// timeout 必须在 ~timeoutMs 内触发。旧实现 timer 在 fetch 返回（只等到
// headers）即清，body 读取无预算，会拖到 undici 默认 bodyTimeout（~300s）。
test('fetchBytes: headers arrive but body stalls → timeout at ~timeoutMs, NOT the undici bodyTimeout', async () => {
  const origin = await startOrigin({
    '/stall-body': (_q, res) => {
      res.setHeader('content-length', '1000');
      res.flushHeaders(); // headers 先走，body 永远不发
    },
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => fetchBytes(`${origin.url}/stall-body`, { timeoutMs: 400 }),
      (e) => e.code === 'download-timeout',
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 5000, `timeout fired ${dt}ms in (not the ~300s undici default body timeout)`);
  } finally {
    await origin.close();
  }
});

// 盲评 P2-3 回归钉：无 content-length 的超大 body 在流式读取中超限即断，
// 不等全量入内存（断言快点失败即可——本用例源站会持续倾倒数据）。
test('fetchBytes: chunked body exceeding maxBytes aborts mid-stream (too-large)', async () => {
  const origin = await startOrigin({
    '/endless': (_q, res) => {
      res.setHeader('content-type', 'application/octet-stream'); // 无 content-length → chunked
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const timer = setInterval(() => { res.write(chunk); }, 20);
      res.on('close', () => clearInterval(timer));
    },
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => fetchBytes(`${origin.url}/endless`, { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 }),
      (e) => e.code === 'too-large',
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 5000, `bail out mid-stream at ${dt}ms`);
  } finally {
    await origin.close();
  }
});

// --- createMediaStore ----------------------------------------------------------

test('store.save: content-addressed path <botId>/<yyyymm>/<sha256>.<ext>, dedupes, enforces kind budgets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-media-'));
  try {
    const store = createMediaStore({ root, log: null });
    const saved = store.save({ botId: 'bot-1', bytes: PNG_BYTES, kind: 'image' });
    const sha = createHash('sha256').update(PNG_BYTES).digest('hex');
    const ym = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    assert.equal(saved.sha256, sha);
    assert.equal(saved.ext, 'png');
    assert.equal(saved.mediaType, 'image/png');
    assert.equal(saved.size, PNG_BYTES.length);
    assert.equal(saved.path, join(root, 'bot-1', ym, `${sha}.png`));
    assert.ok(existsSync(saved.path));

    // 同内容去重：二次 save 不炸不改
    const again = store.save({ botId: 'bot-1', bytes: PNG_BYTES, kind: 'image' });
    assert.equal(again.path, saved.path);

    // 图片超 4MB（解密后）→ too-large
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(MEDIA_LIMITS.maxImageBytes, 1)]);
    assert.throws(() => store.save({ botId: 'bot-1', bytes: big, kind: 'image' }),
      (e) => e.code === 'too-large');
    // 未知图片格式（无 magic）→ unsupported-type
    assert.throws(() => store.save({ botId: 'bot-1', bytes: Buffer.from('plain text, not an image'), kind: 'image' }),
      (e) => e.code === 'unsupported-type');
    // file 预算 20MB、未知 magic → bin
    const bigFile = Buffer.alloc(MEDIA_LIMITS.maxFileBytes - 1024, 7);
    const f = store.save({ botId: 'bot-1', bytes: bigFile, kind: 'file' });
    assert.equal(f.ext, 'bin');
    assert.equal(f.mediaType, 'application/octet-stream');
    // botId 越权（路径段注入）→ 拒绝
    assert.throws(() => store.save({ botId: '../evil', bytes: PNG_BYTES, kind: 'image' }),
      (e) => e.code === 'bad-bot-id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: quota LRU evicts oldest; sweepExpired removes >7d files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-media-q-'));
  let clock = 1_700_000_000_000;
  try {
    const store = createMediaStore({
      root, log: null, now: () => clock,
      // 每份文件 PNG+1 字节；预算恰好 3 份——第 4 份进来必须挤掉最旧的。
      limits: { ...MEDIA_LIMITS, botQuotaBytes: (PNG_BYTES.length + 1) * 3 },
    });
    // 三个等大文件，配额只容 3 份；第 4 份进来时最旧的 1 号被挤掉。
    const paths = [];
    for (let i = 0; i < 3; i += 1) {
      const bytes = Buffer.concat([PNG_BYTES, Buffer.from([i])]); // 同尺寸、不同内容
      paths.push(store.save({ botId: 'b1', bytes, kind: 'image' }).path);
      clock += 1000;
    }
    const fourth = store.save({ botId: 'b1', bytes: Buffer.concat([PNG_BYTES, Buffer.from([9])]), kind: 'image' });
    assert.equal(existsSync(paths[0]), false, 'oldest evicted by quota LRU');
    assert.ok(existsSync(paths[1]) && existsSync(paths[2]) && existsSync(fourth.path));

    // 7 天过期：把幸存文件 mtime 拨回 8 天前 → sweep 清掉
    const old = clock - 8 * 24 * 60 * 60 * 1000;
    for (const p of [paths[1], paths[2], fourth.path]) utimesSync(p, new Date(old), new Date(old));
    const removed = store.sweepExpired('b1');
    assert.equal(removed, 3);
    assert.equal(existsSync(fourth.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- adapter attachment envelope (fake WS + encrypted origin) ------------------

// channel-wecom.test.js startFakeWecom 的精简复制（只需 subscribe ack 与
// msg_callback 注入；完整版在那里）。
function startFakeWecom() {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const st = { frames: [], sockets: [] };
    wss.on('connection', (ws) => {
      st.sockets.push(ws);
      ws.on('message', (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch { return; }
        st.frames.push(msg);
        if (msg.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0, errmsg: 'ok' }));
        } else if (msg.cmd && msg.cmd !== 'ping') {
          ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0 }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      st.url = `ws://127.0.0.1:${server.address().port}`;
      st.sendToCurrent = (obj) => {
        const ws = st.sockets[st.sockets.length - 1];
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      st.close = async () => {
        for (const ws of st.sockets) { try { ws.terminate(); } catch {} }
        await new Promise((r) => wss.close(() => r()));
        await new Promise((r) => server.close(() => r()));
      };
      resolve(st);
    });
  });
}

function makeLog() {
  const warns = [];
  return {
    warns,
    info: () => {}, debug: () => {},
    warn: (...a) => warns.push(a.map(String).join(' ')),
    error: () => {},
  };
}

// engine fake：onMessage 收集 + botFeatures 注入（core-engine 的 channel
// facade 同款字段：visionSupported / vision）。
function makeEngine({ features = {} } = {}) {
  const messages = [];
  return { messages, onMessage: (m) => messages.push(m), botFeatures: () => features, onChannelEvent: () => false };
}

const DECLINE_ENGINE_NO_VISION = '该 bot 的引擎暂不支持图片，仅处理文字部分。';
const DECLINE_VISION_OFF = '图片处理未开启：请管理员在机器人配置中打开「图片输入」后再发图。';
const DECLINE_IMAGE_DOWNLOAD = '图片下载失败，请重发。';

async function withAdapter(t, { features, routes }, fn) {
  const key = Buffer.from(AESKEY_B64, 'base64');
  const server = await startFakeWecom();
  const origin = await startOrigin(routes ?? {
    '/img.png': (_q, res) => { res.end(encryptLikeWecom(PNG_BYTES, key)); },
  });
  const mediaRoot = mkdtempSync(join(tmpdir(), 'wao-media-adapter-'));
  const engine = makeEngine({ features });
  const adapter = createAdapter({
    account: { botId: 'B1', secret: 'S1', wsUrl: server.url },
    bot: { id: 'bot-1', name: '小助手' },
    log: makeLog(),
    engine,
    WebSocket,
    mediaStore: createMediaStore({ root: mediaRoot, log: null }),
  });
  adapter.start();
  try {
    await until(() => adapter.status().state === 'online');
    await fn({ server, origin, engine, adapter });
  } finally {
    adapter.stop();
    await server.close();
    await origin.close();
    rmSync(mediaRoot, { recursive: true, force: true });
  }
}

const msgCallback = (reqId, body) => ({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });
const respondFrames = (server) => server.frames.filter((f) => f.cmd === 'aibot_respond_msg');
const declineOf = (server, reqId) => respondFrames(server).find((f) => f.headers.req_id === reqId)?.body?.markdown?.content;

const singleImage = (url) => ({
  chattype: 'single', from: { userid: 'u2' }, msgtype: 'image', image: { url, aeskey: AESKEY_B64 },
});

test('attachments: vision on + single image → downloaded, decrypted, envelope reaches engine', async () => {
  await withAdapter(null, { features: { visionSupported: true, vision: true } }, async ({ server, origin, engine }) => {
    server.sendToCurrent(msgCallback('r-img1', singleImage(`${origin.url}/img.png`)));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.chatKey, 'wecom:single:u2');
    assert.equal(m.text, '');
    assert.equal(m.attachments.length, 1);
    const a = m.attachments[0];
    assert.equal(a.kind, 'image');
    assert.equal(a.mediaType, 'image/png');
    assert.equal(a.size, PNG_BYTES.length);
    assert.match(a.path, /bot-1[/\\]\d{6}[/\\][0-9a-f]{64}\.png$/);
    assert.equal(a.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.deepEqual(readFileSync(a.path), PNG_BYTES, 'decrypted bytes on disk');
    assert.deepEqual(m.attachmentFailures ?? [], []);
  });
});

test('attachments: vision off + pure image → 引导开启 copy; mixed 图文 → text 进引擎 + failures 注记', async () => {
  await withAdapter(null, { features: { visionSupported: true, vision: false } }, async ({ server, origin, engine }) => {
    // 纯图（单聊）：直接婉拒，不进引擎
    server.sendToCurrent(msgCallback('r-off1', singleImage(`${origin.url}/img.png`)));
    await until(() => declineOf(server, 'r-off1') != null);
    assert.equal(declineOf(server, 'r-off1'), DECLINE_VISION_OFF);
    assert.equal(engine.messages.length, 0);

    // mixed 图文：文字照走，附件拒收原因随信封（不炸不静默）
    server.sendToCurrent(msgCallback('r-off2', {
      chattype: 'single', from: { userid: 'u2' }, msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '这张图里是什么' } },
        { msgtype: 'image', image: { url: `${origin.url}/img.png`, aeskey: AESKEY_B64 } },
      ] },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.text, '这张图里是什么');
    assert.deepEqual(m.attachments, []);
    assert.deepEqual(m.attachmentFailures, [{ kind: 'image', code: 'vision-off' }]);
  });
});

test('attachments: engine without vision (dsh) → 引擎不支持 copy; text-only mixed still runs', async () => {
  await withAdapter(null, { features: { visionSupported: false, vision: false } }, async ({ server, origin, engine }) => {
    server.sendToCurrent(msgCallback('r-dsh', singleImage(`${origin.url}/img.png`)));
    await until(() => declineOf(server, 'r-dsh') != null);
    assert.equal(declineOf(server, 'r-dsh'), DECLINE_ENGINE_NO_VISION);
    assert.equal(engine.messages.length, 0);

    server.sendToCurrent(msgCallback('r-dsh2', {
      chattype: 'single', from: { userid: 'u2' }, msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '仅文字问题' } },
        { msgtype: 'image', image: { url: `${origin.url}/img.png`, aeskey: AESKEY_B64 } },
      ] },
    }));
    await until(() => engine.messages.length === 1);
    assert.equal(engine.messages[0].text, '仅文字问题');
    assert.deepEqual(engine.messages[0].attachmentFailures, [{ kind: 'image', code: 'engine-no-vision' }]);
  });
});

test('attachments: download failure (pure image) → 重发 copy; mixed partial failure keeps good attachment', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  await withAdapter(null, {
    features: { visionSupported: true, vision: true },
    routes: {
      '/img.png': (_q, res) => { res.end(encryptLikeWecom(PNG_BYTES, key)); },
      '/bad.png': (_q, res) => { res.statusCode = 500; res.end('boom'); },
    },
  }, async ({ server, origin, engine }) => {
    // 纯图 + 源站 500 → 文案矩阵的「图片下载失败，请重发」
    server.sendToCurrent(msgCallback('r-bad', singleImage(`${origin.url}/bad.png`)));
    await until(() => declineOf(server, 'r-bad') != null);
    assert.equal(declineOf(server, 'r-bad'), DECLINE_IMAGE_DOWNLOAD);
    assert.equal(engine.messages.length, 0);

    // mixed 两图一好一坏：好图进 attachments，坏图进 failures，文字保留
    server.sendToCurrent(msgCallback('r-mix', {
      chattype: 'single', from: { userid: 'u2' }, msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '对比这两张图' } },
        { msgtype: 'image', image: { url: `${origin.url}/img.png`, aeskey: AESKEY_B64 } },
        { msgtype: 'image', image: { url: `${origin.url}/bad.png`, aeskey: AESKEY_B64 } },
      ] },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.text, '对比这两张图');
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].mediaType, 'image/png');
    assert.equal(m.attachmentFailures.length, 1);
    assert.equal(m.attachmentFailures[0].code, 'download-failed');
  });
});

test('attachments: msgtype=file (vision on) → kind=file envelope; wrong aeskey → decrypt-failed decline', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  const textBytes = Buffer.from('报表内容：一切正常\n', 'utf8');
  await withAdapter(null, {
    features: { visionSupported: true, vision: true },
    routes: {
      '/report.bin': (_q, res) => {
        res.setHeader('content-disposition', 'attachment; filename="report.txt"');
        res.end(encryptLikeWecom(textBytes, key));
      },
      '/garbage.bin': (_q, res) => { res.end(Buffer.from('not encrypted at all — just bytes')); },
    },
  }, async ({ server, origin, engine }) => {
    // file 消息：filename 从下载响应取（展示名），kind=file
    server.sendToCurrent(msgCallback('r-file', {
      chattype: 'single', from: { userid: 'u2' }, msgtype: 'file',
      file: { url: `${origin.url}/report.bin`, aeskey: AESKEY_B64 },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].kind, 'file');
    assert.equal(m.attachments[0].name, 'report.txt');
    assert.deepEqual(readFileSync(m.attachments[0].path), textBytes);

    // aeskey 与密文不配 → 解密失败 → 纯文件消息直接婉拒「文件下载失败」
    server.sendToCurrent(msgCallback('r-garb', {
      chattype: 'single', from: { userid: 'u2' }, msgtype: 'file',
      file: { url: `${origin.url}/garbage.bin`, aeskey: AESKEY_B64 },
    }));
    await until(() => declineOf(server, 'r-garb') != null);
    assert.equal(declineOf(server, 'r-garb'), '文件下载失败，请重发。');
    assert.equal(engine.messages.length, 1);
  });
});

// 盲评 P1-4 回归钉：vision 门禁只对图片——dsh（无视觉）bot 的文件消息照样
// 进引擎（文本类四家全受益，DESIGN §4.3），不会拿「引擎暂不支持图片」的
// 文案指鹿为马；同 bot 的纯图仍被门禁拦住（回归：不是全放开）。
test('attachments: engine WITHOUT vision (dsh) still receives FILES — the vision gate is image-only', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  const noteBytes = Buffer.from('dsh 也能读的纯文本附件\n', 'utf8');
  await withAdapter(null, {
    features: { visionSupported: false, vision: false },
    routes: {
      '/note.bin': (_q, res) => {
        res.setHeader('content-disposition', 'attachment; filename="note.txt"');
        res.end(encryptLikeWecom(noteBytes, key));
      },
      '/img.png': (_q, res) => { res.end(encryptLikeWecom(PNG_BYTES, key)); },
    },
  }, async ({ server, origin, engine }) => {
    // dsh + 纯文本文件：附件进引擎（文本内联发生在 engine fileSectionFor）
    server.sendToCurrent(msgCallback('r-dsh-file', {
      chattype: 'single', from: { userid: 'u3' }, msgtype: 'file',
      file: { url: `${origin.url}/note.bin`, aeskey: AESKEY_B64 },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.text, '');
    assert.equal(m.attachments.length, 1, 'file reaches the engine despite no vision');
    assert.equal(m.attachments[0].kind, 'file');
    assert.equal(m.attachments[0].name, 'note.txt');
    assert.deepEqual(readFileSync(m.attachments[0].path), noteBytes);
    assert.deepEqual(m.attachmentFailures ?? [], []);

    // 同 bot + 纯图：门禁照拦（文案针对图片，语义正确）
    server.sendToCurrent(msgCallback('r-dsh-img', singleImage(`${origin.url}/img.png`)));
    await until(() => declineOf(server, 'r-dsh-img') != null);
    assert.equal(declineOf(server, 'r-dsh-img'), DECLINE_ENGINE_NO_VISION);
    assert.equal(engine.messages.length, 1, 'pure image still gated');
  });
});

// 盲评 P1-2 回归钉（渠道层）：单条消息附件数上限 4——超出的不下载、逐项
// 注记 too-many，好附件保留（绝不静默丢、绝不整轮拒绝）。
test('attachments: 5 images in one mixed → first 4 fetched, the 5th annotated too-many', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  await withAdapter(null, {
    features: { visionSupported: true, vision: true },
    routes: { '/img.png': (_q, res) => { res.end(encryptLikeWecom(PNG_BYTES, key)); } },
  }, async ({ server, origin, engine }) => {
    const imgItem = () => ({ msgtype: 'image', image: { url: `${origin.url}/img.png`, aeskey: AESKEY_B64 } });
    server.sendToCurrent(msgCallback('r-many', {
      chattype: 'single', from: { userid: 'u4' }, msgtype: 'mixed',
      mixed: { msg_item: [{ msgtype: 'text', text: { content: '对比这些图' } }, ...Array.from({ length: 5 }, imgItem)] },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.text, '对比这些图');
    assert.equal(m.attachments.length, 4, 'exactly MAX_ATTACHMENTS fetched');
    assert.equal(m.attachmentFailures.length, 1);
    assert.equal(m.attachmentFailures[0].code, 'too-many');
    assert.equal(m.attachmentFailures[0].kind, 'image');
  });
});

// 复测 P2-5：mixed + vision off + 超额图——vision 注记只对配额内的图，超额图只
// 记一条 too-many（修复前同一张图会出现「vision-off + too-many」两条注记，
// 5 张图产生 6 条注记）。
test('attachments: mixed 5 images + vision off → 4 vision-off + 1 too-many (one note per image)', async () => {
  const key = Buffer.from(AESKEY_B64, 'base64');
  await withAdapter(null, {
    features: { visionSupported: true, vision: false },
    routes: { '/img.png': (_q, res) => { res.end(encryptLikeWecom(PNG_BYTES, key)); } },
  }, async ({ server, origin, engine }) => {
    const imgItem = () => ({ msgtype: 'image', image: { url: `${origin.url}/img.png`, aeskey: AESKEY_B64 } });
    server.sendToCurrent(msgCallback('r-many-off', {
      chattype: 'single', from: { userid: 'u4' }, msgtype: 'mixed',
      mixed: { msg_item: [{ msgtype: 'text', text: { content: '看这些图' } }, ...Array.from({ length: 5 }, imgItem)] },
    }));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.text, '看这些图');
    const vision = m.attachmentFailures.filter((f) => f.code === 'vision-off');
    const over = m.attachmentFailures.filter((f) => f.code === 'too-many');
    assert.equal(vision.length, 4, 'only the in-quota images carry vision-off');
    assert.equal(over.length, 1, 'the 5th image is too-many only');
    assert.equal(m.attachmentFailures.length, 5, 'exactly one note per image');
  });
});
