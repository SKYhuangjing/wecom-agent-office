import crypto from 'node:crypto';

export const MAX_S3_EXPIRES_SEC = 604800; // 7 days (S3/OSS hard limit for Presigned URLs)

export function hmac(key, data, encoding) {
  const mac = crypto.createHmac('sha256', key).update(data);
  return encoding ? mac.digest(encoding) : mac.digest();
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const MIME_MAP = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function detectContentType(filename) {
  if (typeof filename !== 'string') return 'application/octet-stream';
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export function resolveEndpointDetails(bucket, endpoint, key) {
  const isExplicitHttps = /^https:\/\//i.test(endpoint);
  const isExplicitHttp = /^http:\/\//i.test(endpoint);
  const clean = endpoint.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const isIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(clean) || clean.startsWith('localhost');
  const protocol = isExplicitHttps ? 'https:' : (isExplicitHttp || isIp ? 'http:' : 'https:');
  const normalizedKey = key.replace(/^\/+/, '');

  if (isIp) {
    // Path-style for IP / localhost mock endpoints
    const host = clean;
    const canonicalUri = '/' + [bucket, ...normalizedKey.split('/')].map(encodeURIComponent).join('/');
    return { protocol, host, canonicalUri, normalizedKey };
  }
  // Virtual-hosted style for standard domain endpoints (e.g. 1data-dev.oss-cn-shanghai.aliyuncs.com)
  const host = `${bucket}.${clean}`;
  const canonicalUri = '/' + normalizedKey.split('/').map(encodeURIComponent).join('/');
  return { protocol, host, canonicalUri, normalizedKey };
}

/**
 * AWS4-signed PUT for S3-compatible object stores (Alibaba Cloud OSS / AWS S3).
 * Zero third-party SDK dependencies.
 */
export async function ossPut({
  bucket,
  endpoint,
  region = 'cn-shanghai',
  accessKeyId,
  accessKeySecret,
  key,
  body,
  contentType,
  timeoutMs = 60_000,
}) {
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) {
    throw new Error('Missing required OSS credentials (bucket, endpoint, accessKeyId, accessKeySecret)');
  }

  const { protocol, host, canonicalUri, normalizedKey } = resolveEndpointDetails(bucket, endpoint, key);

  const bodyBuffer = Buffer.isBuffer(body)
    ? body
    : (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body ?? ''));
  const payloadHash = sha256(bodyBuffer);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const finalContentType = contentType || detectContentType(normalizedKey);

  const headers = {
    host,
    'content-length': String(bodyBuffer.byteLength),
    'content-type': finalContentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const sortedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${accessKeySecret}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`${protocol}//${host}${canonicalUri}`, {
    method: 'PUT',
    headers: { ...headers, authorization },
    body: bodyBuffer,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OSS PUT ${normalizedKey} failed (${response.status}): ${errorBody}`);
  }
  return { ok: true, status: response.status };
}

/**
 * Generate an AWS4 presigned GET URL for safe client downloads.
 * Query string based signature, valid for up to 7 days (604,800 seconds).
 */
export function getPresignedUrl({
  bucket,
  endpoint,
  region = 'cn-shanghai',
  accessKeyId,
  accessKeySecret,
  key,
  expiresIn = MAX_S3_EXPIRES_SEC,
}) {
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) {
    throw new Error('Missing required OSS credentials for presigning');
  }

  const { protocol, host, canonicalUri } = resolveEndpointDetails(bucket, endpoint, key);

  // Clamp expiresIn to MAX_S3_EXPIRES_SEC (604800)
  const finalExpires = Math.min(Math.max(1, Number(expiresIn) || MAX_S3_EXPIRES_SEC), MAX_S3_EXPIRES_SEC);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(finalExpires),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${accessKeySecret}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');

  return `${protocol}//${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
