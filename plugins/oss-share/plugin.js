import { readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { atomicWrite } from '../../src/kernel/config.js';
import { ossPut, getPresignedUrl, MAX_S3_EXPIRES_SEC, detectContentType } from './oss.js';

export const ASSET_ID = 'ast-oss-share';
export const ASSET_NAME = 'oss-share';

const dataDirOf = (ctx) => ctx.services.get('paths')?.dataDir
  ?? ctx.config?.dataDir
  ?? process.env.WAO_HOME
  ?? join(process.cwd(), 'data');

const readJsonSafe = (file, defaultVal = {}) => {
  try {
    const raw = readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    if (doc !== null && typeof doc === 'object') return doc;
  } catch { /* missing or invalid */ }
  return defaultVal;
};

const SKILL_BODY = `# 文件云存储外链使用指南 (oss-share)

## 场景
由于企业微信出站消息协议限制，无法直接发送本地文件附件。当用户需要下载分析报表、运价明细、数据表格、导出的 CSV/Excel、日志文件或分析产物时：**先将文件生成到本地工作区，再调用本地上传接口换取预签名下载链接，以 Markdown 链接形式回复用户**。

## 上传步骤
1. 在当前工作目录下生成/导出目标文件（例如 \`analysis_report.csv\`）。
2. 在终端使用 curl 将文件上传至本地 oss-share 接口：
   \`\`\`bash
   curl -s -X POST --data-binary @analysis_report.csv "http://127.0.0.1:8792/api/oss/upload?filename=analysis_report.csv"
   \`\`\`
3. 接口会返回 JSON，例如：
   \`\`\`json
   {"ok":true,"url":"https://...","filename":"analysis_report.csv","expiresSec":604800}
   \`\`\`
4. 提取其中的 \`url\`，在企微回复中以清晰的 Markdown 链接交付给用户，例如：
   \`👉 [点击下载运价分析数据 (analysis_report.csv)](https://...)（链接 7 天内有效）\`

## 安全红线
- **严禁上传**含有密码、API Key、Token、私钥、环境变量配置（.env）或公司内部敏感凭证的文件。
- 上传文件仅用于向用户交付其明确要求的业务数据与产物。
`;

// Seed asset into assets.json
const ensureSkillAsset = (file, log) => {
  const doc = readJsonSafe(file, { assets: [] });
  if (!Array.isArray(doc.assets)) doc.assets = [];
  const exists = doc.assets.some((a) => a?.id === ASSET_ID || (a?.type === 'skill' && a?.name === ASSET_NAME));
  if (exists) return false;

  const now = Date.now();
  doc.assets.push({
    id: ASSET_ID,
    type: 'skill',
    name: ASSET_NAME,
    description: '通过 OSS 将本地文件生成预签名下载外链，解决企微无法直接发送文件附件的问题',
    content: {
      name: ASSET_NAME,
      body: SKILL_BODY,
    },
    origin: 'plugin',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  log.info?.(`oss-share: skill 资产 ${ASSET_NAME} 已注册到 ${file}`);
  return true;
};

// Auto-bind ast-oss-share to all bots in bots.json
const autoBindToAllBots = (botsFile, log) => {
  const doc = readJsonSafe(botsFile, { bots: [] });
  if (!Array.isArray(doc.bots) || doc.bots.length === 0) return false;

  let mutated = false;
  for (const bot of doc.bots) {
    if (!bot || typeof bot !== 'object') continue;
    if (!Array.isArray(bot.assets)) bot.assets = [];
    const alreadyBound = bot.assets.some((b) => b?.assetId === ASSET_ID);
    if (!alreadyBound) {
      bot.assets.push({ assetId: ASSET_ID, mode: 'shared' });
      mutated = true;
    }
  }

  if (mutated) {
    atomicWrite(botsFile, `${JSON.stringify(doc, null, 2)}\n`);
    log.info?.(`oss-share: 已自动为全部机器人绑定 ${ASSET_NAME} 资产`);
  }
  return mutated;
};

export const getOssConfig = (ctx) => {
  const cfg = ctx?.config ?? {};
  const endpoint = cfg.endpoint || process.env.WAO_OSS_ENDPOINT || process.env.RELEASE_OSS_ENDPOINT || 'oss-cn-shanghai.aliyuncs.com';
  const bucket = cfg.bucket || process.env.WAO_OSS_BUCKET || process.env.RELEASE_OSS_BUCKET || '1data-dev';
  const prefix = cfg.prefix || process.env.WAO_OSS_PREFIX || process.env.RELEASE_OSS_PREFIX || 'wao';
  const region = cfg.region || process.env.WAO_OSS_REGION || 'cn-shanghai';
  const accessKeyId = cfg.accessKeyId || process.env.WAO_OSS_ACCESS_KEY_ID || process.env.RELEASE_OSS_ACCESS_KEY_ID || '';
  const accessKeySecret = cfg.accessKeySecret || process.env.WAO_OSS_ACCESS_KEY_SECRET || process.env.RELEASE_OSS_ACCESS_KEY_SECRET || '';
  const expiresSec = Math.min(Math.max(1, Number(cfg.expiresSec) || MAX_S3_EXPIRES_SEC), MAX_S3_EXPIRES_SEC);
  const maxUploadBytes = Number(cfg.maxUploadBytes) || 209715200; // 200MB default

  return { endpoint, bucket, prefix, region, accessKeyId, accessKeySecret, expiresSec, maxUploadBytes };
};

export const sanitizeFilename = (rawName) => {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return `file_${Date.now()}.bin`;
  }
  const normalizedSlashes = rawName.trim().replace(/\\+/g, '/');
  let base = basename(normalizedSlashes);
  // Replace slashes, backslashes, control chars, and problematic shell chars
  base = base.replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, '_');
  // Avoid leading dots (.hidden)
  base = base.replace(/^\.+/, '');
  if (!base) return `file_${Date.now()}.bin`;
  // Limit length
  if (base.length > 120) {
    const ext = base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.')) : '';
    base = base.slice(0, 110) + ext;
  }
  return base;
};

export default {
  manifest: {
    id: 'oss-share',
    name: '文件云存储外链',
    type: 'middleware',
    version: '0.1.0',
    requires: { kernel: '^1' },
    config: {
      endpoint: { type: 'string', default: 'oss-cn-shanghai.aliyuncs.com', label: 'OSS Endpoint' },
      bucket: { type: 'string', default: '1data-dev', label: 'OSS Bucket 名称' },
      prefix: { type: 'string', default: 'wao', label: '存储前缀目录' },
      region: { type: 'string', default: 'cn-shanghai', label: 'OSS 所在区域' },
      accessKeyId: { type: 'string', default: '', label: 'AccessKey ID' },
      accessKeySecret: { type: 'password', default: '', label: 'AccessKey Secret' },
      expiresSec: { type: 'number', default: MAX_S3_EXPIRES_SEC, label: '预签名链接有效期(秒，最大 604800 / 7天)' },
      maxUploadBytes: { type: 'number', default: 209715200, label: '单文件最大字节数(默认 200MB)' },
    },
  },

  activate(ctx) {
    const log = ctx.log;
    const dataDir = dataDirOf(ctx);
    const assetsFile = join(dataDir, 'assets.json');
    const botsFile = join(dataDir, 'bots.json');

    // 1. Seed skill asset in assets.json and bind to existing bots
    try {
      ensureSkillAsset(assetsFile, log);
      autoBindToAllBots(botsFile, log);
    } catch (err) {
      log.warn?.(`oss-share: 资产初始化异常: ${err?.message ?? err}`);
    }

    const json = (res, code, obj, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };

    // 2. Status route: GET /api/oss/status
    ctx.http.register({
      prefix: '/api/oss/status',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        }
        const oss = getOssConfig(ctx);
        const configured = Boolean(oss.accessKeyId && oss.accessKeySecret && oss.bucket && oss.endpoint);
        const maskedKeyId = oss.accessKeyId
          ? (oss.accessKeyId.length > 8 ? `${oss.accessKeyId.slice(0, 4)}...${oss.accessKeyId.slice(-4)}` : '***')
          : '';
        json(res, 200, {
          ok: true,
          configured,
          endpoint: oss.endpoint,
          bucket: oss.bucket,
          prefix: oss.prefix,
          region: oss.region,
          accessKeyId: maskedKeyId,
          accessKeySecret: oss.accessKeySecret ? '__MASKED__' : '',
          expiresSec: oss.expiresSec,
          maxUploadBytes: oss.maxUploadBytes,
        });
      },
    });

    // 3. Upload route: POST /api/oss/upload
    ctx.http.register({
      prefix: '/api/oss/upload',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        }

        const oss = getOssConfig(ctx);
        if (!oss.accessKeyId || !oss.accessKeySecret) {
          return json(res, 503, {
            error: 'OSS credentials not configured: please set accessKeyId & accessKeySecret in plugins.json (oss-share options) or environment',
          });
        }

        const url = new URL(req.url, 'http://localhost');
        const rawFilename = url.searchParams.get('filename')
          || req.headers['x-filename']
          || req.headers['x-file-name']
          || '';
        const filename = sanitizeFilename(rawFilename);

        const contentLengthHeader = req.headers['content-length'];
        if (contentLengthHeader && Number(contentLengthHeader) > oss.maxUploadBytes) {
          return json(res, 413, { error: `payload too large: exceeds maxUploadBytes (${oss.maxUploadBytes})` });
        }

        // Read body stream with limit check
        const chunks = [];
        let totalBytes = 0;
        let limitExceeded = false;

        for await (const chunk of req) {
          totalBytes += chunk.length;
          if (totalBytes > oss.maxUploadBytes) {
            limitExceeded = true;
            break;
          }
          chunks.push(chunk);
        }

        if (limitExceeded) {
          try { req.destroy(); } catch { /* ignore */ }
          return json(res, 413, { error: `payload too large: body exceeded ${oss.maxUploadBytes} bytes` }, { Connection: 'close' });
        }

        if (totalBytes === 0) {
          return json(res, 400, { error: 'empty body: no file content received' });
        }

        const bodyBuffer = Buffer.concat(chunks, totalBytes);
        const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomToken = crypto.randomBytes(4).toString('hex');
        const objectKey = `${oss.prefix}/${dateStamp}/${randomToken}/${filename}`.replace(/\/{2,}/g, '/');
        const contentType = detectContentType(filename);

        try {
          await ossPut({
            bucket: oss.bucket,
            endpoint: oss.endpoint,
            region: oss.region,
            accessKeyId: oss.accessKeyId,
            accessKeySecret: oss.accessKeySecret,
            key: objectKey,
            body: bodyBuffer,
            contentType,
          });

          const presignedUrl = getPresignedUrl({
            bucket: oss.bucket,
            endpoint: oss.endpoint,
            region: oss.region,
            accessKeyId: oss.accessKeyId,
            accessKeySecret: oss.accessKeySecret,
            key: objectKey,
            expiresIn: oss.expiresSec,
          });

          // Ledger audit log: append to data/oss-uploads.jsonl
          try {
            const auditLine = JSON.stringify({
              time: new Date().toISOString(),
              filename,
              size: totalBytes,
              key: objectKey,
              ip: req.socket?.remoteAddress ?? '',
              expiresSec: oss.expiresSec,
            }) + '\n';
            appendFileSync(join(dataDir, 'oss-uploads.jsonl'), auditLine, 'utf8');
          } catch (auditErr) {
            log.warn?.(`oss-share: audit ledger append failed: ${auditErr?.message ?? auditErr}`);
          }

          const rawMode = url.searchParams.get('raw') === '1'
            || (req.headers.accept === 'text/plain' && !url.searchParams.get('format'));

          if (rawMode) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(presignedUrl);
          }

          return json(res, 200, {
            ok: true,
            url: presignedUrl,
            key: objectKey,
            filename,
            size: totalBytes,
            expiresSec: oss.expiresSec,
          });
        } catch (uploadErr) {
          log.error?.(`oss-share: upload failed: ${uploadErr?.message ?? uploadErr}`);
          return json(res, 502, { error: `OSS upload failed: ${uploadErr?.message ?? uploadErr}` });
        }
      },
    });

    log.info?.(`oss-share: 插件已激活 (endpoint: ${getOssConfig(ctx).endpoint}, bucket: ${getOssConfig(ctx).bucket})`);
  },
};
