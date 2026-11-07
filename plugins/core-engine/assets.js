// Asset registry (DESIGN-ASSETS rev.2 §2/§4/§8): the data/assets.json
// registry — load/save with the bots.json discipline (atomicWrite, 0600) —
// plus the five-type content schema validation (§4 red lines), the
// position-based masking of mcp secrets (§8.1), plan building for the
// materialization pipeline (§2.2/§2.3/§6), and the bind/unbind operations
// with the §2.3 conflict-matrix chain.
//
// The materialization pipeline itself is W3 T2: everything here talks to an
// injectable `materializer` interface (state.materializer). T1 ships the noop
// implementation — every materialize/removeAssets call answers the skipped
// receipt { writes: [], skipped: 'not-equipped' } and the bind-time detection
// hooks (foreign-target guard, cross-bot file conflicts, provider support)
// return empty/known-policy answers — so the API surface is complete and
// testable end to end; T2 swaps in the real provider-port pipeline without
// touching this file's contracts.
import { atomicWrite, readJson } from '../../src/kernel/config.js';
import { saveBots } from './bots.js';

export const ASSET_TYPES = ['skill', 'memory', 'mcp', 'prompt', 'tool'];
export const MASKED_ECHO = '__MASKED__';

// §4.0: one slug rule for asset names, skill names and mcp serverIds —
// `.` is banned (TOML table nesting / file-extension ambiguity), so is any
// path separator (the path-escape root defense, §8.3).
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_|~A-Za-z0-9-]+$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// C0/C1 control characters except \n \r \t (§4.0). NUL is inside C0.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/;

const KB = 1024;
const LIMITS = {
  description: 200,        // asset-level description (§2.1)
  skillDescription: 1536,  // F14 truncation line
  body: 60 * KB,
  text: 8 * KB,
  notes: 50,
  note: 2 * KB,
  content: 64 * KB,
  servers: 16,
  args: 32,
  arg: 512,
  extraHints: KB,
};

const TYPE_LABEL = { skill: '技能', memory: '记忆', mcp: 'MCP', prompt: '提示词', tool: '工具' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (status, message, errors) => {
  const err = new Error(message);
  err.status = status;
  if (Array.isArray(errors)) err.errors = errors;
  return err;
};

// —— registry persistence (§2.1; discipline identical to bots.js) ——————————

export function loadAssets(file) {
  const doc = readJson(file);
  if (isObject(doc) && Array.isArray(doc.assets)) return { assets: doc.assets };
  return { assets: [] };
}

export function saveAssets(file, doc) {
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
}

export function newAssetId(existingIds = []) {
  const taken = new Set(existingIds);
  for (;;) {
    const id = `ast-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

// —— validation (§4): field-level errors, reject over silent correction ————

const checkText = (value, where, { max, required = false, label = '' } = {}, errors = []) => {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${where} is required`);
    return errors;
  }
  if (typeof value !== 'string') {
    errors.push(`${where} must be a string`);
    return errors;
  }
  if (CONTROL_CHARS.test(value)) {
    errors.push(`${where} 含控制字符（仅允许 \\n \\r \\t）`);
    return errors;
  }
  if (max !== undefined && value.length > max) {
    errors.push(`${where} 太长（${label ? `${label}≤` : '≤'}${max} 字符）`);
  }
  return errors;
};

const checkSlug = (value, where, errors = []) => {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    errors.push(`${where} 必须符合命名规则 ^[a-z0-9][a-z0-9-]{0,63}$（小写字母/数字开头，可含连字符，禁点号与路径分隔符）：${JSON.stringify(value)}`);
  }
  return errors;
};

// Proto-pollution keys at any depth of content (§4.0). JSON.parse CAN create
// own "__proto__" keys, so this walk is a real red line, not paranoia.
const checkProtoKeys = (value, where, errors = []) => {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkProtoKeys(v, `${where}[${i}]`, errors));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (PROTO_KEYS.has(k)) errors.push(`${where}.${k} 禁止（原型污染键）`);
      else checkProtoKeys(v, `${where}.${k}`, errors);
    }
  }
  return errors;
};

