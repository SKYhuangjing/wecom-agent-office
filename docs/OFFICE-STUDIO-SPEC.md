# 办公室 · 白棚工位规格（资产 + 交互）

> 状态：**方向已定**（2026-11-06）｜选型板 design-demos/ 已随选型结束移除（2026-11-07）  
> 产品锚点：一家你独自经营的公司；企微消息=工单，bot=员工，Web 办公室=现场。  
> 本文只定 **办公室页的视觉资产与交互契约**；控制台六页皮肤另案，但须与本文色板/状态词对齐。  
> 权威技术架构仍以 [DESIGN.md](DESIGN.md) 为准；本文是 UI 重做的执行规格。

---

## 0. 裁定（读完即可动手）

| # | 裁定 |
|---|---|
| 1 | **放弃**现行「开间派对房 + 软插画小人」作为英雄视觉（`ui-office3d` 现实现保留至替换日，不继续打磨家具密度） |
| 2 | **采用**「纯白展台 + 统一工位单元网格 + 成片/循环片 + 透明热区」 |
| 3 | **生产素材必须自有**：选型可参考 Marvis 公开成片；**禁止**把第三方成片/角色进仓库、进发布物、进截图基线 |
| 4 | 数据仍只吃现有 `/api/agents` + timeline SSE；热区不新开业务 API（P1 可加只读「屏内摘要」字段，非阻塞） |
| 5 | 公司话主层 / 技术词详情层纪律不变（见 README §4.2） |

**非目标（本规格）**：Gather 行走地图、真实 3D 相机漫游、多楼层、手机端办公室、自定义装修。

---

## 1. 一句话与分层

```
成片层（视频/PAG/序列帧）  ←  美术资产，按状态切镜或着色
        ↑ 叠
热区层（DOM，百分比定位）  ←  交互与无障碍，绑定 botId
        ↑ 驱动
数据层（useAgents + timeline）←  已有 SDK，不改契约则不改引擎
```

- **成片层**：负责「好看」——家具、剪影、阴影、屏内假 UI 光效。  
- **热区层**：负责「能点」——hover/focus/click、tooltip、选中态、键盘。  
- **数据层**：负责「真」——谁在岗、在修什么、为何休假。

选型板 Demo D 已验证分层；生产替换成片来源即可。

---

## 2. 视觉系统

### 2.1 舞台（Stage）

| Token | 值 / 规则 |
|---|---|
| 背景 | `#FFFFFF` 为主；允许极弱径向灰（`#EEF1F5` @ 底部 ≤8% 透明度）模拟棚地，**禁止**墙/地板纹理/窗外风景 |
| 容器 | 大圆角卡片或通栏；阴影用单层大软影（参考 Demo D），不叠多色 glow |
| 比例 | 成片默认 **≈ 2.88:1**（3840×1330 类宽幅）或 **16:9**；热区坐标一律用 **百分比**，禁止写死 px |
| 昼夜 | **首期不做**舞台昼夜切换（避免与白棚冲突）；壳层 light/dark 只影响舞台外 chrome |
| 品牌 | 舞台内不放 Logo；页头/壳负责 WAO 品牌 |

### 2.2 工位单元（Desk Unit）——最小可复用资产

每个工位是**同一套家具**的实例，禁止每人一张不同桌子。

**必含部件（一次建模，全员复用）：**

1. 哑光白桌面 + 前缘薄侧面（软 AO）  
2. 白转椅（只露椅背 + 底座，角色挡住座面）  
3. 右侧矮柜（三抽屉即可）  
4. 超薄黑框显示器 + 底座  
5. 接触阴影（椭圆软影，贴地）  
6. （可选）键盘一条，弱化即可  

**禁止部件：** 乒乓台、书架巡游点、咖啡蒸汽、多沙发区、门廊排队——这些是旧办公室叙事，新规格不收录。

### 2.3 角色（Agent Silhouette）

| 规则 | 说明 |
|---|---|
| 形体 | **实心黑剪影**（`#0A0A0A`），统一吉祥物头型（建议牛/犀短角，与「办公室员工」可读；定稿后锁一套 mesh） |
| 视角 | 背对镜头、面向显示器（与选型一致） |
| 唯一彩色 | **领巾/领色条** = provider 身份色（见 §2.4）；身体其余禁止第二色 |
| 禁止 | 写实皮肤、复杂服装、每 bot 不同发型（旧 ofscene 肤色哈希方案废止） |
| 空位 | 无剪影；椅空置；屏显示「+」或浅灰空态（入职 CTA） |

### 2.4 Provider 领色（唯一 accent 族）

