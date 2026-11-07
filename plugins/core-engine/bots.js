// bots.json registry (DESIGN §2.6/§3): load/save + shape validation.
// The bot record is core-engine-owned data —
//   { id, name, enabled, channel, account, allowedUsers, provider, providerConfig }
// — and validation is field-level against the LIVE port schemas: an unknown
// channel/provider id is an error, never a guess.
import { atomicWrite, readJson } from '../../src/kernel/config.js';

// bot.id is a PATH SEGMENT everywhere the record lands on disk (data/ledger/
// <id>.jsonl, data/sessions/<id>.json, data/assets/<id>/manifest.json, the
// dsh profile dir wecom-<id>) — an id like '../..' turns bot DELETE into
// arbitrary-directory recursive rm. Slug shape only: alnum start, then
// alnum/_/-, ≤64 chars (security audit P0-1; the same constant is re-checked
// defensively at every join site that builds one of those paths).
export const BOT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Missing/corrupt file (first boot, pre-atomicWrite crash) → empty registry.
// Junk entries inside bots[] are NOT filtered here — revalidateAll exists to
// surface them (§2.4 shape drift), and callers skip non-objects defensively.
export function loadBots(file) {
  const doc = readJson(file);
  if (doc != null && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.bots)) {
    return { bots: doc.bots };
  }
  return { bots: [] };
}

export function saveBots(file, doc) {
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// Schema item shape (PLUGIN-DEV port contract):
//   { key, label, type: string|password|enum|bool|list|object, required, default, options? }
// `prefix` names the record block in messages ('account' / 'providerConfig').
// Missing optional fields are fine; present fields must match their declared
// type — reject over silently correcting.
export function validateSchema(schema, values, prefix = '') {
  const errors = [];
  if (!Array.isArray(schema)) return errors;
  const v = values != null && typeof values === 'object' && !Array.isArray(values) ? values : {};
  for (const item of schema) {
    if (item == null || typeof item !== 'object' || typeof item.key !== 'string' || item.key === '') continue;
    const where = prefix !== '' ? `${prefix}.${item.key}` : item.key;
    const value = v[item.key];
    if (value === undefined || value === null || value === '') {
      if (item.required === true) errors.push(`${where} is required`);
      continue;
    }
    switch (item.type) {
      case undefined: // schema omitted the type: presence + required only
      case 'string':
      case 'password':
        if (typeof value !== 'string') errors.push(`${where} must be a string`);
        break;
      case 'enum': {
        const options = Array.isArray(item.options) ? item.options : [];
        if (!options.includes(value)) errors.push(`${where} must be one of ${options.join(', ')}`);
        break;
      }
      case 'bool':
        if (typeof value !== 'boolean') errors.push(`${where} must be a boolean`);
        break;
      case 'list':
        if (!Array.isArray(value)) errors.push(`${where} must be a list`);
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) errors.push(`${where} must be an object`);
        break;
      default:
        errors.push(`${where} has unsupported schema type ${JSON.stringify(item.type)}`);
    }
  }
  return errors;
}

// Accepts the portRegistry maps (entries are {impl, owner} wrappers —
// getChannel/getProvider unwrap them, raw map access does not), plain
// registries of impls (tests, foreign registries), or Maps of bare impls.
const lookup = (reg, id) => {
  const entry = reg instanceof Map ? reg.get(id) : reg?.[id];
  if (entry != null && typeof entry === 'object' && entry.impl != null) return entry.impl;
  return entry;
};

// One pass surfaces ALL problems (same discipline as the loader's manifest
// validation): id/name presence, known channel/provider ids, the channel's
// accountSchema and the provider's configSchema field by field, and finally
// the provider port's semantic validate() — PLUGIN-DEV §8: validate 是权威
// 校验，its errors surface wherever validateBot runs (API 400s, attach refusal,
// boot revalidate). A throwing validate() becomes one error line, never a
// crashed validation; duplicate messages (schema + validate both flagging the
// same field) collapse.
export function validateBot(bot, { channels, providers } = {}) {
  if (bot == null || typeof bot !== 'object' || Array.isArray(bot)) return ['bot must be a plain object'];
  const errors = [];
  if (typeof bot.id !== 'string' || bot.id === '') errors.push('id is required');
  else if (!BOT_ID_RE.test(bot.id)) errors.push('bot id 仅限字母/数字/下划线/连字符（≤64 字符），且以字母或数字开头');
  if (typeof bot.name !== 'string' || bot.name === '') errors.push('name is required');
  // Blind-review P2-2: the editor caps name at 30 chars, but the API is the
  // authority — a curl'd 31-char name is rejected, not silently stored.
  else if (bot.name.length > 30) errors.push('name 太长（≤30 字）');
  const channel = lookup(channels, bot.channel);
  if (channel == null) errors.push(`unknown channel: ${JSON.stringify(bot.channel ?? null)}`);
  const provider = lookup(providers, bot.provider);
  if (provider == null) errors.push(`unknown provider: ${JSON.stringify(bot.provider ?? null)}`);
  if (channel != null) errors.push(...validateSchema(channel.accountSchema, bot.account, 'account'));
  if (provider != null) errors.push(...validateSchema(provider.configSchema, bot.providerConfig, 'providerConfig'));
  if (provider != null && typeof provider.validate === 'function') {
    let providerErrors;
    try {
      providerErrors = provider.validate(bot.providerConfig);
    } catch (err) {
      providerErrors = [`provider validate() threw: ${err?.message ?? err}`];
    }
    const list = Array.isArray(providerErrors) ? providerErrors : [providerErrors];
    for (const e of list) {
      if (typeof e !== 'string' || e === '' || errors.includes(e)) continue;
      // Providers routinely restate a required-field fact their own configSchema
      // already flagged, minus the record prefix ('cwd is required' vs the
      // schema pass's 'providerConfig.cwd is required'). The prefixed schema
      // message names the block AND the field — the more specific copy wins,
      // the bare restatement collapses.
      if (errors.some((x) => x.endsWith(`.${e}`))) continue;
      errors.push(e);
    }
  }
  return errors;
}

// Boot/upgrade sweep (§2.4 shape drift): split the registry into attachable
// vs needs-attention in one pass over the live registry.
export function revalidateAll(bots, reg) {
  const ok = [];
  const bad = [];
  for (const bot of Array.isArray(bots) ? bots : []) {
    const errors = validateBot(bot, { channels: reg?.channel, providers: reg?.provider });
    if (errors.length > 0) bad.push({ bot, errors });
    else ok.push(bot);
  }
  return { ok, bad };
}