const validateMcpServers = (servers, errors) => {
  if (!isObject(servers)) {
    errors.push('content.servers must be a JSON object');
    return;
  }
  const ids = Object.keys(servers);
  if (ids.length === 0) errors.push('content.servers 至少需要一个 server');
  if (ids.length > LIMITS.servers) errors.push(`content.servers 个数超限（≤${LIMITS.servers}，实际 ${ids.length}）`);
  for (const [serverId, server] of Object.entries(servers)) {
    checkSlug(serverId, `content.servers.${serverId}（serverId）`, errors);
    if (!isObject(server)) {
      errors.push(`content.servers.${serverId} must be a JSON object`);
      continue;
    }
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    const type = server.type;
    if (type === 'sse' || type === 'ws') {
      errors.push(`content.servers.${serverId}.type：v1 仅支持 stdio/http 形态 MCP server（收到 ${JSON.stringify(type)}）`);
      continue;
    }
    // 恰一形态 (§4.2): stdio {command…} | http {type:'http', url…}; mixed or
    // neither is rejected; url WITHOUT type is the F13 config-error shape.
    if (hasCommand && hasUrl) {
      errors.push(`content.servers.${serverId} 只能为 stdio 或 http 之一（同时给出 command 与 url）`);
      continue;
    }
    if (hasCommand) {
      if (type !== undefined) errors.push(`content.servers.${serverId}：stdio 形态不接受 type 字段`);
      rejectUnknownKeys(server, `content.servers.${serverId}`, MCP_STDIO_KEYS, 'stdio 形态仅接受 command/args/env', errors);
      checkText(server.command, `content.servers.${serverId}.command`, { required: true }, errors);
      if (server.args !== undefined) {
        if (!Array.isArray(server.args)) errors.push(`content.servers.${serverId}.args must be a list`);
        else {
          if (server.args.length > LIMITS.args) errors.push(`content.servers.${serverId}.args 超限（≤${LIMITS.args} 项）`);
          server.args.forEach((a, i) => checkText(a, `content.servers.${serverId}.args[${i}]`, { max: LIMITS.arg }, errors));
        }
      }
      if (server.env !== undefined) validateEnv(server.env, `content.servers.${serverId}.env`, errors);
    } else if (hasUrl || type !== undefined) {
      if (type !== 'http') {
        errors.push(`content.servers.${serverId}：url 形态必须声明 type:'http'（url 而无 type 是配置错误）`);
        continue;
      }
      rejectUnknownKeys(server, `content.servers.${serverId}`, MCP_HTTP_KEYS, 'http 形态仅接受 type/url/headers', errors);
      let u = null;
      if (typeof server.url !== 'string') errors.push(`content.servers.${serverId}.url must be a string`);
      else {
        try { u = new URL(server.url); } catch { errors.push(`content.servers.${serverId}.url 不是合法 URL`); }
      }
      if (u != null) {
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          errors.push(`content.servers.${serverId}.url 必须是 http(s) URL`);
        }
        // P1-5: embedded credentials in the URL are refused — secrets belong
        // in env/headers, never in a URL that lands in logs and process lists.
        if (u.username !== '' || u.password !== '') {
          errors.push(`content.servers.${serverId}.url：URL 内嵌凭据不允许：凭据走 env/headers`);
        }
      }
      if (server.headers !== undefined) {
        if (!isObject(server.headers)) errors.push(`content.servers.${serverId}.headers must be a JSON object`);
        else {
          for (const [h, v] of Object.entries(server.headers)) {
            if (!HEADER_NAME.test(h)) errors.push(`content.servers.${serverId}.headers：非法 header 名 ${JSON.stringify(h)}`);
            if (typeof v !== 'string') errors.push(`content.servers.${serverId}.headers.${h} must be a string`);
            else if (CONTROL_CHARS.test(v)) errors.push(`content.servers.${serverId}.headers.${h} 含控制字符`);
          }
        }
      }
    } else {
      errors.push(`content.servers.${serverId} 只能为 stdio（command/args/env）或 http（type/url/headers）之一`);
    }
  }
};

