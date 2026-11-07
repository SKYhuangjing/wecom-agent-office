# 备份 / 恢复 / 版本回滚（wao 运维手册）

面向维护者的三件事：数据怎么备份、坏了怎么恢复、升级翻车怎么回滚。
前置事实：**全部业务状态都在 data/ 目录**（bots.json=bot 名册+凭证、assets.json=资产注册表、
ledger/=逐轮对话台账、sessions/=会话续接缓存、plugins.json=插件启用表）；代码仓库本身无状态，
回滚代码不动数据。

## 1. 备份

**推荐（一致性最稳）：停服冷备**

```sh
# launchd 部署（四阶段停机，在跑任务补终帧后再停）：
launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist
cp -R <DATA_DIR> <BACKUP_DIR>/data-$(date +%Y%m%d-%H%M%S)
launchctl load ~/Library/LaunchAgents/com.wecom-agent-office.plist
curl -s localhost:8792/healthz    # 确认回来
```

**可接受（不想停服）：运行中热备关键文件**

- `bots.json` / `assets.json`：写入走 tmp + rename 原子替换，任意时刻 `cp` 拿到的要么是旧全文要么是新全文，不会撕裂。
- `ledger/*.jsonl`：追加型（append-only），运行中 `cp` 安全（最多缺尾部最后一两行）。
- `sessions/` 与 `logs/` 可不备（缓存/日志，丢了只影响续接与排障历史）。

```sh
cp <DATA_DIR>/bots.json <DATA_DIR>/assets.json <BACKUP_DIR>/
cp -R <DATA_DIR>/ledger <BACKUP_DIR>/ledger
```

**密钥与权限（必读）**：`bots.json` 含企微 `secret`、provider 凭证；`assets.json` 的
mcp/env 类资产可能含环境变量值。data/ 本体是 0700、文件 0600——备份目录要同级对待：

```sh
chmod -R go-rwx <BACKUP_DIR>     # 备份副本同样只许属主读写
```

不要把备份放进会被同步/上传的目录（网盘、git 仓库）。

## 2. 恢复

```sh
# 1) 停服（同备份第一节）
# 2) 用备份覆盖数据目录（先挪走当前残卷，别直接混叠）
mv <DATA_DIR> <DATA_DIR>.broken-$(date +%s)
cp -R <BACKUP_DIR>/data-<stamp> <DATA_DIR>
chmod -R go-rwx <DATA_DIR>
# 3) 重启并验证
launchctl load ~/Library/LaunchAgents/com.wecom-agent-office.plist
node src/index.js doctor --data-dir <DATA_DIR>    # 数据目录可写/锁/插件 全绿
curl -s localhost:8792/api/agents                  # 每 bot idle + channelState online
```

注意：恢复的是**备份时刻**的名册与台账；备份之后的增量（新 bot、新对话）随 `.broken` 卷一起
丢失——先从两边 diff 抢救再放弃。dsh/pi 的 per-bot 物化目录（`~/.dsh/profiles/`、`~/.pi/agent-wao-*/`）
不在 data/ 里，若也损坏，`POST /api/bots/<id>/rematerialize-assets` 按当前绑定重建装备面，
dsh profile 可删 bot 重建（DELETE 随 bot 清理）。

## 3. 版本回滚（升级翻车）

```sh
cd <REPO_DIR>
git log --oneline -10                # 找到上一个可用 tag/commit（也可 git tag 看）
git status                           # 确认工作区干净（脏改动先 stash）
git checkout <hash>                  # 回到该版本
# 重启（代码升级只有进程重启可信，reload 刷不掉 ESM 缓存）：
launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office
curl -s localhost:8792/healthz       # version 应显示回滚后的预期
bash test/probe.sh --check           # CLI 事件序列 vs 基线，漂移→diff+exit 1
```

数据目录与代码版本之间没有 schema 迁移锁（bots.json/assets.json 向后兼容）；回滚后若
`doctor` 或启动日志报字段漂移，按日志逐条处理——拒绝优于静默纠正。

## 4. 备份频率建议

| 数据 | 变化频率 | 建议 |
|---|---|---|
| bots.json / assets.json | 低（改配置才动） | 每次改配置后顺手热备一次 |
| ledger/ | 高（每轮对话追加） | 每日停服冷备，或每日热备 ledger 尾部增量 |
