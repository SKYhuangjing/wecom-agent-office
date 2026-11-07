// Materialize a per-bot dsh profile (Task 18): port of the production-proven
// wecom-bots/lib/profiles.js. A bot profile is built from the shipped
// `headless` template profile, then its cordis.patch.yml is written with the
// provider table (borrowed or custom route), agent-default-model,
// permission-presets, compaction-basic, system-prompt personaPrefix,
// sandbox-policy (mode / workspaceRoot / additionalWritableRoots) and — W3 T6
// — one `mcp-<serverId>` row per bound MCP server (@deepseek-ai/dsh-mcp-
// client, transport stdio | streamable-http). Config rows REPLACE wholesale
// (never deep-merged), so every field needed is restated.
//
// Changes vs 前身 (both contractual, DESIGN §5 materializeConfig):
//   - the patch is written through atomicWrite (src/kernel/config.js tmp+
//     rename) — the same persistence discipline as every other office file
//     (import pattern follows plugins/core-engine/bots.js);
//   - last-good: the FULL patch string is built before any byte is written,
//     so a throw anywhere above leaves the previous file untouched, and the
//     error names the path it was working from.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from '../../src/kernel/config.js';

const PERM = new Set(['workspace-write', 'read-only', 'danger-full-access']);

// Single source for the dsh home (P1 跨平台): os.homedir(), NOT $HOME —
// under a Windows service (no HOME env) process.env.HOME is undefined and the
// old join(HOME || '', '.dsh') collapsed to a RELATIVE '.dsh', splitting the
// profile tree from materializer.js's jail roots (which use homedir()). On
// POSIX homedir() ≡ $HOME when set, so behavior there is unchanged.
function profileHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function profilePatchPath(profile) {
  return join(profileHome(), 'profiles', profile, 'cordis.patch.yml');
}

// Prepend a dir to env.PATH with the PLATFORM delimiter (P2 跨平台): a ':'
// literal would be a path character on Windows, not a separator.
export const withDirOnPath = (env, dir) => ({ ...env, PATH: `${dir}${delimiter}${env?.PATH || ''}` });

