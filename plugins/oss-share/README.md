# @wao/plugin-oss-share (文件云存储外链)

让所有企业微信机器人的 AI Agent 能够将大文件、数据报表、CSV/Excel 分析数据等物化产物上传到阿里云 OSS 对象存储，生成 7 天内有效的预签名安全下载链接交付给用户，解决企微无法直接发送本地文件附件的问题。

## 为什么需要此插件

1. **企微通道限制**：企业微信机器人的 OpenWS 消息协议出站仅支持文本/Markdown/流式回答，不支持直接外发本地文件。
2. **凭据安全隔离**：子进程 Agent 不接触任何 OSS AccessKey / Secret（内核环境安全过滤保持 `childEnv` 净化）。
3. **安全下载外链**：默认使用 AWS4 预签名 URL（最长 7 天），OSS Bucket 保持私有读取，数据不公开裸奔。

## 配置方式 (`data/plugins.json`)

在 WAO 的 `data/plugins.json` 中配置：

```json
{
  "plugins": {
    "oss-share": {
      "enabled": true,
      "options": {
        "endpoint": "oss-cn-shanghai.aliyuncs.com",
        "bucket": "1data-dev",
        "prefix": "wao",
        "region": "cn-shanghai",
        "accessKeyId": "LTAI5t...",
        "accessKeySecret": "...",
        "expiresSec": 604800,
        "maxUploadBytes": 209715200
      }
    }
  }
}
```

> 也支持通过环境变量兜底：`WAO_OSS_ACCESS_KEY_ID`、`WAO_OSS_ACCESS_KEY_SECRET`、`WAO_OSS_BUCKET`、`WAO_OSS_ENDPOINT`（或 `RELEASE_OSS_*`）。

## HTTP 接口

### 1. 文件上传 `POST /api/oss/upload`

- **地址**：`http://127.0.0.1:8792/api/oss/upload?filename=report.csv`
- **鉴权**：本地回环（127.0.0.1 / ::1）免 WAO_TOKEN；非回环调用须提供 `Authorization: Bearer <WAO_TOKEN>`。
- **请求体**：文件二进制流。
- **参数**：
  - `filename`: 文件名（推荐传真实文件名，用于下载展示与 MIME 识别）
  - `raw=1`: 直接返回纯文本 URL
- **响应 (JSON)**：
  ```json
  {
    "ok": true,
    "url": "https://1data-dev.oss-cn-shanghai.aliyuncs.com/wao/20261116/a1b2c3d4/report.csv?...",
    "key": "wao/20261116/a1b2c3d4/report.csv",
    "filename": "report.csv",
    "size": 1024,
    "expiresSec": 604800
  }
  ```

### 2. 状态查询 `GET /api/oss/status`

- **响应**：查看当前 OSS 连接配置与就绪状态（密钥脱敏显示）。

## 资产系统联动

插件激活时会自动注册 `ast-oss-share` skill 资产，并自动绑定到全部已知机器人，指导 Agent 在需要交付数据文件时调用 curl 上传并回复 Markdown 链接。
