// channel-wecom media (DESIGN-MULTIMODAL §2.2/§4.2): 企微智能机器人回调里的
// 图片/文件是「url(5 分钟时效) + aeskey(每链接唯一)」形态——收到即下载 +
// AES-256-CBC 解密 + 按内容寻址落盘，绝不等引擎层（url 过期即永远拿不回）。
// 解密与官方 SDK @wecom/aibot-node-sdk src/crypto.ts (1.0.6, MIT) 同构：
//   key = Base64 解码 aeskey（32 字节）；IV = key 前 16 字节；
//   setAutoPadding(false) + 手工去 PKCS#7（企微按 32 字节块填充，Node 默认
//   16 字节 autopad 会 bad decrypt——SDK 源码注释过这个坑）。
// 不可信数据红线：路径只由 sha256 决定；ext 只由 magic bytes 决定（后缀可
// 伪造）；filename 仅作元数据展示（sanitize 后进信封，绝不进路径）；不执行
// 任何下载物。全部失败路径抛结构化 MediaError → adapter 翻译成用户文案
//（拒绝优于静默丢）。
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_LIMITS = Object.freeze({
  downloadTimeoutMs: 10_000,
  maxDownloadBytes: 24 * 1024 * 1024, // 密文读流上限（20MB 明文上限 + 填充/余量）
  maxImageBytes: 4 * 1024 * 1024, // 单图解密后（base64 ×4/3 后给 claude stdin 10MB 上限留余量）
  maxFileBytes: 20 * 1024 * 1024, // 单文件解密后
  botQuotaBytes: 200 * 1024 * 1024, // per-bot 媒体目录配额
  retentionDays: 7,
});

// 结构化错误：code 供 adapter 的文案矩阵映射，message 面向日志。
export class MediaError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'MediaError';
    this.code = code;
  }
}

// AES-256-CBC 解密一条已下载的密文（官方 SDK decryptFile 同构，含 32 字节
// PKCS#7 手工去填与全 padding 字节一致性校验）。aeskey 是回调里每链接唯一
// 的 Base64 串；任何一步不对（key 长度/解密/填）都归一成 decrypt-failed。
export function decryptMedia(encrypted, aesKey) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new MediaError('decrypt-failed', 'decryptMedia: empty encrypted buffer');
  }
  if (typeof aesKey !== 'string' || aesKey === '') {
    throw new MediaError('decrypt-failed', 'decryptMedia: aesKey missing');
  }
  let key;
  let out;
  try {
    key = Buffer.from(aesKey, 'base64');
    if (key.length !== 32) {
      throw new MediaError('decrypt-failed', `decryptMedia: aesKey decodes to ${key.length} bytes (expected 32)`);
    }
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false); // 企微按 32 字节块填充，Node autopad 按 16 字节会 bad decrypt
    const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const padLen = padded[padded.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > padded.length) {
      throw new MediaError('decrypt-failed', `decryptMedia: invalid PKCS#7 padding value ${padLen}`);
    }
    for (let i = padded.length - padLen; i < padded.length; i += 1) {
      if (padded[i] !== padLen) {
        throw new MediaError('decrypt-failed', 'decryptMedia: PKCS#7 padding bytes mismatch');
      }
    }
    out = padded.subarray(0, padded.length - padLen);
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError('decrypt-failed', `decryptMedia: ${e?.message ?? e}`);
  }
  return out;
}

// magic bytes → {ext, mediaType}。识别面刻意收窄：图片四种 + pdf + zip 容器
//（docx/xlsx/xlsm 都是 zip，模型侧工具自己再分）；识别不出 → null（由调用
// 方决定婉拒或按二进制处理）。回传的 filename 后缀一律不信（红线）。
export function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ext: 'png', mediaType: 'image/png' };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mediaType: 'image/jpeg' };
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return { ext: 'gif', mediaType: 'image/gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', mediaType: 'image/webp' };
  }
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mediaType: 'application/pdf' };
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return { ext: 'zip', mediaType: 'application/zip' };
  }
  return null;
}

// filename 只作元数据展示：去控制字符与路径分隔符、限长。绝不拼进任何路径。
export function sanitizeName(name) {
  return String(name ?? '')
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 120);
}