// Ensure the profile directory exists by bootstrapping it from the shipped
// headless default via the dsh CLI itself (spawnSync kept from 前身 — it is
// the only faithful way to lay down the full profile bundle).
export function ensureProfileExists(profile, { dshBin, nodeBin }) {
  const dir = join(profileHome(), 'profiles', profile);
  if (existsSync(join(dir, 'cordis.patch.yml'))) return { created: false, dir };
  const r = spawnSync(dshBin, ['--profile', profile, '--from-default-profile', 'headless', '--help'], {
    env: withDirOnPath(process.env, join(nodeBin, '..')),
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

// Plain YAML scalar key iff it starts alnum and carries only alnum/._-
// (env keys ^[A-Z_][A-Z0-9_]*$ and normal header names land bare, README
// style). HEADER_NAME admits indicator characters (! & * # | …) that are
// YAML tag/anchor/alias/comment/block indicators — those keys get quoted.
const yamlKey = (k) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);

// —— MCP asset rows (W3 T6) ———————————————————————————————————————————————————
// One profile row per plan server, in the @deepseek-ai/dsh-mcp-client shape
// (README + installed lib verified 2026-11-07):
//   - id: mcp-<serverId>
//     name: '@deepseek-ai/dsh-mcp-client'
//     config:
//       serverName: <serverId>          # /^[A-Za-z0-9_-]{1,32}$/ (SERVER_NAME_PATTERN)
//       transport: stdio | streamable-http
//       command/args/env (stdio) | url/headers (http)
// dsh-mcp-client has NO ${VAR} expansion of its own — env/headers values
// pass through VERBATIM (plaintext secrets ride the 0600 patch, like every
// other row). Empty args/env/headers sections are omitted (package defaults
// them to []/{}); keys sorted for the §3.5 determinism anchor. Values are
// JSON.stringify'd — a JSON string is a valid YAML double-quoted scalar, so
// \n \t " \ stay escaped on ONE physical line (a raw newline would corrupt
// the YAML mapping, the codex-TOML Critical-2 lesson in YAML form).
export function mcpClientRows(assetsPlan) {
  const out = [];
  for (const entry of Array.isArray(assetsPlan) ? assetsPlan : []) {
    if (entry?.type !== 'mcp') continue;
    const servers = entry.content?.servers;
    if (servers == null || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const serverId of Object.keys(servers).sort()) {
      const s = servers[serverId] ?? {};
      if (serverId.length > 32) {
        throw new Error(`serverId ${serverId} 超出 dsh-mcp-client serverName 上限 32 字符（SERVER_NAME_PATTERN ^[A-Za-z0-9_-]{1,32}$）——请缩短 serverId（拒绝优于静默失败：超长 serverName 会被 dsh 配置校验拒绝，MCP 工具静默不出现）`);
      }
      const isHttp = s.type === 'http';
      const lines = [
        `- id: mcp-${serverId}`,
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        `    serverName: ${serverId}`,
        `    transport: ${isHttp ? 'streamable-http' : 'stdio'}`,
      ];
      if (isHttp) {
        lines.push(`    url: ${JSON.stringify(String(s.url ?? ''))}`);
        const headers = Object.keys(s.headers ?? {}).sort();
        if (headers.length > 0) {
          lines.push('    headers:');
          for (const h of headers) lines.push(`      ${yamlKey(h)}: ${JSON.stringify(String(s.headers[h]))}`);
        }
      } else {
        lines.push(`    command: ${JSON.stringify(String(s.command ?? ''))}`);
        if (Array.isArray(s.args) && s.args.length > 0) {
          lines.push(`    args: [${s.args.map((a) => JSON.stringify(String(a))).join(', ')}]`);
        }
        const env = Object.keys(s.env ?? {}).sort();
        if (env.length > 0) {
          lines.push('    env:');
          for (const k of env) lines.push(`      ${yamlKey(k)}: ${JSON.stringify(String(s.env[k]))}`);
        }
      }
      out.push(lines.join('\n'));
    }
  }
  return out.length === 0 ? '' : `${out.join('\n\n')}\n`;
}

export function buildBotPatch({
  profile,
  model,
  permission,
  prompt,
  writableDirs,
  workspaceRoot,
  sourceProfile = 'headless',
  compaction,
  assetsPlan,
}) {
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

  // MCP asset rows (W3 T6) ride the SAME whole-file rebuild: patch rows
  // REPLACE wholesale, so a providerConfig change that went through a
  // DIFFERENT builder would silently drop them — materializeConfig passes
  // the effective plan as assetsPlan for exactly this reason (P0-4 同型).
  const mcpRows = mcpClientRows(assetsPlan);
  if (mcpRows !== '') patch += `\n${mcpRows}`;

  // Last-good + atomicity: everything above built the string in memory; the
  // caller's only disk mutation is one tmp+rename (a throw above never touched
  // the previous file).
  return patch;
}

// writeBotProfile = profile bootstrap + pure patch build + one atomic write.
// The pure builder (buildBotPatch) is also the asset-pipeline's planning core:
// provider-dsh's materializeAssets composes the FULL personaPrefix (operator
// prompt + asset sections, §3.3 单一组合器) and rebuilds the whole patch here.
export function writeBotProfile(opts) {
  ensureProfileExists(opts.profile, { dshBin: opts.dshBin, nodeBin: opts.nodeBin });
  const patch = buildBotPatch(opts);
  const target = profilePatchPath(opts.profile);
  atomicWrite(target, patch);
  const model = opts.model && opts.model.model ? opts.model : { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' };
  const perm = PERM.has(opts.permission) ? opts.permission : 'workspace-write';
  const extras = Array.isArray(opts.writableDirs) ? opts.writableDirs.filter(Boolean) : [];
  return {
    profile: opts.profile,
    path: target,
    model: { ...model, provider: effProviderOf(opts) },
    permission: perm,
    prompt: !!opts.prompt,
    writableDirs: extras,
    workspaceRoot: opts.workspaceRoot || '',
    customProvider: !!(opts.model && opts.model.baseURL && opts.model.api),
  };
}

const effProviderOf = (opts) => {
  const model = opts.model && opts.model.model ? opts.model : { provider: 'magpie' };
  if (model && model.baseURL && model.api) {
    return String(model.provider || `bot-${opts.profile}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `bot-${opts.profile}`;
  }
  return model.provider;
};

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