与 shell token 对齐（可微调明度，色相锁定）：

| provider | Token | Hex（生产） | 领色用途 |
|---|---|---|---|
| `dsh` | `--pv-dsh` | `#3B82F6` | 领巾、热区 focus 环可借 16% 透明 |
| `claude` | `--pv-claude` | `#E8794B` | 同上 |
| `codex` | `--pv-codex` | `#14B8A6` | 同上 |
| 未知 / 未分配 | `--pv-unknown` | `#94A3B8` | 空位描边、休眠领 |

**未知 provider**：领色用 unknown；tooltip 详情层可写技术 id。

### 2.5 状态外观（成片侧）

映射现有三态（`/api/agents`：`working` \| `idle` \| `offline`）+ 展示层合成：

| 数据 status | 公司话 | 成片表现 | 屏内 |
|---|---|---|---|
| `working` | 工作中 | 坐姿端正；可有轻微敲击循环（2–3 帧） | **亮**：侧栏+内容块；优先像真 UI |
| `idle` | 待命 | 坐姿放松或微幅呼吸；领色仍显 | **浅灰待机**或 provider 小徽标呼吸 |
| `offline` | 休假 | 剪影降饱和/透明度 0.45–0.55 **或** 趴桌 + `zZZ`（二选一，全站统一；**推荐趴桌+zZZ**，选型已验证可读） | **黑屏**或深红错误条（若有 `reason`） |
| （无 bot） | 空工位 | 无剪影 | 浅底 +「+」 |

`reason` 不直接画进成片文字（成片里尽量无中文）；**只进热区 tooltip / 侧栏详情**。

### 2.6 网格与容量

| 项 | 规则 |
|---|---|
| 默认布局 | **2 行 × 3 列 = 6 席**（与选型板一致） |
| bot ≤ 6 | 按 `createdAt` 升序（无则 id）填席；余席 = 空工位 |
| bot > 6 | **第 6 席变为「+N」聚合席**（剪影叠层或数字徽）；点击打开花名册抽屉，不扩展成 3×4（避免成片重渲） |
| 排序稳定 | 同一 bots 集合下席位下标稳定，避免 SSE 抖动换座 |

席位坐标（热区百分比）首期可固定为选型板同款，成片更换后由美术给一张 **热点标定图** 再改表：

```
行1: (28.4, 8), (46.8, 8), (65.0, 8)     // left%, top% ；w≈6 h≈24
行2: (28.4, 48), (46.8, 48), (65.0, 48)
```

---

## 3. 资产管线（生产）

### 3.1 交付物清单（Definition of Done · 美术）

| 交付物 | 格式 | 说明 |
|---|---|---|
| 工位主网格成片 | `office-loop.(mp4\|webm)` 或 PAG | 含 6 席家具；循环 ≤8s；无水印；透明或白底 |
| 状态变体 | 同容器多轨道 **或** 单片 + 运行时领色/屏材质替换 | 至少覆盖 working / idle / offline(sleep) / empty |
| 角色绑定姿态 | FBX/GLTF 或序列帧 | sit-work / sit-idle / sleep / （空） |
| 热点标定 | `hotspots.json` | 见 §4.1 |
| 屏内 UI 贴图套 | 2048 内 PNG 或成片内嵌 | work / idle / error / dark / empty 五态 |
| 静帧海报 | `office-poster.webp` | 首帧/中间好看帧，作 `poster` 与 OG/README |
| 许可声明 | `assets/OFFICE-LICENSE.md` | 确认自有或可商用，无第三方成片 |

### 3.2 推荐制作路径（不绑定工具）

```
Blender 或 Spline
  → 统一工位 + 黑剪影角色 + 领色材质槽
  → 渲染：白棚、软阴影、固定相机
  → 导出：
       A. 循环视频（H.264 + VP9/WebM）+ 海报
       B. 或 PAG / Lottie（若要运行时换领色更轻）
  → 标注 6 个热点矩形 → hotspots.json
```

**运行时换领色两种级别：**

- **L1（首期）**：成片内预烘焙 3 套领色工位，按 provider 切可见层 / 切精灵图。  
- **L2**：PAG 动态色或 WebGL 遮罩；工作量更大，等 L1 验证后再上。

### 3.3 工程落位（已落地）

```
plugins/ui-office-studio/          # 白棚页（本规格）
  ui/
    studio.js                      # 成片 + 热区 + useAgents
    seats.js                       # 席位百分比标定
    assets/                        # 可选自有循环片（禁止第三方入仓）
      office-loop.mp4              # 可选覆盖
      office-poster.jpg
plugins/ui-office3d/               # Magpie 2D/ISO/3D 活办公室（对照实现）
  ui/office.js + ui/vendor/
```