// Closed content schemas (W3 T1 review): each type accepts exactly the keys
// below — an unrecognized key is data every materializer would silently drop,
// so reject it at the registry door (拒绝优于静默纠正). mcp additionally
// closes each server object per form, and tool closes options per kind.
const CONTENT_KEYS = {
  skill: ['name', 'description', 'body'],
  mcp: ['servers'],
  memory: ['notes'],
  prompt: ['text'],
  tool: ['kind', 'options'],
};
const MCP_STDIO_KEYS = ['command', 'args', 'env', 'type']; // type listed so stdio+type keeps its dedicated copy
const MCP_HTTP_KEYS = ['type', 'url', 'headers'];

const rejectUnknownKeys = (obj, where, allowed, note, errors = []) => {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}.${key}：unexpected key（${note}）`);
  }
  return errors;
};

const validateEnv = (env, where, errors) => {
  if (!isObject(env)) {
    errors.push(`${where} must be a JSON object`);
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k)) errors.push(`${where}.${k} 键名必须匹配 ^[A-Z_][A-Z0-9_]*$`);
    if (typeof v !== 'string' || v === '') errors.push(`${where}.${k} 必须是非空字符串`);
    else if (CONTROL_CHARS.test(v)) errors.push(`${where}.${k} 含控制字符`);
  }
};

const validateContent = (type, content, errors) => {
  if (!isObject(content)) {
    errors.push('content must be a JSON object');
    return;
  }
  checkProtoKeys(content, 'content', errors);
  const size = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (size > LIMITS.content) errors.push(`content 超过 64KB 上限（实际 ${Math.round(size / KB)}KB）`);
  const allowedKeys = CONTENT_KEYS[type];
  if (allowedKeys !== undefined) {
    rejectUnknownKeys(content, 'content', allowedKeys, `${type} 仅接受 ${allowedKeys.join('/')}`, errors);
  }
  switch (type) {
    case 'skill':
      checkSlug(content.name, 'content.name（技能名）', errors);
      checkText(content.description, 'content.description', { max: LIMITS.skillDescription, label: '技能描述 ' }, errors);
      checkText(content.body, 'content.body', { required: true, max: LIMITS.body }, errors);
      break;
    case 'mcp':
      validateMcpServers(content.servers ?? {}, errors);
      break;
    case 'memory': {
      if (!Array.isArray(content.notes)) {
        errors.push('content.notes must be a list');
        break;
      }
      if (content.notes.length > LIMITS.notes) errors.push(`content.notes 条数超限（≤${LIMITS.notes}）`);
      content.notes.forEach((n, i) => checkText(n, `content.notes[${i}]`, { max: LIMITS.note, label: '每条 ' }, errors));
      break;
    }
    case 'prompt':
      checkText(content.text, 'content.text', { required: true, max: LIMITS.text }, errors);
      break;
    case 'tool': {
      if (content.kind !== 'rtk' && content.kind !== 'ripgrep') {
        errors.push('content.kind 必须是 rtk 或 ripgrep（白名单外 kind 拒绝）');
        break;
      }
      if (content.options !== undefined && !isObject(content.options)) {
        errors.push('content.options must be a JSON object');
        break;
      }
      if (content.kind === 'rtk' && content.options !== undefined && Object.keys(content.options).length > 0) {
        errors.push('content.options：rtk v1 仅接受空 options 占位（edition 等后期扩展）');
      }
      if (content.kind === 'ripgrep' && isObject(content.options)) {
        rejectUnknownKeys(content.options, 'content.options', ['extraHints'], 'ripgrep 仅接受 extraHints', errors);
        checkText(content.options.extraHints, 'content.options.extraHints', { max: LIMITS.extraHints }, errors);
      }
      break;
    }
    default:
      break; // bad type already reported at the top level
  }
};

// validateAsset(asset, {others}) — `others` is the rest of the registry, for
// the (type,name) uniqueness red line. Returns a field-level error array in
// the validateBot style; the API turns it into a 400 carrying `errors`.
export function validateAsset(asset, { others = [] } = {}) {
  if (!isObject(asset)) return ['asset must be a plain object'];
  const errors = [];
  if (!ASSET_TYPES.includes(asset.type)) errors.push(`type must be one of ${ASSET_TYPES.join(', ')}`);
  checkSlug(asset.name, 'name', errors);
  checkText(asset.description, 'description', { max: LIMITS.description }, errors);
  validateContent(asset.type, asset.content, errors);
  if (errors.length === 0) {
    for (const other of others) {
      if (isObject(other) && other !== asset && other.type === asset.type && other.name === asset.name) {
        errors.push(`同名资产已存在：${asset.type}/${asset.name}（类型内唯一，重名请换名）`);
        break;
      }
    }
  }
  return errors;
}

// —— position-based masking (§8.1 P1) ————————————————————————————————————

// Mask ALL values under servers.*.env.* and servers.*.headers.* — the key
// name is irrelevant (a secret can hide under any header name); this is the
// position rule, SENSITIVE_KEY name matching stays a supplement at best.
const maskContentByPosition = (content) => {
  if (!isObject(content) || !isObject(content.servers)) return content;
  const out = structuredClone(content);
  for (const server of Object.values(out.servers)) {
    if (!isObject(server)) continue;
    for (const section of ['env', 'headers']) {
      if (isObject(server[section])) {
        for (const k of Object.keys(server[section])) server[section][k] = MASKED_ECHO;
      }
    }
  }
  return out;
};

// Public echo of one asset: deep clone + position-masked content. Never
// returns the live registry object.
export function maskAsset(asset) {
  const out = structuredClone(asset);
  if (out.type === 'mcp') out.content = maskContentByPosition(out.content);
  return out;
}

// PATCH round-trip (§8.1): a masked echo sent back carries '__MASKED__' at
// positions the caller never edited — restore the stored value AT THOSE
// POSITIONS ONLY. Absent keys are deliberate removals, EXCEPT keys the
// response pipeline strips by NAME (sendJson sanitize drops `secret` and
// *apikey* keys at any depth): the client never saw those, so their absence
// is "never saw", not "delete" — backfill them, the same trade-off
// mergePreserving makes for bot secrets (replaced yes, silently erased no;
// strip-shaped names are not erasable via round-trip). Scope: mcp content
// (the only masked surface; fixed-key contents elsewhere never trip the
// name rule).
const sanitizeDropsKey = (k) => k === 'secret' || /apikey/i.test(k);

export function restoreMaskedContent(patchContent, oldContent, type) {
  if (type !== 'mcp' || !isObject(patchContent) || !isObject(oldContent)) return patchContent;
  const oldServers = isObject(oldContent.servers) ? oldContent.servers : {};
  const servers = {};
  const patchServers = isObject(patchContent.servers) ? patchContent.servers : {};
  for (const [serverId, server] of Object.entries(patchServers)) {
    if (!isObject(server)) { servers[serverId] = server; continue; }
    const oldServer = isObject(oldServers[serverId]) ? oldServers[serverId] : {};
    const fixed = { ...server };
    for (const section of ['env', 'headers']) {
      if (!isObject(server[section])) continue;
      const restored = {};
      for (const [k, v] of Object.entries(server[section])) {
        restored[k] = v === MASKED_ECHO && isObject(oldServer[section]) && oldServer[section][k] !== undefined
          ? oldServer[section][k]
          : v;
      }
      if (isObject(oldServer[section])) {
        for (const [k, v] of Object.entries(oldServer[section])) {
          if (!(k in restored) && sanitizeDropsKey(k)) restored[k] = v;
        }
      }
      fixed[section] = restored;
    }
    servers[serverId] = fixed;
  }
  for (const [serverId, server] of Object.entries(oldServers)) {
    if (!(serverId in servers) && sanitizeDropsKey(serverId)) servers[serverId] = server;
  }
  return { ...patchContent, servers };
}

// —— bindings → effective plan (§2.2/§2.3/§6) ———————————————————————————

// Resolve ONE binding to its effective entry: exclusive bindings carry their
// own snapshot (which outlives a deleted source asset — §3.2 DELETE row);
// shared bindings resolve against the live registry and drop out if the
// asset is gone (DELETE removes those bindings, so this is drift defense).
export function resolveBinding(assets, binding) {
  if (!isObject(binding)) return null;
  const asset = (Array.isArray(assets) ? assets : []).find((a) => isObject(a) && a.id === binding.assetId);
  if (binding.mode === 'exclusive') {
    if (!isObject(binding.snapshot)) return null;
    return {
      assetId: binding.assetId,
      type: binding.snapshotType ?? asset?.type ?? null,
      name: binding.snapshotName ?? asset?.name ?? null,
      mode: 'exclusive',
      content: binding.snapshot,
      origin: asset?.origin ?? null,
      version: asset?.version ?? binding.snapshotVersion ?? null,
      sourceDeleted: asset == null,
    };
  }
  if (asset == null) return null;
  return {
    assetId: asset.id, type: asset.type, name: asset.name, mode: 'shared',
    content: asset.content, origin: asset.origin ?? 'operator', version: asset.version, sourceDeleted: false,
  };
}

// buildPlan: bindings (order = 生效顺序) → {plan, suppressed}. Suppression
// (§2.3 row 2): within a (type,name) group, an exclusive entry shadows every
// shared entry — shadowed shared bindings stay in bots.json but never reach
// the materialization plan.
export function buildPlan(assets, bot) {
  const resolved = (Array.isArray(bot?.assets) ? bot.assets : [])
    .map((b) => resolveBinding(assets, b))
    .filter((e) => e != null);
  const groups = new Map();
  for (const entry of resolved) {
    const key = `${entry.type}\u0000${entry.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const suppressed = [];
  const shadowed = new Set();
  for (const entries of groups.values()) {
    if (!entries.some((e) => e.mode === 'exclusive')) continue;
    for (const e of entries) {
      if (e.mode === 'shared') shadowed.add(e);
    }
  }
  const plan = [];
  for (const entry of resolved) {
    if (shadowed.has(entry)) {
      suppressed.push({ assetId: entry.assetId, name: entry.name, type: entry.type });
      continue;
    }
    plan.push({ assetId: entry.assetId, type: entry.type, name: entry.name, mode: entry.mode, content: entry.content });
  }
  return { plan, suppressed };
}

