# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

公司比喻重设计 P4（company-metaphor）：ofscene 引擎零改动，画布层全换。

### Added

- 软插画 2.5D：渐变地板（相位 lerp）+ 圆角地毯、rQuad 圆角家具 + 单层柔影，无像素格无硬方块。
- 小人＝头像脸（DiceBear 位图，同 botId 同脸）+ provider 色胶囊身 + 简腿：working 打字微动+脉动点 / idle 呼吸（踱步照旧）/ 休假 grayscale+Zz。
- 离职走出门口淡出（子类 setAgents 差集 + step() 走门渐隐）；入职走门沿用引擎原生机制；?zoom= 相机参数（截图确定性）。
- 名牌/详情弹层带化身与公司话（工作中/待命/休假、今日工单/服务同事/档案）。

### Changed

- 昼夜改为四档暖色温 lerp（dawn/day/dusk/night 的天空/地板/灯光）；办公室空态改邀请式公司话。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- 3D 办公室 v2：自 wecom-bots 移植的场景引擎 + 视觉重做，接 live 数据（队列/运行态实时映射）。
- ISO/2D 视角与 harness 截图基线（21 基线图，控制者复验达标）。

### Fixed

- 沙发坐垫几何与 BFS 断言修正；沙发单元坐标接线（消除死 bx/by）与队列提示澄清。