两页并存于导航：「办公室」(Magpie) / 「工位棚」(本规格)。成片默认为自有 SVG；放入 `assets/office-loop.mp4` 即切真片。

### 3.4 性能预算

| 项 | 预算 |
|---|---|
| 循环视频 | ≤ 4MB（webm 优先）；长度 ≤ 8s |
| 同时解码 | 1 路；页面隐藏时 `video.pause()` |
| 热区 DOM | ≤ 8 个 button（6 席 + 预留） |
| 首屏 | poster 先出，`canplay` 后淡入视频 |

---

## 4. 交互规格

### 4.1 `hotspots.json` 契约

```json
{
  "version": 1,
  "aspect": { "w": 3840, "h": 1330 },
  "slots": [
    { "id": "s0", "left": 28.4, "top": 8, "width": 6, "height": 24 },
    { "id": "s1", "left": 46.8, "top": 8, "width": 6, "height": 24 },
    { "id": "s2", "left": 65.0, "top": 8, "width": 6, "height": 24 },
    { "id": "s3", "left": 28.4, "top": 48, "width": 6, "height": 24 },
    { "id": "s4", "left": 46.8, "top": 48, "width": 6, "height": 24 },
    { "id": "s5", "left": 65.0, "top": 48, "width": 6, "height": 24 }
  ]
}
```

单位：相对舞台容器的 **CSS %**。换镜头只改此文件 + 成片，不改逻辑。

### 4.2 席位 ↔ bot 绑定

```
slotsSorted = hotspots.slots
botsSorted  = agents sorted by (createdAt ?? 0), id
for i in 0..min(5, botsSorted.length-1):
  slot[i].botId = botsSorted[i].id
if botsSorted.length > 6:
  slot[5] = { type: 'overflow', count: botsSorted.length - 5, botIds: botsSorted.slice(5).map(id) }
else:
  for empty slots: type = 'vacant'
```

### 4.3 指针与键盘

| 动作 | 行为 |
|---|---|
| hover / focus | 该席 tooltip 显示；其余席 `is-dim`（opacity≈0.55） |
| click / Enter | 选中席；打开 **右侧或底部详情抽屉**（员工卡摘要：状态、reason、今日工单、入口链到人事部/岗前测试） |
| click 空位 | 跳转人事部「办理入职」或打开入职向导（与 workbench 同一路由） |
| click 溢出席 | 打开花名册列表（全体 bot），点行再聚焦对应逻辑（溢出无成片位） |
| Esc | 取消选中 / 关抽屉 |
| Tab | 热区按 s0…s5 顺序可聚焦；`aria-label` = 公司话名 + 状态 |

热区本身 **无可见铬**（无常驻边框）；hover 可用极淡 provider 色径向高光（≤16% alpha）。

### 4.4 Tooltip 文案（公司话主层）

| 席态 | 主行 | 副行（mono，可技术） |
|---|---|---|
| working | `progress.line` 截断至 ≤24 字；空则「工作中」 | `{provider} · {elapsed}` 或 botId |
| idle | 「待命 · 无进行中工单」 | `{provider} · idle` |
| offline | 「休假」；若有 reason 主行改为短因（≤24 字） | `offline`；完整 reason 进抽屉 |
| vacant | 「办理入职 →」 | `empty desk` |
| overflow | 「另有 N 位同事」 | `+N` |

禁止在 tooltip 展示 secret / 原始 JSON。

### 4.5 详情抽屉（click 后）

最小字段（均已有或可从 agents 拼）：

- 头像：剪影 + 领色（CSS 即可，不等新资产）  
- 名称、岗位（provider 公司话）、状态徽标  
- `progress.line` + 起始时间  
- `reason`（offline 时）  
- 今日工单 / 服务同事（agents 已有聚合字段则用）  
- 操作：员工档案、岗前测试、办理离职（链到既有路由，本页不重做表单）

### 4.6 与旧交互的差异（迁移注意）

| 旧 ui-office3d | 新 studio |
|---|---|
| 拖拽平移 / 滚轮缩放 / 按 0 复位 | **删除**（成片固定机位） |
| BFS 闲逛沙发书架 | **删除** |
| 点小人看汇报 | **保留语义** → 点热区 |
| 昼夜相位 | **首期删除** |
| iso / 2d 切换 | **删除**（或遗留进 legacy 开关） |

截图基线：`test/ui-shot.sh` 在 studio 上线后重录一组 `ui-office-studio-*.png`，旧 iso 基线可归档。