// §2.2 binding summary for bot echoes: never content; exclusive adds the
// behind-version counter (§6) and deleted-source flag (§3.2 DELETE row).
export function bindingSummary(assets, bot) {
  return (Array.isArray(bot?.assets) ? bot.assets : [])
    .map((b) => resolveBinding(assets, b))
    .filter((e) => e != null)
    .map((e) => {
      const row = { assetId: e.assetId, name: e.name, type: e.type, mode: e.mode, origin: e.origin };
      if (e.mode === 'exclusive') {
        const snap = bot.assets.find((x) => x?.assetId === e.assetId);
        row.exclusiveBehind = e.sourceDeleted ? null : Math.max(0, (e.version ?? 0) - (snap?.snapshotVersion ?? 0));
        row.snapshotVersion = snap?.snapshotVersion ?? null;
        row.snapshotAt = snap?.snapshotAt ?? null;
        if (e.sourceDeleted) row.sourceDeleted = true;
      }
      return row;
    });
}

// —— §2.3 conflict matrix (bind-time, on the PROJECTED binding set) ———————

export function checkBindConflicts(assets, bindings) {
  const errors = [];
  const resolved = bindings.map((b) => resolveBinding(assets, b)).filter((e) => e != null);
  // 同 (type,name) 多条 shared → 拒绑 (row 1). exclusive shadowing is legal
  // (row 2) — only shared-on-shared duplicates refuse.
  const sharedGroups = new Map();
  for (const e of resolved) {
    if (e.mode !== 'shared') continue;
    const key = `${e.type}\u0000${e.name}`;
    if (sharedGroups.has(key)) {
      errors.push(`同名${TYPE_LABEL[e.type] ?? e.type}已配发，先卸载或改私发：${e.name}`);
    } else sharedGroups.set(key, e);
  }
  // 两个 mcp 资产含同 serverId → 拒绑，指名冲突 server（物化名 wao-<serverId>，
  // §3.3）。Shadowed shared entries are inert — exclude them first.
  const { plan } = buildPlan(assets, { assets: bindings });
  const serverOwner = new Map();
  for (const entry of plan) {
    if (entry.type !== 'mcp' || !isObject(entry.content?.servers)) continue;
    for (const serverId of Object.keys(entry.content.servers)) {
      if (serverOwner.has(serverId)) {
        errors.push(`MCP server 冲突：${serverId}（物化名 wao-${serverId}）已由资产 ${serverOwner.get(serverId)} 配发，请先解绑或移除该 server`);
      } else serverOwner.set(serverId, entry.name);
    }
  }
  return errors;
}

