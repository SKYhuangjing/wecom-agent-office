// Page aggregation entry (kernel hosts this at /api/ui/ui-workbench/index.js;
// the shell dynamic-imports it). The shell auto-registers ONLY this module's
// default export under the plugin entry, so sibling pages register through
// the shared WAO collector at import time — window.WAO is contractually
// mounted before any page import (shell and harness both honor it), and the
// optional chaining keeps a bare Node import (loader manifest discovery)
// side-effect free.
//
// v2 导航收敛：九页收敛为三页——总览（overview，落地页：办公室 3D + 状态卡片
// + 最近活动）/ 机器人（robots，列表 + 详情 tabs：会话/日志/工具/设置 + 推送
// dialog）/ 设置（settings，工具库 + 插件 + 系统信息）。旧七页移入 _legacy/
// 供新页复用组件，不再独立注册。
import overview, { aiAside } from './overview.js';
import robots from './robots.js';
import settings from './settings.js';

const PAGES = [overview, robots, settings];

for (const page of PAGES) globalThis.WAO?.registerPage?.(page);

// 侧栏 aside（AI 接入小卡）：shell 提供 registerAside 挂载点，卡片组件随本
// 插件启停——总览主内容区不再放大卡（用户反馈占位太大）。
globalThis.WAO?.registerAside?.(aiAside);

// Default = the first page (landing): the shell's own registerPage({...mod.default, id})
// lands on the same registry key ('overview'), so no duplicate nav entry.
export default overview;
