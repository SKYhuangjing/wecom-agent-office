// channel-wecom contract tests (Task 17): the ported WeCom client + the
// five-primitive adapter exercised against a real 'ws' server on an
// ephemeral port (account.wsUrl points at it). The server speaks just enough
// of the WeCom openws protocol: acks subscribe/outbound frames (errcode 0,
// or a configurable error to simulate auth failure) and can push
// msg_callback / event_callback frames.
//
// Time-sensitive cases (auth-fail backoff cap, kicked no-reconnect) use real
// second-scale waits — those semantics ARE the contract (no retry storm, no
// reconnect after kicked), so they are asserted against real timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { createWecomClient } from '../../plugins/channel-wecom/client.js';
import { createAdapter, CAPABILITIES } from '../../plugins/channel-wecom/adapter.js';
import plugin from '../../plugins/channel-wecom/plugin.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `cond()` until true or timeout; returns the last value of cond().
async function until(cond, timeoutMs = 8000, everyMs = 25) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() >= end) return cond();
    await sleep(everyMs);
  }
}

function makeLog() {
  const warns = [];
  const debugs = [];
  return {
    warns,
    debugs,
    info: () => {},
    debug: (...a) => debugs.push(a.map(String).join(' ')),
    warn: (...a) => warns.push(a.map(String).join(' ')),
    error: () => {},
  };
}

function makeEngine() {
  const messages = [];
  const events = [];
  return {
    messages,
    events,
    onMessage: (m) => messages.push(m),
    // Sync `false` = "not handled" → adapter falls back to the default copy.
    onChannelEvent: (e) => {
      events.push(e);
      return false;
    },
  };
}

// Fake WeCom openws endpoint. st.frames records EVERY frame the client ever
// sent (across reconnects); st.connections counts connections (retry storms
// would show up here).
//
// respondAck controls how outbound aibot_respond_msg frames are acked:
//   'immediate' (default) — ack as soon as the frame arrives
//   'delayed'   — an ack is HELD until the NEXT respond frame arrives (then
//                 the previous one is released); st.flushHeld() releases the
//                 last held ack. Models a server whose acks land after the
//                 client has already registered the next frame.
//   'never'     — never ack respond frames (timeout path).
function startFakeWecom({ subscribeErrcode = 0, respondAck = 'immediate' } = {}) {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const st = {
      connections: 0,
      frames: [],
      sockets: [],
      subscribeErrcode,
      respondAck,
      flushHeld: () => {},
    };
    wss.on('connection', (ws) => {
      st.connections += 1;
      st.sockets.push(ws);
      let heldAck = null;
      st.flushHeld = () => {
        if (heldAck && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(heldAck));
          heldAck = null;
        }
      };
      ws.on('message', (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return;
        }
        st.frames.push(msg);
        if (msg.cmd === 'aibot_subscribe') {
          ws.send(
            JSON.stringify({
              headers: { req_id: msg.headers?.req_id },
              errcode: st.subscribeErrcode,
              errmsg: st.subscribeErrcode ? 'invalid credential' : 'ok',
            }),
          );
        } else if (msg.cmd && msg.cmd !== 'ping') {
          if (msg.cmd !== 'aibot_respond_msg' || st.respondAck === 'immediate') {
            // ack every outbound request (errcode 0, no cmd — protocol ack shape)
            ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0 }));
            return;
          }
          if (st.respondAck === 'never') return;
          // 'delayed': release the PREVIOUS held ack now, hold this one.
          if (heldAck && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(heldAck));
          heldAck = { headers: { req_id: msg.headers?.req_id }, errcode: 0 };
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      st.url = `ws://127.0.0.1:${server.address().port}`;
      st.current = () => st.sockets[st.sockets.length - 1];
      st.sendToCurrent = (obj) => {
        const ws = st.current();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      st.close = async () => {
        for (const ws of st.sockets) {
          try {
            ws.terminate();
          } catch {}
        }
        await new Promise((r) => wss.close(() => r()));
        await new Promise((r) => server.close(() => r()));
      };
      resolve(st);
    });
  });
}