// —— noop materializer (T1 stand-in; T2 = real provider pipeline) ——————————

// The injectable interface consumed by bind/unbind/patch/delete/rematerialize:
//   checkBind(bot, asset, projectedBindings) → string[] (400 rejections:
//     provider×type support matrix — dsh has no MCP face (F23), rtk is not
//     dsh-supported (F27) and hard-requires a dedicated config dir (§7.1))
//   detectForeignTargets(bot, plan) → [{path}]  (skill 外来守卫, P1-13 — T2
//     reads the target files; noop answers none)
//   detectFileConflicts(bot, plan, allBots) → [{botId, path}] (跨 bot 同文件
//     拒绑, §2.3 last row — T2 diffs materialization manifests, §3.8)
//   memoryWarning(bot) → string|null (§7.3 shared-cwd visibility warning)
//   materialize(bot, plan) → {writes, notes?} | {writes: [], skipped} — a
//     throw becomes the per-bot failed[] entry (§3.2 isolation)
//   removeAssets(bot) → {removed} | skipped shape (bot DELETE best-effort)
export function noopMaterializer() {
  const dedicatedDirOf = (bot) => {
    const pc = isObject(bot?.providerConfig) ? bot.providerConfig : {};
    return ['claudeConfigDir', 'codexHome', 'piAgentDir'].find((k) => typeof pc[k] === 'string' && pc[k] !== '');
  };
  return {
    checkBind(bot, asset) {
      const errors = [];
      const provider = bot?.provider;
      if (provider === 'dsh' && asset?.type === 'mcp') {
        errors.push('dsh 岗位不支持 MCP 资产（dsh 无 MCP 面）');
      }
      if (provider === 'dsh' && asset?.type === 'tool' && asset?.content?.kind === 'rtk') {
        errors.push('dsh 岗位不支持 rtk 工具资产（rtk 支持列表不含 dsh）');
      }
      if (asset?.type === 'tool' && asset?.content?.kind === 'rtk' && provider !== 'dsh' && dedicatedDirOf(bot) === undefined) {
        errors.push('rtk 工具资产要求 bot 配置专属目录（claudeConfigDir/codexHome/piAgentDir 之一）——共享用户主目录绝不动用户自己的 settings/hooks');
      }
      return errors;
    },
    detectForeignTargets() { return []; },
    detectFileConflicts() { return []; },
    memoryWarning(bot) {
      if (bot?.provider === 'dsh') return null; // memory rides personaPrefix, not cwd files (§3.3)
      if (dedicatedDirOf(bot) !== undefined) return null;
      return '记忆落在共享 cwd，对同目录其他会话可见，建议配专属 config 目录（claudeConfigDir/codexHome/piAgentDir）';
    },
    async materialize() { return { writes: [], skipped: 'not-equipped' }; },
    async removeAssets() { return { removed: false, skipped: 'not-equipped' }; },
  };
}

