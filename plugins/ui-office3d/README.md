# ui-office3d

办公室 3D 页面插件（M3 T4）：机器人作为工人在等距投影办公室里生活——
working 坐工位敲键盘、idle 在沙发/书架/咖啡角/乒乓台之间闲逛、offline 灰暗地窝在角落打盹。
引擎（投影/明暗/BFS 寻路/相机/名牌锚点/昼夜时钟）移植自前身 wecom-bots client.js 的 OfScene
（机制继承，见 `ui/ofscene.js` 头注释的移植清单），视觉层全部重做（`ui/office.js`）。
内核托管在 `/api/ui/ui-office3d/`，无构建 ES Module、禁 JSX、SDK 从 `window.WAO`。

## 视觉设计

克制配色的分层光影：房间表面（木地板/地毯/墙面护墙板线）按 UI 深浅色各一套低饱和色板，
昼夜只通过四个轻量通道表达——天空渐变+星子+日月、窗玻璃色温、全场景环境色调、夜间台灯暖光池，
不做重绘级光照。工位是视觉焦点：每桌一盏显示器 = 该 bot 的 timeline 最近事件滚动条
（kind 分色光标点，working 点亮、idle 显示 provider 徽标呼吸待机、offline 黑屏），
桌角立 provider 徽牌（dsh 靛蓝闪电 / claude 珊瑚橘星芒 / codex 青绿括号，
矢量绘制任意缩放不糊），工人衬衫同色系；头顶任务卡 = `progress.line` 语义进度行
+ 运行时长徽标，随呼吸浮动；DOM 名牌（状态点脉冲 + provider 色块）通过引擎
`onFrame(anchors)` 逐帧锚定头顶。家具重绘：双人/五人沙发带靠枕、书架+巡架猫、
咖啡角带蒸汽、乒乓台（球会动）、绿植（会摆）、白板（趋势线+柱状图）、挂钟（真实时间）、
西墙门+EXIT 牌（新工人从门进来）。>8 个 working bot 时多出的在门口排队站定并提示徽标。

昼夜为慢速循环（默认 240 秒一整天，起点取本地时刻）；`?phase=` 可锁定，
`?dim=2d` 切平面投影。拖拽平移、滚轮缩放、按 0 复位、点击小人弹出详情卡。

## 数据面

`useAgents()`（SSE + 5s 轮询）驱动工人状态/名牌/任务卡；`useTimeline(null, 30)`
按 botId 取最近事件驱动屏幕滚动条。纯机制函数（投影/寻路/相位）有单测
`test/ui/ofscene.test.js`（node --test）。

## 截图验证（改 UI 红线）

```sh
node src/index.js start   # 或 wao start；内核同源托管 harness
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE=http://127.0.0.1:8792/api/ui/ui-office3d/harness.html
for mode in light dark; do
  flag="--force-light-mode"; [ "$mode" = dark ] && flag="--force-dark-mode"
  for ph in day night; do
    "$CHROME" --headless=new --disable-gpu $flag --window-size=1280,800 \
      --screenshot="office-$mode-$ph.png" "$BASE?phase=$ph"
    "$CHROME" --headless=new --disable-gpu $flag --window-size=1280,800 \
      --screenshot="office-$mode-$ph-2d.png" "$BASE?phase=$ph&dim=2d"
  done
done
```

假数据在 `ui/fake-data.js`（dsh working 带 🔧 进度 + 事件流 / claude idle /
codex offline 带原因）。要截空办公室，把 `FAKE.agents` 改成 `[]`。