// botId 成为路径段——与 bots.js 的 BOT_ID_RE 同口径（字母/数字/下划线/连字
// 符）。不合法即拒（防御 stale/hand-edited bots.json）。
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const yyyymm = (now) => {
  const d = new Date(now());
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// 下载密文字节 + 响应元数据（Content-Disposition 的 filename 就在这里）。
// 超时（AbortController）覆盖 **headers + body 全程**，大小上限先查
// content-length、再在流式读取中累计校验（无 content-length 的 body 也不会
// 全量入内存后才后验）；非 2xx 归 download-failed。
// 盲评 P1-1 教训：fetch() 只等到响应头——timer 若在 fetch 返回即清，body
// 读取阶段就没了预算，弱网/CDN 截断的源站会拖到 undici 默认 bodyTimeout
//（~300s）。这里 headers 与 body 在同一个 try 里，timer 只在全程结束后清。
async function fetchWithMeta(url, { timeoutMs = MEDIA_LIMITS.downloadTimeoutMs, maxBytes = MEDIA_LIMITS.maxDownloadBytes } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new MediaError('download-failed', `fetchBytes: invalid url ${JSON.stringify(String(url).slice(0, 80))}`);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { signal: ac.signal, redirect: 'error' }); // 不跟随跳转：回调 url 是企微签发的直链
    } catch (e) {
      if (ac.signal.aborted) throw new MediaError('download-timeout', `fetchBytes: timeout after ${timeoutMs}ms`);
      throw new MediaError('download-failed', `fetchBytes: ${e?.message ?? e}`);
    }
    if (!res.ok) {
      throw new MediaError('download-failed', `fetchBytes: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new MediaError('too-large', `fetchBytes: content-length ${declared} > ${maxBytes}`);
    }
    // 流式读取（盲评 P2-3）：逐 chunk 累计，超限立即断流——无 content-length
    // 的 body 不再全量缓冲后验；读循环同时受 abort 信号保护（body 拖住 →
    // read() 以 AbortError reject → download-timeout）。
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value != null && value.length > 0) {
        chunks.push(Buffer.from(value));
        total += value.length;
      }
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 源站已断：无需在意 */ }
        throw new MediaError('too-large', `fetchBytes: body exceeded ${maxBytes} while streaming`);
      }
    }
    return { bytes: Buffer.concat(chunks), disposition: res.headers.get('content-disposition') ?? '' };
  } catch (e) {
    if (e instanceof MediaError) throw e;
    if (ac.signal.aborted) throw new MediaError('download-timeout', `fetchBytes: timeout after ${timeoutMs}ms`);
    throw new MediaError('download-failed', `fetchBytes: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

// Buffer 面（store 内部与单测用；信封组装请走 fetchAttachment）。
export async function fetchBytes(url, opts) {
  return (await fetchWithMeta(url, opts)).bytes;
}

// 下载响应的 Content-Disposition filename（尽力而为的展示名；形如
// `attachment; filename="report.pdf"` 或 RFC 5987 `filename*=UTF-8''…`）。
export function filenameFromDisposition(header) {
  const raw = String(header ?? '');
  if (raw === '') return '';
  let m = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(raw);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* 畸形编码 → 落到 filename= */ }
  }
  m = /filename="([^"]*)"/.exec(raw) || /filename=([^;]+)/.exec(raw);
  return m ? m[1].trim() : '';
}