// —— bind / unbind operations (§2.3 chain → §3.2 asset path) ————————————

const findBot = (state, botId) => state.doc.bots.find((b) => isObject(b) && b.id === botId) ?? null;
const findAsset = (state, assetId) => state.assetsDoc.assets.find((a) => isObject(a) && a.id === assetId) ?? null;

// Shared tail of every binding-affecting path: re-materialize the bot
// through the materializer (per-bot isolation — a throw lands in failed[],
// never blocks the others), then lightweight re-attach (runner table only;
// §3.2 — no drain, no adapter rebuild).
async function rematerializeBot(state, bot) {
  const { plan } = buildPlan(state.assetsDoc.assets, bot);
  try {
    const r = await state.materializer.materialize(bot, plan, { log: state.log });
    return { botId: bot.id, ok: true, writes: Array.isArray(r?.writes) ? r.writes : [], skipped: r?.skipped };
  } catch (err) {
    state.log?.warn?.(`core-engine: asset rematerialize failed for ${bot.id}: ${err?.message ?? err}`);
    return { botId: bot.id, ok: false, writes: [], error: err?.message ?? String(err) };
  }
}

const receiptOf = (results) => {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map(({ botId, error }) => ({ botId, error }));
  const writes = ok.flatMap((r) => r.writes);
  const skipped = ok.some((r) => r.skipped) && failed.length === 0 ? 'not-equipped' : undefined;
  return { rematerialized: ok.map((r) => r.botId), failed, writes, ...(skipped ? { skipped } : {}) };
};

