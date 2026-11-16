// oss-share plugin tests.
// Layers:
//   1. oss.js unit: MIME detection, filename sanitization, presigned URL generation,
//      604800s S3 clamp, and AWS4 signed PUT against a local fake OSS server.
//   2. plugin.js asset seed & bot binding: idempotency and auto-binding.
//   3. kernel integration: /api/oss/status (secret masking), /api/oss/upload
//      error cases (503 unconfigured, 400 empty, 405 method, 413 size limit),
//      successful upload with audit log, and raw mode.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import {
  detectContentType,
  getPresignedUrl,
  ossPut,
  MAX_S3_EXPIRES_SEC,
} from '../../plugins/oss-share/oss.js';
import {
  sanitizeFilename,
  getOssConfig,
  ASSET_ID,
  ASSET_NAME,
} from '../../plugins/oss-share/plugin.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmpDirs = [];
const cleanTmp = () => {
  for (const d of tmpDirs.reverse()) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
after(cleanTmp);

const makeTmp = (prefix = 'wao-oss-test-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// --- 1. oss.js unit tests ---

test('oss.js: detectContentType handles various common file types', () => {
  assert.equal(detectContentType('report.csv'), 'text/csv; charset=utf-8');
  assert.equal(detectContentType('data.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(detectContentType('doc.pdf'), 'application/pdf');
  assert.equal(detectContentType('test.json'), 'application/json; charset=utf-8');
  assert.equal(detectContentType('image.png'), 'image/png');
  assert.equal(detectContentType('unknown.xyz123'), 'application/octet-stream');
  assert.equal(detectContentType(null), 'application/octet-stream');
});

test('oss-share: sanitizeFilename prevents directory traversal and shell mangling', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFilename('report*?<|>file.csv'), 'report_____file.csv');
  assert.equal(sanitizeFilename('report\x00\x08\x1f\x7fname.csv'), 'report____name.csv', 'filters control chars');
  assert.match(sanitizeFilename('   '), /^file_\d+\.bin$/, 'fallback for empty filename');
  const longName = 'a'.repeat(200) + '.xlsx';
  const clean = sanitizeFilename(longName);
  assert.ok(clean.length <= 120, 'long name truncated');
  assert.ok(clean.endsWith('.xlsx'), 'preserves extension on truncation');
});

test('oss.js: getPresignedUrl generates valid S3/OSS AWS4 query URL and clamps expiresSec', () => {
  const params = {
    bucket: 'test-bucket',
    endpoint: 'oss-cn-shanghai.aliyuncs.com',
    region: 'cn-shanghai',
    accessKeyId: 'AKID123456',
    accessKeySecret: 'SECRET123456',
    key: 'wao/20261116/abc/test.csv',
    expiresIn: 2592000, // 30 days requested
  };

  const urlStr = getPresignedUrl(params);
  const parsed = new URL(urlStr);

  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, 'test-bucket.oss-cn-shanghai.aliyuncs.com');
  assert.equal(parsed.pathname, '/wao/20261116/abc/test.csv');

  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.ok(parsed.searchParams.get('X-Amz-Credential')?.startsWith('AKID123456/'));
  assert.ok(parsed.searchParams.get('X-Amz-Date'));
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(parsed.searchParams.get('X-Amz-Signature'));

  // MUST clamp to MAX_S3_EXPIRES_SEC (604800) to prevent S3 AuthorizationQueryParametersError
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), String(MAX_S3_EXPIRES_SEC));
});

test('oss.js: ossPut validates required parameters', async () => {
  await assert.rejects(
    async () => ossPut({ bucket: '', endpoint: 'x', accessKeyId: 'k', accessKeySecret: 's', key: '1' }),
    /Missing required OSS credentials/
  );
});

