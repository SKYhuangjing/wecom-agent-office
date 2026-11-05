// Materialize a per-bot dsh profile (Task 18): port of the production-proven
// wecom-bots/lib/profiles.js. A bot profile is built from the shipped
// `headless` template profile, then its cordis.patch.yml is written with the
// provider table (borrowed or custom route), agent-default-model,
// permission-presets, compaction-basic, system-prompt personaPrefix and
// sandbox-policy (mode / workspaceRoot / additionalWritableRoots). Config
// rows REPLACE wholesale (never deep-merged), so every field needed is
// restated.
//
// Changes vs 前身 (both contractual, DESIGN §5 materializeConfig):
//   - the patch is written through atomicWrite (src/kernel/config.js tmp+
//     rename) — the same persistence discipline as every other office file
//     (import pattern follows plugins/core-engine/bots.js);
//   - last-good: the FULL patch string is built before any byte is written,
//     so a throw anywhere above leaves the previous file untouched, and the
//     error names the path it was working from.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from '../../src/kernel/config.js';

const PERM = new Set(['workspace-write', 'read-only', 'danger-full-access']);

function profileHome() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
}

export function profilePatchPath(profile) {
  return join(profileHome(), 'profiles', profile, 'cordis.patch.yml');
}

// Ensure the profile directory exists by bootstrapping it from the shipped
// headless default via the dsh CLI itself (spawnSync kept from 前身 — it is
// the only faithful way to lay down the full profile bundle).
export function ensureProfileExists(profile, { dshBin, nodeBin }) {
  const dir = join(profileHome(), 'profiles', profile);
  if (existsSync(join(dir, 'cordis.patch.yml'))) return { created: false, dir };
  const r = spawnSync(dshBin, ['--profile', profile, '--from-default-profile', 'headless', '--help'], {
    env: { ...process.env, PATH: `${join(nodeBin, '..')}:${process.env.PATH || ''}` },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { created: r.status === 0, dir, status: r.status, stderr: r.stderr };
}

// Borrow the llm-pi-ai provider table block from the source profile so the
// local gateway route (model availability) keeps resolving.
function readProviderBlock(sourceProfile) {
  const patch = profilePatchPath(sourceProfile);
  if (!existsSync(patch)) return null;
  const text = readFileSync(patch, 'utf8');
  const idx = text.indexOf('- id: llm-pi-ai');
  if (idx === -1) return null;
  const rest = text.slice(idx + 1);
  const next = rest.search(/\n- id:/);
  const block = next === -1 ? text.slice(idx) : text.slice(idx, idx + 1 + next);
  return block.trimEnd() + '\n';
}

function yamlQuote(s) {
  // block scalar safe: use |-\n  indented lines
  const lines = String(s).replace(/\r\n/g, '\n').split('\n');
  return '|-\n' + lines.map((l) => '      ' + l).join('\n');
}

export function writeBotProfile({
  profile,
  model,
  permission,
  prompt,
  writableDirs,
  workspaceRoot,
  dshBin,
  nodeBin,
  sourceProfile = 'headless',
  compaction,
}) {
  ensureProfileExists(profile, { dshBin, nodeBin });
  if (!model || !model.model) model = { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' };
  const perm = PERM.has(permission) ? permission : 'workspace-write';
  // sandbox: workspaceRoot confines writes; workspace-write + additional dirs.
  const wroot = workspaceRoot || '';
  const extras = Array.isArray(writableDirs) ? writableDirs.filter(Boolean) : [];
  // A hand-declared model needs contextWindow/maxTokens, otherwise
  // resolveModelInfo() reports no context capacity and compaction-basic logs
  // "no context capacity" and silently skips automatic compaction.
  const modelContextWindow = Number(model.contextWindow) > 0 ? Number(model.contextWindow) : 128000;
  const modelMaxTokens = Number(model.maxTokens) > 0 ? Number(model.maxTokens) : 16384;

  // Model routing: either a custom provider route (baseURL + api) or the
  // borrowed catalog table from the source profile (legacy / magpie).
  let patch = '';
  let effProvider = model.provider;
  const custom = model && model.baseURL && model.api;

  if (custom) {
    // A hand-declared route needs api + baseURL + a non-empty models list, and
    // a credential reference (apiKeyEnv) resolved from the launching env.
    effProvider = String(model.provider || `bot-${profile}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `bot-${profile}`;
    const apiKeyEnv = model.apiKeyEnv || 'BOT_MODEL_API_KEY';
    patch += `
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ${effProvider}:
        displayName: ${JSON.stringify('Bot ' + profile)}
        apiKeyEnv: ${apiKeyEnv}
        api: ${model.api}
        baseURL: ${JSON.stringify(model.baseURL)}
        models:
          - id: ${JSON.stringify(model.model)}
            name: ${JSON.stringify(model.model)}
            contextWindow: ${modelContextWindow}
            maxTokens: ${modelMaxTokens}
            input: [text]
`;
  } else {
    const providerBlock = readProviderBlock(sourceProfile);
    if (!providerBlock) {
      throw new Error(
        `cannot read provider table from profile "${sourceProfile}" (${profilePatchPath(sourceProfile)}).`,
      );
    }
    patch = providerBlock;
  }

  // model default
  patch += `
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ${effProvider}
    model: ${model.model}
`;

  // permission preset
  patch += `
- id: permission-presets
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: ${perm}
`;

  // Auto-compaction. dsh-base mounts compaction-basic with auto=true; here we
  // only restate the knobs we expose (config rows REPLACE wholesale, so all
  // keys we care about are listed). thresholdRatio triggers a summary at
  // min(W*ratio, W - reservedCompletion - headroom) estimated tokens.
  const cmp = compaction || {};
  const ratio = Number(cmp.thresholdRatio);
  const headroom = Number(cmp.headroomTokens);
  const retain = Number(cmp.retainRatio);
  patch += `
- id: compaction-basic
  config:
    auto: ${cmp.enabled === false ? 'false' : 'true'}
    thresholdRatio: ${ratio > 0 && ratio < 1 ? ratio : 0.8}
    headroomTokens: ${headroom >= 0 ? headroom : 65536}
    retainRatio: ${retain > 0 && retain < 1 ? retain : 0.16}
`;

  // system prompt (custom bot instructions). Restate fields we rely on.
  if (prompt && String(prompt).trim()) {
    patch += `
- id: system-prompt
  config:
    includeHarnessIdentity: true
    includeRuntimeContext: true
    personaPrefix: ${yamlQuote(String(prompt).trim())}
`;
  }

  // sandbox boundary: literal absolute roots (no CLI --add-dir grants are used).
  if (wroot) {
    const rootsYaml = extras.length ? '\n' + extras.map((d) => `      - ${JSON.stringify(d)}`).join('\n') : ' []';
    patch += `
- id: sandbox-policy
  inject: [headlessStartup]
  config:
    mode: ${perm === 'read-only' ? 'read-only' : perm === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'}
    workspaceRoot: ${JSON.stringify(wroot)}
    additionalWritableRoots:${rootsYaml}
`;
  }

  // Last-good + atomicity: everything above built the string in memory; the
  // only disk mutation is this one tmp+rename (a throw above never touched
  // the previous file).
  const target = profilePatchPath(profile);
  atomicWrite(target, patch);
  return { profile, path: target, model: { ...model, provider: effProvider }, permission: perm, prompt: !!prompt, writableDirs: extras, workspaceRoot: wroot, customProvider: !!custom };
}

// Remove a bot's profile directory (used on delete). 前身 shelled out to
// `rm -rf`; node's rmSync does the same job without the subprocess.
export function removeProfile(profile) {
  try {
    const dir = join(profileHome(), 'profiles', profile);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return true;
    }
  } catch {}
  return false;
}
