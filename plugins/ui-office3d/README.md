# ui-office3d

办公室页面插件：基于 [Magpie AgentOffice](https://github.com/QingJ01/magpie-agent-office)（MIT）的 **2D / ISO / 3D** 三视角，接 live `useAgents()`。

内核托管 `/api/ui/ui-office3d/`；无构建 ES Module、禁 JSX；SDK 自 `window.WAO`。  
Vendored：`ui/vendor/{three.min.js,scene.js,scene3d.js}`（见 `NOTICE.md`）。  
旧 ofscene 软插画实现在 `ui/legacy/`（`test/ui/ofscene.test.js` 仍锁其数学）。

## 视角与查询参数

| 参数 | 含义 |
|---|---|
| `?dim=2d\|iso\|3d` | 俯视 / 等距画布 / WebGL（默认 **iso**） |
| `?scene=office\|station\|…` | 3D 主题（`setScene`，勿 dispose 同 canvas） |
| `?quality=low\|medium\|high` | 3D 画质 |
| `?state=empty\|error` | harness 边界基线 |

状态映射：`working→executing` · `idle→done` · `offline→error`；`seed` 由 botId 稳定哈希。

## 截图

```sh
node src/index.js start
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE=http://127.0.0.1:8792/api/ui/ui-office3d/harness.html
"$CHROME" --headless=new --disable-gpu --window-size=1280,800 \
  --screenshot=office-iso.png "$BASE"
"$CHROME" --headless=new --disable-gpu --window-size=1280,800 \
  --screenshot=office-2d.png "$BASE?dim=2d"
"$CHROME" --headless=new --disable-gpu --window-size=1280,800 \
  --screenshot=office-3d.png "$BASE?dim=3d&scene=office"
```

白棚成片+热区方向见姊妹插件 **`ui-office-studio`** 与 [OFFICE-STUDIO-SPEC.md](../../docs/OFFICE-STUDIO-SPEC.md)。