test('oss.js: ossPut sends AWS4 authorization headers and body to target server', async () => {
  let capturedReq = null;
  let capturedBody = '';

  const server = http.createServer((req, res) => {
    capturedReq = {
      method: req.method,
      url: req.url,
      headers: req.headers,
    };
    req.setEncoding('utf8');
    req.on('data', (c) => { capturedBody += c; });
    req.on('end', () => {
      res.writeHead(200);
      res.end('ok');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const payload = 'col1,col2\nval1,val2\n';
    await ossPut({
      bucket: 'test-bucket',
      endpoint: `127.0.0.1:${port}`,
      region: 'cn-shanghai',
      accessKeyId: 'LTAI5testAK',
      accessKeySecret: 'testSecretKey123',
      key: 'wao/data/test.csv',
      body: payload,
      contentType: 'text/csv',
    });

    assert.equal(capturedReq.method, 'PUT');
    assert.equal(capturedReq.url, '/test-bucket/wao/data/test.csv');
    assert.equal(capturedBody, payload);
    assert.ok(capturedReq.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=LTAI5testAK/'));
    assert.ok(capturedReq.headers.authorization.includes('SignedHeaders='));
    assert.ok(capturedReq.headers.authorization.includes('Signature='));
    assert.equal(capturedReq.headers['content-type'], 'text/csv');
    assert.equal(capturedReq.headers['content-length'], String(Buffer.byteLength(payload)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- 2. plugin.js config resolution tests ---

test('oss-share: getOssConfig priority: ctx.config > env > defaults', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.WAO_OSS_BUCKET;
    delete process.env.RELEASE_OSS_BUCKET;

    // 1. Defaults when empty
    const c1 = getOssConfig({ config: {} });
    assert.equal(c1.bucket, '1data-dev');
    assert.equal(c1.prefix, 'wao');
    assert.equal(c1.accessKeyId, '');

    // 2. Env fallback
    process.env.WAO_OSS_BUCKET = 'env-bucket';
    process.env.WAO_OSS_ACCESS_KEY_ID = 'ENV_AK';
    const c2 = getOssConfig({ config: {} });
    assert.equal(c2.bucket, 'env-bucket');
    assert.equal(c2.accessKeyId, 'ENV_AK');

    // 3. Plugin options override env
    const c3 = getOssConfig({
      config: {
        bucket: 'plugin-bucket',
        accessKeyId: 'PLUGIN_AK',
        accessKeySecret: 'PLUGIN_SECRET',
        expiresSec: 3600,
      },
    });
    assert.equal(c3.bucket, 'plugin-bucket');
    assert.equal(c3.accessKeyId, 'PLUGIN_AK');
    assert.equal(c3.accessKeySecret, 'PLUGIN_SECRET');
    assert.equal(c3.expiresSec, 3600);
  } finally {
    process.env = origEnv;
  }
});

// --- 3. Full-kernel integration with oss-share plugin ---

test('kernel integration: oss-share registers status and upload routes, seeds assets and auto-binds bots', async () => {
  const dataDir = makeTmp('wao-oss-data-');

  // Seed initial assets.json and bots.json
  writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({ assets: [] }, null, 2));
  writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({
    bots: [
      { id: 'bot-1', name: '运价助手', assets: [] },
      { id: 'bot-2', name: '客服助手', assets: [{ assetId: 'ast-other', mode: 'shared' }] },
    ],
  }, null, 2));

  // Configure plugin in plugins.json
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({
    plugins: {
      'oss-share': {
        enabled: true,
        options: {
          bucket: 'my-test-bucket',
          endpoint: 'oss-cn-shanghai.aliyuncs.com',
          prefix: 'wao-test',
          accessKeyId: 'TEST_AK_1234',
          accessKeySecret: 'TEST_SECRET_5678',
          expiresSec: 86400,
          maxUploadBytes: 50,
        },
      },
    },
  }, null, 2));

  const k = await createKernel({
    port: 0,
    dataDir,
    pluginsDirs: [join(repoRoot, 'plugins')],
  });

  try {
    const base = `http://127.0.0.1:${k.http.port}`;

    // 1. Verify assets.json has ast-oss-share
    const assetsDoc = JSON.parse(readFileSync(join(dataDir, 'assets.json'), 'utf8'));
    const ossAsset = assetsDoc.assets.find((a) => a.id === ASSET_ID);
    assert.ok(ossAsset, 'ast-oss-share asset must be seeded');
    assert.equal(ossAsset.type, 'skill');
    assert.equal(ossAsset.name, ASSET_NAME);
    assert.ok(ossAsset.content.body.includes('curl -s -X POST --data-binary'));

    // 2. Verify bots.json auto-bound ast-oss-share
    const botsDoc = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8'));
    assert.equal(botsDoc.bots[0].assets.some((a) => a.assetId === ASSET_ID), true);
    assert.equal(botsDoc.bots[1].assets.some((a) => a.assetId === ASSET_ID), true);

    // 3. GET /api/oss/status
    const statusRes = await fetch(`${base}/api/oss/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.bucket, 'my-test-bucket');
    assert.equal(statusBody.prefix, 'wao-test');
    assert.equal(statusBody.accessKeySecret, '__MASKED__', 'Secret must be masked');
    assert.ok(statusBody.accessKeyId.includes('...'), 'AccessKeyId must be masked');

    // 4. Test method not allowed (405)
    const badMethod = await fetch(`${base}/api/oss/status`, { method: 'POST' });
    assert.equal(badMethod.status, 405);
    const badUploadMethod = await fetch(`${base}/api/oss/upload`, { method: 'GET' });
    assert.equal(badUploadMethod.status, 405);

    // 5. Test empty body upload (400)
    const emptyUpload = await fetch(`${base}/api/oss/upload?filename=empty.txt`, {
      method: 'POST',
      body: '',
    });
    assert.equal(emptyUpload.status, 400);

    // 6. Test payload too large (413) - configured limit is 50 bytes
    const hugeUpload = await fetch(`${base}/api/oss/upload?filename=large.bin`, {
      method: 'POST',
      body: Buffer.alloc(100, 'x'),
    });
    assert.equal(hugeUpload.status, 413);
    const hugeErr = await hugeUpload.json();
    assert.ok(hugeErr.error.includes('payload too large'));
  } finally {
    await k.stop();
  }
});

test('kernel integration: oss-share upload succeeds, writes audit log, and supports raw mode', async () => {
  // Start fake OSS server
  let uploadedKey = '';
  let uploadedBody = '';
  const fakeOss = http.createServer((req, res) => {
    uploadedKey = req.url;
    req.setEncoding('utf8');
    req.on('data', (c) => { uploadedBody += c; });
    req.on('end', () => {
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => fakeOss.listen(0, '127.0.0.1', r));
  const ossPort = fakeOss.address().port;

  const dataDir = makeTmp('wao-oss-upload-');
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({
    plugins: {
      'oss-share': {
        enabled: true,
        options: {
          bucket: 'mock-bucket',
          endpoint: `127.0.0.1:${ossPort}`,
          prefix: 'wao',
          accessKeyId: 'MOCK_AK',
          accessKeySecret: 'MOCK_SECRET',
          expiresSec: 86400,
        },
      },
    },
  }, null, 2));

  const k = await createKernel({
    port: 0,
    dataDir,
    pluginsDirs: [join(repoRoot, 'plugins')],
  });

  try {
    const base = `http://127.0.0.1:${k.http.port}`;
    const csvContent = 'carrier,route,rate\nMSK,SHA-RTM,1500\nCOSCO,SHA-HAM,1450\n';

    // 1. Upload file with JSON response
    const uploadRes = await fetch(`${base}/api/oss/upload?filename=rates.csv`, {
      method: 'POST',
      body: csvContent,
    });
    assert.equal(uploadRes.status, 200);
    const body = await uploadRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.filename, 'rates.csv');
    assert.equal(body.size, Buffer.byteLength(csvContent));
    assert.ok(body.url.includes('rates.csv'));
    assert.ok(body.url.includes('X-Amz-Signature='));
    assert.equal(uploadedBody, csvContent);
    assert.ok(uploadedKey.endsWith('/rates.csv'));

    // Verify audit ledger in data/oss-uploads.jsonl
    const ledgerFile = join(dataDir, 'oss-uploads.jsonl');
    const ledgerContent = readFileSync(ledgerFile, 'utf8');
    const parsedLine = JSON.parse(ledgerContent.trim());
    assert.equal(parsedLine.filename, 'rates.csv');
    assert.equal(parsedLine.size, Buffer.byteLength(csvContent));

    // 2. Upload with raw=1 mode
    const rawRes = await fetch(`${base}/api/oss/upload?filename=summary.txt&raw=1`, {
      method: 'POST',
      body: 'Summary line 1\nSummary line 2',
    });
    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.headers.get('content-type'), 'text/plain; charset=utf-8');
    const rawUrl = await rawRes.text();
    assert.ok(rawUrl.startsWith(`http://127.0.0.1:${ossPort}/mock-bucket`));
    assert.ok(rawUrl.includes('/summary.txt?'));
  } finally {
    await k.stop();
    await new Promise((r) => fakeOss.close(r));
  }
});
