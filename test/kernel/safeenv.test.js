// Security audit P0-2 unit grid: src/kernel/safeEnv.js childEnv() — the env
// every agent-CLI/vendor-tool spawn builds on. The contract: auth-shaped
// parent keys (WAO_TOKEN above all) never cross into the child, everything
// operational (PATH/HOME/locale/…) does, the dsh model-gateway key is
// whitelisted, and caller extras always win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv } from '../../src/kernel/safeEnv.js';

// Mutate process.env under us and restore exactly (undefined stays deleted).
const withEnv = async (vars, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test('childEnv: auth-shaped parent keys are stripped — WAO_TOKEN / API keys / secrets / passwords / credentials', async () => {
  await withEnv({
    WAO_TOKEN: 'test',
    OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_AUTH_TOKEN: 't-1',
    MY_SECRET: 's',
    DB_PASSWORD: 'p',
    SERVICE_CREDENTIALS_FILE: '/x',
    APIKEY: 'k',
  }, () => {
    const env = childEnv();
    assert.equal(env.WAO_TOKEN, undefined, 'WAO_TOKEN never reaches the agent child');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.MY_SECRET, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
    assert.equal(env.SERVICE_CREDENTIALS_FILE, undefined, 'CREDENTIAL-substring keys strip too');
    assert.equal(env.APIKEY, undefined, 'APIKEY (no underscore) matches API_?KEY');
  });
});

test('childEnv: operational env survives; MAGPIE_GATEWAY_KEY is whitelisted; extras win', async () => {
  await withEnv({
    MAGPIE_GATEWAY_KEY: 'gw-key',
    WAO_TOKEN: 'test',
    HOME: '/home/someone',
  }, () => {
    const env = childEnv({ DEEPSEEK_API_KEY: 'bot-owned', EXTRA_FLAG: '1' });
    assert.equal(env.MAGPIE_GATEWAY_KEY, 'gw-key', 'gateway key kept — the dsh model route needs it');
    assert.equal(env.WAO_TOKEN, undefined);
    assert.equal(typeof env.PATH, 'string', 'PATH kept (the CLI must resolve)');
    assert.equal(env.HOME, '/home/someone', 'HOME kept');
    assert.equal(env.DEEPSEEK_API_KEY, 'bot-owned', 'caller extras land even when secret-shaped (the bot own credential)');
    assert.equal(env.EXTRA_FLAG, '1');
    // the parent env object itself is never handed out or mutated
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  });
});

test('childEnv: suffix semantics — operational names that merely CONTAIN the words stay', async () => {
  await withEnv({ TOKENS_DIR: '/var/tokens', PASSWORD_FILE_DIR: '/etc', MY_PASSWORD: 'x' }, () => {
    const env = childEnv();
    assert.equal(env.TOKENS_DIR, '/var/tokens', 'only *TOKEN suffix strips, not *TOKEN*');
    assert.equal(env.PASSWORD_FILE_DIR, '/etc', 'PASSWORD mid-name is a dir path, not a secret');
    assert.equal(env.MY_PASSWORD, undefined, '*PASSWORD suffix strips');
  });
});
