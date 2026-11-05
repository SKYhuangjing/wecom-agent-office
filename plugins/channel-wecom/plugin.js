// channel-wecom plugin (Task 17): the production-proven WeCom protocol
// client (ported from wecom-bridge, see ./client.js for the diff list) behind
// the channel port contract — five outbound primitives, capabilities for the
// engine, and an accountSchema for bots.json. docs/PLUGIN-DEV.md §5.2.
import { createAdapter, CAPABILITIES } from './adapter.js';

const PORT_ID = 'wecom';

export default {
  manifest: {
    id: 'channel-wecom',
    name: '企业微信智能机器人',
    type: 'channel',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { channel: '^1' } },
  },

  activate(ctx) {
    ctx.registerChannel(PORT_ID, {
      // Shape of the account block a bot carries in bots.json for this channel.
      accountSchema: [
        { key: 'botId', label: '机器人 ID', type: 'string', required: true },
        { key: 'secret', label: '机器人 Secret', type: 'password', required: true },
        { key: 'wsUrl', label: 'WebSocket 地址（默认官方，测试可指本地）', type: 'string', default: 'wss://openws.work.weixin.qq.com' },
      ],

      // Engine reads these to decide streaming/throttling/truncation/deadline.
      capabilities: CAPABILITIES,

      // The port contract factory is ({account, bot, log, engine}); the
      // kernel's WebSocket re-export is injected here so the plugin stays
      // zero-dependency (spec §2.1).
      createAdapter: ({ account, bot, log, engine }) =>
        createAdapter({ account, bot, log, engine, WebSocket: ctx.ws.WebSocket }),
    });
  },
};
