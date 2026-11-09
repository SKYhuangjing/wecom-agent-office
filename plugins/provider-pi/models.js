// Per-bot pi models.json materialization (DESIGN §5, dsh profiles.js
// precedent): provider-pi's materializeConfig writes the pi agent dir's
// models.json declaring the gateway (baseUrl/api) with the API key referenced
// as "$<apiKeyEnv>" — pi resolves the reference from the environment the
// runner injects, so NO secret ever lands on disk (WAO 密钥红线).
//
// The default agent dir is WAO-namespaced per bot (~/.pi/agent-wao-<botId>,
// mirroring dsh's ~/.dsh/profiles/wecom-<botId>): overwriting models.json
// inside it is always office-owned. When providerConfig.piAgentDir points
// somewhere custom, a models.json WITHOUT our waoManaged marker is treated as
// the user's own file and the write refuses (a foreign config must not be
// stomped silently — the 400 names the path).
//
// Sessions live in the same tree (<piAgentDir>/sessions/) but are NEVER
// touched here: removeBotModels deletes models.json only — the 员工档案's
// conversation history survives 删除机器人 (HANDOFF: 会话数据保留).
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../../src/kernel/config.js';

export function piAgentDirFor({ botId, piAgentDir } = {}) {
  return piAgentDir || join(homedir(), '.pi', `agent-wao-${botId ?? 'bot'}`);
}

export function modelsPathFor(opts) {
  return join(piAgentDirFor(opts), 'models.json');
}

export function writeBotModels({ botId, piAgentDir, provider, baseUrl, api, apiKeyEnv, model, thinking }) {
  if (typeof botId !== 'string' || botId === '') {
    throw new Error('writeBotModels: botId is required');
  }
  if (!model || typeof model.model !== 'string' || model.model === '') {
    throw new Error(`writeBotModels: bot ${botId} needs providerConfig.model.model（models.json 需要具体模型 id）`);
  }
  const target = modelsPathFor({ botId, piAgentDir });

  // Foreign-file guard (see header): only our own marker makes the write safe.
  if (existsSync(target)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(target, 'utf8'));
    } catch { /* unparsable foreign file — caught by the marker check below */ }
    if (existing?.waoManaged !== true) {
      throw new Error(`writeBotModels: refusing to overwrite a non-WAO models.json at ${target}（如需接管请先手动迁移或改 piAgentDir）`);
    }
  }

  const dir = piAgentDirFor({ botId, piAgentDir });
  mkdirSync(dir, { recursive: true });

  const effProvider = provider || 'magpie';
  const apiKeyEnvName = apiKeyEnv || 'PI_MAGPIE_API_KEY';
  const entry = {
    id: model.model,
    name: model.name || model.model,
    contextWindow: Number(model.contextWindow) > 0 ? Number(model.contextWindow) : 272000,
    maxTokens: Number(model.maxTokens) > 0 ? Number(model.maxTokens) : 131072,
  };
  if (thinking && thinking !== 'off') entry.reasoning = true;
  const doc = {
    waoManaged: true,
    waoBotId: botId,
    providers: {
      [effProvider]: {
        baseUrl: baseUrl || 'http://127.0.0.1:3425',
        api: api || 'anthropic-messages',
        // "$NAME" = resolve from the named environment variable at request
        // time (pi's resolve-config-value semantics; a bare name would be a
        // LITERAL key — the $ prefix is load-bearing).
        apiKey: `$${apiKeyEnvName}`,
        models: [entry],
      },
    },
  };
  atomicWrite(target, `${JSON.stringify(doc, null, 2)}\n`);
  try {
    // WAO 密钥纪律: data/ 0700、文件 0600 — materialized config is 0600 too
    // (it carries no secret, but there is no reason for group/other
    // readability).
    chmodSync(target, 0o600);
  } catch { /* best effort on exotic filesystems */ }
  return { path: target };
}

export function removeBotModels({ botId, piAgentDir } = {}) {
  try {
    const target = modelsPathFor({ botId, piAgentDir });
    if (existsSync(target)) {
      unlinkSync(target);
      return true;
    }
  } catch { /* best-effort by contract */ }
  return false;
}