// Fan-out tail shared by PATCH/DELETE asset ops (§3.2): every listed bot
// rematerializes NOW (eager), per-bot isolated — one bot's throw lands in
// failed[] and never blocks the others; successes get the lightweight runner
// refresh (§3.2 重 attach).
export async function rematerializeBots(state, bots) {
  const results = [];
  for (const bot of bots) {
    const r = await rematerializeBot(state, bot);
    results.push(r);
    // Runner follows REGISTRY truth — but only once the registry's plan has
    // actually landed on disk: refresh ONLY on success (same rule as
    // bindAsset/unbindAsset below), a failed bot keeps its last-good runner
    // and retries through rematerialize.
    if (r.ok) state.refreshRunner?.(bot);
  }
  return receiptOf(results);
}

export async function bindAsset(state, botId, { assetId, mode } = {}) {
  const bot = findBot(state, botId);
  if (bot == null) throw fail(404, 'bot not found');
  const asset = findAsset(state, assetId);
  if (asset == null) throw fail(404, 'asset not found');
  if (mode !== 'shared' && mode !== 'exclusive') throw fail(400, 'mode 必须是 shared（配发）或 exclusive（私发）');
  const bindings = Array.isArray(bot.assets) ? bot.assets : [];
  if (bindings.some((b) => isObject(b) && b.assetId === assetId)) {
    throw fail(400, `资产 ${assetId}（${asset.name}）已绑定到该 bot，请先解绑`);
  }
  // §8.1 MCP 写面分级兜底: Agent-created assets are exclusive-only (their
  // blast radius stays pinned to single-bot snapshots).
  if (asset.origin === 'mcp' && mode !== 'exclusive') {
    throw fail(400, 'Agent 创建的资产仅可私发（exclusive）绑定');
  }
  const binding = { assetId, mode };
  if (mode === 'exclusive') {
    binding.snapshot = structuredClone(asset.content);
    binding.snapshotVersion = asset.version;
    binding.snapshotAt = Date.now();
    binding.snapshotType = asset.type;
    binding.snapshotName = asset.name;
  }
  const projected = [...bindings, binding];
  // §2.3 conflict matrix over the resulting effective set.
  const matrix = checkBindConflicts(state.assetsDoc.assets, projected);
  if (matrix.length > 0) throw fail(400, matrix.join('; '), matrix);
  // Materializer bind hooks: provider×type support, skill foreign-target
  // guard, cross-bot same-file conflict (T2 wires the file/manifest reads).
  const supportErrors = state.materializer.checkBind(bot, asset, projected);
  if (supportErrors.length > 0) throw fail(400, supportErrors.join('; '), supportErrors);
  const { plan } = buildPlan(state.assetsDoc.assets, { assets: projected });
  for (const foreign of state.materializer.detectForeignTargets(bot, plan)) {
    throw fail(400, `目标已有非 WAO 技能：${foreign.path}；请改资产名或先移除该技能`);
  }
  for (const conflict of state.materializer.detectFileConflicts(bot, plan, state.doc.bots)) {
    throw fail(400, `与 bot ${conflict.botId} 的资产目标文件冲突：${conflict.path}；同目录 bot 请改用专属 config 目录或先解绑`);
  }
  // Commit: binding into the bot record (bots.json is the binding store, §2.2).
  bot.assets = projected;
  saveBots(state.botsFile, state.doc);
  // §3.2 asset path: materialize → receipt (per-bot isolation). The runner
  // follows REGISTRY truth, but only once the registry's plan has actually
  // landed on disk — refresh ONLY on success (unified with rematerializeBots);
  // a failed materialize keeps the last-good runner and retries through the
  // rematerialize endpoint, which refreshes on its own success.
  const result = await rematerializeBot(state, bot);
  if (result.ok) state.refreshRunner?.(bot);
  const receipt = receiptOf([result]);
  const warnings = [];
  if (asset.type === 'memory') {
    const w = state.materializer.memoryWarning?.(bot);
    if (w) warnings.push(w);
  }
  const { suppressed } = buildPlan(state.assetsDoc.assets, bot);
  return {
    ok: true,
    binding: { assetId, mode, name: asset.name, type: asset.type, origin: asset.origin ?? 'operator' },
    ...receipt,
    warnings,
    ...(suppressed.length > 0 ? { suppressed, suppressedNote: '被私发副本压制（同名单资产存在私发副本，配发条目暂不生效）' } : {}),
  };
}

export async function unbindAsset(state, botId, assetId) {
  const bot = findBot(state, botId);
  if (bot == null) throw fail(404, 'bot not found');
  const bindings = Array.isArray(bot.assets) ? bot.assets : [];
  const index = bindings.findIndex((b) => isObject(b) && b.assetId === assetId);
  if (index < 0) throw fail(404, `资产 ${assetId} 未绑定到 bot ${botId}`);
  const [removedBinding] = bindings.splice(index, 1);
  bot.assets = bindings;
  saveBots(state.botsFile, state.doc);
  // Same registry-truth rule as bindAsset: refresh only when the cleanup
  // rematerialize actually succeeded.
  const result = await rematerializeBot(state, bot);
  if (result.ok) state.refreshRunner?.(bot);
  const receipt = receiptOf([result]);
  const source = findAsset(state, assetId);
  return {
    ok: true,
    removed: {
      assetId,
      mode: removedBinding.mode,
      name: removedBinding.snapshotName ?? source?.name ?? null,
      type: removedBinding.snapshotType ?? source?.type ?? null,
      // §8.1 unbind consequence copy: the exclusive copy's content dies here.
      exclusiveContentLost: removedBinding.mode === 'exclusive',
    },
    ...receipt,
  };
}