---

## 5. 数据契约（只读消费）

不改引擎前提下，舞台消费：

```ts
// 已有 useAgents() 元素（示意）
type Agent = {
  id: string
  name: string
  provider: 'dsh' | 'claude' | 'codex' | string
  status: 'working' | 'idle' | 'offline'
  reason?: string | null
  progress?: { line?: string, startedAt?: number } | null
  todayTurns?: number
  // createdAt?: number  // 工牌已有；排序用，缺省则退回 id
}
```

屏内「更真」的增强（**P2，非阻塞**）：

- `GET` 已有 timeline 按 bot 取最近 1 条 kind，映射到屏内贴图变体（tool / message / error）  
- 不为此新增写 API  

SSE：`agent/status` 变更 → 席位状态类名 / 可见层切换；节流 UI 更新 ≥ 100ms，避免每帧切视频轨。

---

## 6. 无障碍与降级

| 场景 | 行为 |
|---|---|
| `prefers-reduced-motion` | 停视频，只显示海报静帧；热区仍可用 |
| 视频加载失败 | 海报 + 热区；不空白崩页 |
| 无 agents | 6 席全 vacant；主 CTA「办理入职」 |
| 读屏 | 每个热区 `aria-label`；抽屉 `role="dialog"` |

---

## 7. README / GitHub 门面（连带）

办公室静帧或 3–6s GIF/WebM 作为 README 首图：

- 至少 1 席 working 亮屏  
- 至少 1 席 sleep 或 offline  
- 勿用空态六白桌  

截图脚本通过后，替换 README 英雄图；选型用的 Marvis 成片 **不得** 出现在 README。

---

## 8. 验收清单

**美术**

- [ ] 自有成片/PAG + LICENSE  
- [ ] 四态可辨（working/idle/offline/empty），3 米外仍能分清领色  
- [ ] `hotspots.json` 与成片对齐（人工点检 6 席）  
- [ ] 体积 ≤ 性能预算  

**工程**

- [ ] studio 舞台 + 热区 + tooltip + 抽屉  
- [ ] 绑定算法单测（排序、溢出、空位）  
- [ ] reduced-motion / 视频失败降级  
- [ ] `ui-shot` 新基线 ≥5KB 门禁通过  
- [ ] 特性开关可回退 legacy  

**产品文案**

- [ ] tooltip/抽屉公司话抽检  
- [ ] 与人事部入职/离职入口打通  

---

## 9. 里程碑建议

| 步 | 产出 | 依赖 |
|---|---|---|
| M0 | 本文评审通过 | — |
| M1 | 热点壳落地（可用海报假成片 + 真 agents） | 工程 |
| M2 | 自有 L1 成片替换海报 | 美术 |
| M3 | 抽屉 + 入职空位 CTA + 截图基线 + README 门面 | 工程 |
| M4 | （可选）PAG 动态领色 / 屏内 timeline 贴图 | 美术+工程 |

---

## 10. 对照方案 E（Magpie Three.js）

选型板 `design-demos/e-magpie-three/`（vendored MIT：`scene3d.js` + three r169）已随选型结束移除；vendored 库现居 `plugins/ui-office3d/ui/vendor/`。

| | **D 白棚 studio（主方向）** | **E Magpie Three.js** |
|---|---|---|
| 画面 | 预渲染成片 / PAG | 运行时程序化 WebGL |
| 交互 | 固定机位 + 热区 | 拖拽旋转 / 缩放 / 寻路占座 |
| 观感 | GitHub 门面、产品摄影 | 「活办公室」、玩具沙盘 |
| 成本 | 美术资产管线 | 工程维护 scene + 性能 |
| 许可 | 必须自有成片 | Magpie MIT 可参考实现，品牌资产仍须自研 |

**裁定不变**：主交付仍按本文 D；E 仅作对照与技术储备。若未来要「经典活办公室」模式，可另开 `legacy/magpie-like` 开关，不替代 studio 英雄视觉。

---

## 11. 开放问题（需拍板再画）

1. 吉祥物头型最终锁哪个？（牛角 / 犀角 / 其他——全站唯一）  
2. offline 用「趴桌 zZZ」还是「灰剪影直立」？（规格推荐前者）  
3. 控制台壳跟舞台：暗色指挥台 vs 极简白——是否与工作室 同发？  
4. 旧 iso 办公室：保留为「经典视图」还是 M3 后删除？

---

**变更记录**

| 日期 | 说明 |
|---|---|
| 2026-11-06 | 初稿：白棚工位方向落地为资产+交互规格；对齐 Demo D 与 `/api/agents` 三态 |
