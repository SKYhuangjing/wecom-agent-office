// Child-process env hygiene (security audit P0-2): the parent WAO process
// holds WAO_TOKEN (the MCP-gateway auth the console presents) and possibly
// other operator secrets (model API keys, service passwords) in its own env.
// Agent CLIs spawned for bots run third-party model output — a prompt-injected
// agent could otherwise read WAO_TOKEN from its own environment and drive the
// company API with full operator rights. Every spawn of an agent CLI / vendor
// tool goes through childEnv(): parent env minus auth-shaped keys, plus the
// caller's explicit extras (provider apiKeyEnv values the bot itself needs).
//
// MAGPIE_GATEWAY_KEY is whitelisted on purpose: when present it is the shared
// secret the dsh/pod model gateway itself demands — stripping it would break
// every gateway-routed bot, and it does not open the WAO API.

// Key shapes that never cross into a child: *TOKEN / *SECRET / *API_KEY /
// *APIKEY / *PASSWORD / anything CREDENTIAL-ish. Suffix match — a prefix
// match would strip e.g. TOKENS_DIR-style paths that carry no secret.
const STRIP = [/TOKEN$/i, /SECRET$/i, /API_?KEY$/i, /PASSWORD$/i, /CREDENTIAL/i];
const KEEP = new Set(['MAGPIE_GATEWAY_KEY']); // gateway auth, not WAO auth (see header)

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.has(k) || !STRIP.some((re) => re.test(k))) env[k] = v;
  }
  return { ...env, ...extra };
}
