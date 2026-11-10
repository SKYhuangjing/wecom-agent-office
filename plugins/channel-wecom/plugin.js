// channel-wecom plugin (Task 17): the production-proven WeCom protocol
// client (ported from wecom-bridge, see ./client.js for the diff list) behind
// the channel port contract — five outbound primitives, capabilities for the
// engine, and an accountSchema for bots.json. docs/PLUGIN-DEV.md §5.2.
// 媒体仓库（DESIGN-MULTIMODAL §4.2）：data/media 下按 bot 分目录存企微回传
// 的图片/文件（下载+解密见 ./media.js），启动时清一遍 7 天前旧件。
import { join } from 'node:path';
import process from 'node:process';
import { createAdapter, CAPABILITIES } from './adapter.js';
import { createMediaStore } from './media.js';

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
    // 与 core-engine 同源的 dataDir 约定（services.paths → config → WAO_HOME
    // → cwd/data），媒体文件跟着 bot 数据走。bare-lifecycle 测试的 ctx 没有
    // services/log（可选链防御，core-engine 同款）。
    const dataDir = ctx.services?.get?.('paths')?.dataDir
      ?? ctx.config?.dataDir
      ?? process.env.WAO_HOME
      ?? join(process.cwd(), 'data');
    const mediaStore = createMediaStore({ root: join(dataDir, 'media'), log: ctx.log ?? null });
    try {
      const swept = mediaStore.sweepAll();
      if (swept > 0) ctx.log?.info?.(`channel-wecom: media sweep removed ${swept} file(s) older than 7 days`);
    } catch (err) {
      ctx.log?.warn?.(`channel-wecom: media startup sweep failed: ${err?.message ?? err}`);
    }

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
      // zero-dependency (spec §2.1). mediaStore 落在本插件的 data 域。
      createAdapter: ({ account, bot, log, engine }) =>
        createAdapter({ account, bot, log, engine, WebSocket: ctx.ws.WebSocket, mediaStore }),
    });
  },
};