function makeAdapter(server, engine, log, account = {}) {
  return createAdapter({
    account: { botId: 'B1', secret: 'S1', wsUrl: server.url, ...account },
    bot: { id: 'bot-1', name: '小助手' },
    log,
    engine,
    WebSocket,
  });
}

const groupText = (chatid, userid, content) => ({
  chattype: 'group',
  chatid,
  from: { userid },
  msgtype: 'text',
  text: { content },
});

const msgCallback = (reqId, body) => ({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });

const respondFrames = (server) => server.frames.filter((f) => f.cmd === 'aibot_respond_msg');

// ---------------------------------------------------------------------------

test('subscribe ack ok → online; heartbeat ping frames reach the server', async () => {
  const server = await startFakeWecom();
  const adapter = makeAdapter(server, makeEngine(), makeLog(), { pingIntervalSec: 0.2 });
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');
    const sub = server.frames.find((f) => f.cmd === 'aibot_subscribe');
    assert.ok(sub, 'subscribe frame sent');
    assert.equal(sub.body.bot_id, 'B1');
    assert.equal(sub.body.secret, 'S1');
    await until(() => server.frames.some((f) => f.cmd === 'ping'), 3000);
    const st = adapter.status();
    assert.equal(st.state, 'online');
    assert.equal(st.lastError, null);
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('group text → engine.onMessage with three-part chatKey; progress() emits stream frame', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const adapter = makeAdapter(server, engine, makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    server.sendToCurrent(msgCallback('r-g1', groupText('G1', 'u1', '@_user_1 帮我查一下今天的构建')));
    await until(() => engine.messages.length === 1);
    const m = engine.messages[0];
    assert.equal(m.botId, 'bot-1');
    assert.equal(m.chatKey, 'wecom:group:G1');
    assert.equal(m.chatKind, 'group');
    assert.equal(m.chatid, 'G1');
    assert.equal(m.userid, 'u1');
    assert.equal(m.text, '@_user_1 帮我查一下今天的构建');
    assert.equal(m.reqId, 'r-g1');
    assert.equal(m.raw?.cmd, 'aibot_msg_callback');

    // single chat: chatKey scoped by userid
    server.sendToCurrent(
      msgCallback('r-s1', { chattype: 'single', from: { userid: 'solo' }, msgtype: 'text', text: { content: '查下日程' } }),
    );
    await until(() => engine.messages.length === 2);
    assert.equal(engine.messages[1].chatKey, 'wecom:single:solo');
    assert.equal(engine.messages[1].chatKind, 'single');
    assert.equal(engine.messages[1].chatid, 'solo');

    // progress() → {msgtype:'stream', stream:{id, finish:false}} frame on the wire
    await adapter.progress('r-g1', 'sid-9', '处理中…', false);
    const frame = server.frames.find((f) => f.cmd === 'aibot_respond_msg' && f.body?.stream?.id === 'sid-9');
    assert.ok(frame, 'stream frame sent');
    assert.equal(frame.headers.req_id, 'r-g1');
    assert.equal(frame.body.msgtype, 'stream');
    assert.equal(frame.body.stream.id, 'sid-9');
    assert.equal(frame.body.stream.finish, false);
    assert.equal(frame.body.stream.content, '处理中…');

    // ack() is the same primitive with finish=false
    await adapter.ack('r-g1', 'sid-9', '收到');
    const ackFrames = respondFrames(server).filter((f) => f.body?.stream?.content === '收到');
    assert.equal(ackFrames.length, 1);
    assert.equal(ackFrames[0].body.stream.finish, false);
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('non-text inbound (image / mixed-with-only-image) → verbatim 暂不支持 decline', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const adapter = makeAdapter(server, engine, makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    server.sendToCurrent(
      msgCallback('r-img', { chattype: 'single', from: { userid: 'u2' }, msgtype: 'image', image: { url: 'x' } }),
    );
    await until(() => respondFrames(server).some((f) => f.headers.req_id === 'r-img'));
    const img = respondFrames(server).find((f) => f.headers.req_id === 'r-img');
    assert.equal(img.body.msgtype, 'markdown');
    assert.equal(img.body.markdown.content, '目前这个机器人只支持文字消息哦～（图片/文件/语音暂不支持）');

    server.sendToCurrent(
      msgCallback('r-mixed', {
        chattype: 'single',
        from: { userid: 'u2' },
        msgtype: 'mixed',
        mixed: { msg_item: [{ msgtype: 'image', image: { url: 'x' } }] },
      }),
    );
    await until(() => respondFrames(server).some((f) => f.headers.req_id === 'r-mixed'));
    const mixed = respondFrames(server).find((f) => f.headers.req_id === 'r-mixed');
    assert.equal(mixed.body.markdown.content, '目前这个机器人只支持文字消息哦～（图片/文件/语音暂不支持）');

    // nothing reached the engine
    assert.equal(engine.messages.length, 0);
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('empty @ (mention only, no text) → verbatim 空@ decline', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const adapter = makeAdapter(server, engine, makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    // mention-only group message: WeCom delivers whitespace/empty content
    // (bridge: "a group message with only an @-mention lands here")
    server.sendToCurrent(msgCallback('r-empty', groupText('G2', 'u3', '   ')));
    await until(() => respondFrames(server).some((f) => f.headers.req_id === 'r-empty'));
    const frame = respondFrames(server).find((f) => f.headers.req_id === 'r-empty');
    assert.equal(frame.body.markdown.content, '收到 @，但没有文字内容～在 @ 我之后补上想问的问题就行。');
    assert.equal(engine.messages.length, 0);
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('enter_chat → engine.onChannelEvent + default welcome when unhandled; other events pass through', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const adapter = makeAdapter(server, engine, makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    server.sendToCurrent({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-w1' },
      body: { event: { eventtype: 'enter_chat' } },
    });
    await until(() => engine.events.some((e) => e.type === 'enter_chat'));
    assert.equal(engine.events[0].reqId, 'ev-w1');
    await until(() => server.frames.some((f) => f.cmd === 'aibot_respond_welcome_msg'));
    const wf = server.frames.find((f) => f.cmd === 'aibot_respond_welcome_msg');
    assert.equal(wf.headers.req_id, 'ev-w1');
    assert.equal(wf.body.text.content, '您好，我是 小助手。直接发消息，我会在你的工作区里完成任务。');

    // engine handles it (returns true) → NO second welcome
    engine.onChannelEvent = (e) => {
      engine.events.push(e);
      return true;
    };
    server.sendToCurrent({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-w2' },
      body: { event: { eventtype: 'enter_chat' } },
    });
    await until(() => engine.events.some((e) => e.reqId === 'ev-w2'));
    await sleep(300);
    assert.ok(!server.frames.some((f) => f.cmd === 'aibot_respond_welcome_msg' && f.headers.req_id === 'ev-w2'));

    // non-enter_chat event → plain pass-through
    server.sendToCurrent({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-tc' },
      body: { event: { eventtype: 'template_card_event' } },
    });
    await until(() => engine.events.some((e) => e.type === 'template_card_event'));

    // welcome() primitive is respondWelcome underneath
    await adapter.welcome('ev-w3', '欢迎回来');
    await until(() => server.frames.some((f) => f.cmd === 'aibot_respond_welcome_msg' && f.headers.req_id === 'ev-w3'));
    const w3 = server.frames.find((f) => f.cmd === 'aibot_respond_welcome_msg' && f.headers.req_id === 'ev-w3');
    assert.equal(w3.body.text.content, '欢迎回来');
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('subscribe errcode 40001 → state stopped + 鉴权失败 lastError; no retry storm', async () => {
  const server = await startFakeWecom({ subscribeErrcode: 40001 });
  const adapter = makeAdapter(server, makeEngine(), makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'stopped');
    const st = adapter.status();
    assert.ok(st.lastError.includes('鉴权失败'), `lastError=${st.lastError}`);
    assert.ok(st.lastError.includes('40001'), `lastError=${st.lastError}`);
    // capped: at most 2 connection attempts inside a 4s window (a normal
    // 1s→1.7x backoff loop would already be at 3-4 here)
    await sleep(4000);
    assert.ok(server.connections <= 2, `connections=${server.connections}`);
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('disconnected_event → state stopped, kicked lastError, no reconnect for 5s', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const adapter = makeAdapter(server, engine, makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');
    server.sendToCurrent({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-kick' },
      body: { event: { eventtype: 'disconnected_event' } },
    });
    await until(() => adapter.status().state === 'stopped');
    assert.equal(adapter.status().lastError, 'kicked: 另一连接接管');
    // engine sees the disconnection as a channel event
    await until(() => engine.events.some((e) => e.type === 'disconnected'));
    const conns = server.connections;
    await sleep(5000);
    assert.equal(server.connections, conns, 'no new connections after kicked');
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('final frame lost on a dropped connection → replayed via push (aibot_send_msg) after reconnect; stop() discards the rest', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const log = makeLog();
  const adapter = makeAdapter(server, engine, log);
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    // inbound group message: reqId r-fin ↔ chatKey wecom:group:GF
    server.sendToCurrent(msgCallback('r-fin', groupText('GF', 'u1', '跑个任务')));
    await until(() => engine.messages.length === 1);

    await adapter.progress('r-fin', 'sid-fin', '第一段', false);
    await until(() => respondFrames(server).some((f) => f.body?.stream?.id === 'sid-fin'));

    // kill the connection; wait until the client KNOWS (state 'reconnecting')
    server.current().terminate();
    await until(() => adapter.status().state === 'reconnecting');

    // both final sends fail; the NEWER final for the chat wins the queue
    await adapter.progress('r-fin', 'sid-fin', '旧答案', true);
    await adapter.progress('r-fin', 'sid-fin', '最终答案', true);
    assert.ok(!respondFrames(server).some((f) => f.body?.stream?.finish === true), 'final not streamed on the dead connection');

    // client reconnects (1s backoff), goes online → the replay must arrive
    // as an aibot_send_msg push to the chat, NOT a respond_stream echo of
    // the stale req_id (cross-connection req_id is unproven; DESIGN §4)
    await until(() => adapter.status().state === 'online', 10000);
    await until(() => server.frames.some((f) => f.cmd === 'aibot_send_msg'), 5000);
    const pushes = server.frames.filter((f) => f.cmd === 'aibot_send_msg');
    assert.equal(pushes.length, 1, 'exactly one replay push (newest final per chatKey)');
    assert.equal(pushes[0].body.chatid, 'GF');
    assert.equal(pushes[0].body.chat_type, 2); // wecom:group:GF → chat_type 2
    assert.equal(pushes[0].body.markdown.content, '最终答案');
    assert.ok(!respondFrames(server).some((f) => f.body?.stream?.finish === true), 'no stale-req_id respond_stream replay');

    // stop() while another final is queued → discarded with one warn line
    server.current().terminate();
    await until(() => adapter.status().state === 'reconnecting');
    await adapter.progress('r-fin', 'sid-fin', '停机前丢的', true);
    const before = server.frames.filter((f) => f.cmd === 'aibot_send_msg').length;
    adapter.stop();
    assert.ok(log.warns.some((w) => /discard/i.test(w)), 'discard warn logged');
    await sleep(1500); // past the 1s reconnect backoff the queue would have waited for
    assert.equal(server.frames.filter((f) => f.cmd === 'aibot_send_msg').length, before, 'queued final discarded, never pushed');
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('empty-text final frame queued → dropped at reconnect flush (never retained, no push)', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const log = makeLog();
  const adapter = makeAdapter(server, engine, log);
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    // inbound group message: reqId r-ef ↔ chatKey wecom:group:EF
    server.sendToCurrent(msgCallback('r-ef', groupText('EF', 'u1', '空终帧任务')));
    await until(() => engine.messages.length === 1);

    // kill the connection, then let an EMPTY finish frame fail → it is queued
    server.current().terminate();
    await until(() => adapter.status().state === 'reconnecting');
    await adapter.progress('r-ef', 'sid-ef', '', true);

    // reconnect → flush: the empty entry must be DROPPED with a warn, never
    // pushed, and never "kept for next reconnect" (the retention bug: push()'s
    // empty guard resolves null, which the ack check would read as keep).
    await until(() => adapter.status().state === 'online', 10000);
    await until(() => log.warns.some((w) => /dropping empty queued final/.test(w)), 3000);
    await sleep(300);
    assert.ok(!server.frames.some((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'EF'),
      'empty queued final never pushed');
    assert.ok(!log.warns.some((w) => /kept for next reconnect/.test(w)),
      'empty entry not retained for the next reconnect');

    // and it stays dropped: a SECOND reconnect cycle attempts no replay
    server.current().terminate();
    await until(() => adapter.status().state === 'reconnecting');
    await until(() => adapter.status().state === 'online', 10000);
    await sleep(300);
    assert.equal(log.warns.filter((w) => /dropping empty queued final/.test(w)).length, 1,
      'drop happened exactly once (entry no longer in the queue)');
    assert.ok(!server.frames.some((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'EF'));
    // stop() has nothing left to discard for this chat — no discard warn
    adapter.stop();
    assert.ok(!log.warns.some((w) => /discarding/.test(w)));
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('push: 30 rapid pushes to one chat → at most 25 on the wire; 4000-char truncation', async () => {
  const server = await startFakeWecom();
  const log = makeLog();
  const adapter = makeAdapter(server, makeEngine(), log);
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    await Promise.all(Array.from({ length: 30 }, (_, i) => adapter.push('wecom:group:PG', `push ${i}`)));
    await until(() => server.frames.filter((f) => f.cmd === 'aibot_send_msg').length >= 25);
    await sleep(300);
    const sent = server.frames.filter((f) => f.cmd === 'aibot_send_msg');
    assert.equal(sent.length, 25, `sent=${sent.length}`);
    assert.equal(sent[0].body.chatid, 'PG');
    assert.equal(sent[0].body.chat_type, 2); // group
    assert.ok(log.warns.some((w) => /rate/i.test(w)), 'rate warn logged');

    // single push → chat_type 1; over-cap content truncated to 4000 + '…'
    await adapter.push('wecom:single:TX', 'x'.repeat(4500));
    await until(() => server.frames.some((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'TX'));
    const tx = server.frames.find((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'TX');
    assert.equal(tx.body.chat_type, 1);
    assert.equal(tx.body.markdown.content.length, 4000);
    assert.ok(tx.body.markdown.content.endsWith('…'));

    // empty / whitespace-only text → rejected with a warn, nothing on the
    // wire (predecessor /send semantics; fresh chatid so the rate limiter
    // is NOT what blocks it)
    const before = server.frames.filter((f) => f.cmd === 'aibot_send_msg').length;
    await adapter.push('wecom:single:EMPTY', '');
    await adapter.push('wecom:single:EMPTY', '   ');
    await sleep(200);
    assert.equal(server.frames.filter((f) => f.cmd === 'aibot_send_msg').length, before, 'empty push never sent');
    assert.ok(log.warns.some((w) => /empty/i.test(w)), 'empty-text warn logged');
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('inbound rate guard: 31 rapid callbacks same chatid → engine sees at most 30', async () => {
  const server = await startFakeWecom();
  const engine = makeEngine();
  const log = makeLog();
  const adapter = makeAdapter(server, engine, log);
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    for (let i = 0; i < 31; i++) {
      server.sendToCurrent(msgCallback(`r-rt-${i}`, groupText('RATE', 'u9', `第${i}条`)));
    }
    await sleep(500);
    assert.equal(engine.messages.length, 30, `onMessage called ${engine.messages.length} times`);
    assert.ok(log.warns.some((w) => /rate/i.test(w)), 'rate warn logged');
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('status() shape and capabilities constant', async () => {
  const server = await startFakeWecom();
  const adapter = makeAdapter(server, makeEngine(), makeLog());
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');
    server.sendToCurrent(msgCallback('r-st', groupText('ST', 'u1', '看看状态')));
    await until(() => adapter.status().callbacks >= 1);
    const st = adapter.status();
    assert.deepEqual(Object.keys(st).sort(), ['callbacks', 'lastCallbackAt', 'lastError', 'state']);
    assert.equal(st.state, 'online');
    assert.equal(st.lastError, null);
    assert.equal(st.callbacks, 1);
    assert.equal(typeof st.lastCallbackAt, 'number');
    assert.ok(st.lastCallbackAt > 0);

    assert.deepEqual(CAPABILITIES, {
      stream: true,
      push: true,
      group: true,
      welcome: true,
      maxContentChars: 3500,
      minIntervalMs: 2200,
      streamDeadlineMs: 600000,
    });
  } finally {
    adapter.stop();
    await server.close();
  }
});

test('plugin registration: manifest, accountSchema, and adapter via ctx.ws', async () => {
  const server = await startFakeWecom();
  const registered = {};
  const ctx = {
    ws: { WebSocket },
    registerChannel: (portId, impl) => {
      registered.portId = portId;
      registered.impl = impl;
    },
  };
  try {
    plugin.activate(ctx);
    assert.equal(registered.portId, 'wecom');
    assert.equal(plugin.manifest.id, 'channel-wecom');
    assert.equal(plugin.manifest.type, 'channel');
    assert.equal(plugin.manifest.requires.ports.channel, '^1');
    assert.deepEqual(registered.impl.capabilities, CAPABILITIES);

    const keys = registered.impl.accountSchema.map((s) => s.key);
    assert.deepEqual(keys, ['botId', 'secret', 'wsUrl']);
    const secret = registered.impl.accountSchema.find((s) => s.key === 'secret');
    assert.equal(secret.type, 'password');
    assert.equal(secret.required, true);
    const wsUrl = registered.impl.accountSchema.find((s) => s.key === 'wsUrl');
    assert.equal(wsUrl.default, 'wss://openws.work.weixin.qq.com');

    // the registered factory builds a working adapter through ctx.ws.WebSocket
    const adapter = registered.impl.createAdapter({
      account: { botId: 'B1', secret: 'S1', wsUrl: server.url },
      bot: { id: 'bot-1', name: '小助手' },
      log: makeLog(),
      engine: makeEngine(),
    });
    for (const k of ['start', 'stop', 'status', 'ack', 'progress', 'reply', 'welcome', 'push']) {
      assert.equal(typeof adapter[k], 'function', `${k} is a function`);
    }
    adapter.start();
    await until(() => adapter.status().state === 'online');
    adapter.stop();
  } finally {
    await server.close();
  }
});

// Client-level sanity: the factory is the documented constructor surface.
test('createWecomClient injects WebSocket and tracks initial state', () => {
  const client = createWecomClient({
    WebSocket,
    url: 'ws://127.0.0.1:1',
    botId: 'b',
    secret: 's',
    logger: makeLog(),
  });
  assert.equal(client.state, 'stopped'); // before start()
  assert.equal(client.lastError, null);
  assert.equal(client.connected, false);
});

// Regression (final review 2026-11-06): a streamed reply reuses ONE callback
// req_id for ALL its frames. With a single pending slot per req_id, each later
// frame's registration orphaned the previous frame's timer → a false
// "ack timeout" rejection (+ warn) per streamed turn. Each frame must own its
// ack slot; acks settle the OLDEST outstanding frame (send order).
test('per-frame ack slots: delayed stream acks (ack lands only after the NEXT frame) never reject or warn', async () => {
  const server = await startFakeWecom({ respondAck: 'delayed' });
  const engine = makeEngine();
  const log = makeLog();
  const adapter = makeAdapter(server, engine, log, { ackTimeoutMs: 300 });
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    server.sendToCurrent(msgCallback('r-ack', groupText('AK', 'u1', '流式任务')));
    await until(() => engine.messages.length === 1);

    // Fire the frames back-to-back WITHOUT awaiting: f2 registers while f1's
    // ack is still outstanding — under the old reqId-keyed map f2's
    // registration orphaned f1's slot and its timer rejected at +300ms here.
    const ps = [
      adapter.progress('r-ack', 'sid-ack', '一', false),
      adapter.progress('r-ack', 'sid-ack', '二', false),
      adapter.progress('r-ack', 'sid-ack', '三', false),
      adapter.progress('r-ack', 'sid-ack', '终', true),
    ];
    await until(() => respondFrames(server).length === 4);
    server.flushHeld(); // release the final frame's ack (held: no next frame)
    const rs = await Promise.all(ps);
    assert.ok(rs.every(Boolean), `every frame acked, got ${JSON.stringify(rs.map(Boolean))}`);

    // past the (shortened) ack timeout: nothing may reject late either
    await sleep(400);
    assert.ok(!log.warns.some((w) => /ack timeout|send failed/.test(w)), `warns=${JSON.stringify(log.warns)}`);
  } finally {
    adapter.stop();
    await server.close();
  }
});

// Log semantics for the timeout that CAN still happen (server never acks):
// non-final stream refreshes are best-effort → debug only, no warn; the
// final frame keeps warn + the pendingFinal push-replay safety net.
test('ack-timeout log levels: non-final frame → debug only; final frame → warn + queued for push replay', async () => {
  const server = await startFakeWecom({ respondAck: 'never' });
  const engine = makeEngine();
  const log = makeLog();
  const adapter = makeAdapter(server, engine, log, { ackTimeoutMs: 250 });
  try {
    adapter.start();
    await until(() => adapter.status().state === 'online');

    server.sendToCurrent(msgCallback('r-to', groupText('TO', 'u1', '超时任务')));
    await until(() => engine.messages.length === 1);

    // non-final frame times out → resolved null, debug line, NO warn
    const r = await adapter.progress('r-to', 'sid-to', '处理中', false);
    assert.equal(r, null, 'send() swallows the timeout');
    assert.ok(log.debugs.some((d) => /non-final frame ack timeout/.test(d)), `debugs=${JSON.stringify(log.debugs)}`);
    assert.ok(!log.warns.some((w) => /ack timeout|send failed/.test(w)), `no warn for non-final timeout: ${JSON.stringify(log.warns)}`);

    // final frame times out → warn + text queued for push replay
    const rf = await adapter.progress('r-to', 'sid-to', '最终答案', true);
    assert.equal(rf, null);
    assert.ok(log.warns.some((w) => /send failed: ack timeout/.test(w)), `final timeout warned: ${JSON.stringify(log.warns)}`);

    // reconnect → the queued final flushes as a push to the chat
    server.current().terminate();
    await until(() => adapter.status().state === 'online', 10000);
    await until(() => server.frames.some((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'TO'), 5000);
    const push = server.frames.find((f) => f.cmd === 'aibot_send_msg' && f.body.chatid === 'TO');
    assert.equal(push.body.markdown.content, '最终答案');
  } finally {
    adapter.stop();
    await server.close();
  }
});
