// Channel plugin template (Task 8): a loadable no-op demo of the channel
// port — copy this dir, rename id/port, and wire createAdapter to a real IM.
// The capabilities block is the contract the engine reads for pacing (never
// hardcode IM cadence in the engine); the five outbound primitives below are
// deliberately empty so the shape is visible without any network behavior.
// docs/PLUGIN-DEV.md is the full reference.
const PORT_ID = 'template';

export default {
  manifest: {
    id: 'template-channel',
    name: 'Template Channel',
    type: 'channel',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { channel: '^1' } },
  },

  activate(ctx) {
    ctx.registerChannel(PORT_ID, {
      // Shape of the account block a bot carries in bots.json for this channel.
      accountSchema: [
        { key: 'endpoint', label: 'Endpoint', type: 'string', required: true },
      ],

      // Engine reads these to decide streaming/throttling/truncation/deadline.
      capabilities: {
        stream: true,          // ack/progress streaming supported
        push: false,           // no proactive push
        group: false,          // no group chats
        welcome: false,        // no enter_chat welcome message
        maxContentChars: 3500, // truncate final text beyond this
        minIntervalMs: 2200,   // min gap between two outbound frames
        streamDeadlineMs: 600000, // abort the stream after this long
      },

      // A demo adapter: online immediately, counts nothing, sends nothing.
      // A real one connects (via ctx.ws.WebSocket — zero npm deps), feeds
      // engine.onMessage / engine.onChannelEvent for inbound, and implements
      // the five outbound primitives below against the IM API.
      createAdapter({ account, bot, log, engine }) {
        void account; void bot; void log; void engine; // demo-only: keep the real signature visible
        return {
          start() {},
          stop() {},
          status() {
            return { state: 'online', lastError: null, callbacks: 0, lastCallbackAt: 0 };
          },
          // --- outbound primitives ---
          ack(reqId, streamId, text) { void reqId; void streamId; void text; },
          progress(reqId, streamId, text, finish) { void reqId; void streamId; void text; void finish; },
          reply(reqId, text) { void reqId; void text; },
          welcome(reqId, text) { void reqId; void text; },
          push(chatRef, text) { void chatRef; void text; },
        };
      },
    });
  },
};