// 按内容寻址的媒体仓库：data/media/<botId>/<yyyymm>/<sha256>.<ext>。
// 同内容天然去重（existsSync 即跳过写入）；per-bot 配额 LRU（超 200MB 按
// mtime 升序删最旧）+ 7 天过期清理（启动时各 bot 跑一次，函数级可测）。
export function createMediaStore({ root, limits = MEDIA_LIMITS, log = null, now = Date.now } = {}) {
  if (typeof root !== 'string' || root === '') throw new Error('createMediaStore: root is required');

  const botDir = (botId) => {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) {
      throw new MediaError('bad-bot-id', `createMediaStore: bot id ${JSON.stringify(botId)} 不是合法 slug`);
    }
    return join(root, botId);
  };

  const walkFiles = (dir) => {
    const out = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walkFiles(p));
      else if (e.isFile()) out.push(p);
    }
    return out;
  };

  // 配额 LRU：目录总量超 botQuotaBytes 时按 mtime 升序删最旧文件直到回到
  // 预算内。新文件先落盘再 enforce，保证刚收到的件不会被自己挤掉。
  function enforceQuota(botId) {
    const dir = botDir(botId);
    const files = walkFiles(dir)
      .map((p) => {
        try { return { p, at: statSync(p).mtimeMs, size: statSync(p).size }; } catch { return null; }
      })
      .filter(Boolean);
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= limits.botQuotaBytes) return 0;
    let removed = 0;
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= limits.botQuotaBytes) break;
      try {
        rmSync(f.p);
        total -= f.size;
        removed += 1;
        log?.debug?.(`media: quota evicted ${f.p}`);
      } catch (e) {
        log?.warn?.(`media: quota evict failed ${f.p}: ${e?.message ?? e}`);
      }
    }
    return removed;
  }

  // 7 天留存清理：删 mtime 早于 retentionDays 前的文件。返回删除数。
  function sweepExpired(botId) {
    const cutoff = now() - limits.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const p of walkFiles(botDir(botId))) {
      try {
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p);
          removed += 1;
        }
      } catch { /* racing delete: harmless */ }
    }
    return removed;
  }

  // 启动清理（plugin activate 时调用一次）：对 root 下每个 bot 目录跑
  // sweepExpired。目录名即 botId（BOT_ID_RE 已在落盘时保证）。
  function sweepAll() {
    let removed = 0;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (e.isDirectory() && BOT_ID_RE.test(e.name)) removed += sweepExpired(e.name);
    }
    return removed;
  }

  // 解密后的字节落盘。kind 决定大小预算（image 4MB / file 20MB）；图片的
  // ext/mediaType 由 magic bytes 钉死，识别不出的图片婉拒（unsupported-
  // type）；文件识别不出按 'bin' 落盘（文本/PDF 分级是引擎侧的事）。
  function save({ botId, bytes, kind }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new MediaError('bad-bytes', 'save: empty bytes');
    }
    const max = kind === 'image' ? limits.maxImageBytes : limits.maxFileBytes;
    if (bytes.length > max) {
      throw new MediaError('too-large', `save: ${kind} ${bytes.length} > ${max}`);
    }
    const sniffed = sniffType(bytes);
    if (kind === 'image' && sniffed == null) {
      throw new MediaError('unsupported-type', 'save: image magic bytes not recognized');
    }
    const ext = sniffed?.ext ?? 'bin';
    const mediaType = sniffed?.mediaType ?? 'application/octet-stream';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = join(botDir(botId), yyyymm(now), `${sha256}.${ext}`);
    if (!existsSync(path)) {
      // 原子写：tmp + rename（materializer 先例）——半截文件绝不会被当成完整附件。
      mkdirSync(join(path, '..'), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    enforceQuota(botId);
    return { path, sha256, size: bytes.length, ext, mediaType };
  }

  // 一站式：下载 → 解密 → 落盘 → 附件信封（adapter 对每个媒体项调用）。
  // 展示名优先级：调用方元数据（mixed 无文件名，通常为空）→ 下载响应的
  // Content-Disposition filename（企微 file 消息的官方出处）→ 空串。
  async function fetchAttachment({ botId, url, aeskey, kind, name = '' }) {
    const { bytes: encrypted, disposition } = await fetchWithMeta(url, {
      timeoutMs: limits.downloadTimeoutMs, maxBytes: limits.maxDownloadBytes,
    });
    const bytes = decryptMedia(encrypted, aeskey);
    const saved = save({ botId, bytes, kind });
    return {
      kind, path: saved.path, sha256: saved.sha256, size: saved.size,
      mediaType: saved.mediaType, name: sanitizeName(name || filenameFromDisposition(disposition)),
    };
  }

  return { root, save, fetchAttachment, enforceQuota, sweepExpired, sweepAll };
}
