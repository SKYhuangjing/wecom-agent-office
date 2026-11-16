# @wao/plugin-oss-share CHANGELOG

## 0.1.0 (2026-11-16)

### Added
- **AWS4 S3/OSS 零依赖签名**：基于 `node:crypto` 实现 `ossPut` 与 `getPresignedUrl`，支持阿里云 OSS 与 S3 兼容对象存储。
- **预签名安全外链**：默认生成 7 天有效期的只读下载链接（硬封顶 S3 604,800 秒上限，避免协议报错），私有 Bucket 无需开启公有读。
- **本地文件上传接口**：`POST /api/oss/upload` 接收二进制文件流，提供文件名清洗、扩展名 MIME 自动识别、单文件上限保护（默认 200MB）与审计台账（`data/oss-uploads.jsonl`）。
- **状态监控接口**：`GET /api/oss/status` 回显配置就绪状态，敏感密钥强制掩码（`__MASKED__`）。
- **资产系统联动**：激活时自动 seed `ast-oss-share` skill 资产，并自动为已有全部机器人绑定，指导各 Provider 下的 Agent（pi/claude/codex 等）通过 curl 上传文件并以 Markdown 交付用户。
- **内核回环门禁豁免**：在 `src/kernel/http.js` 中对来自本地回环的 `/api/oss/upload` 请求豁免 `WAO_TOKEN`，既适配了 `childEnv` 环境变量净化，又严防非回环未经授权的外部调用。
