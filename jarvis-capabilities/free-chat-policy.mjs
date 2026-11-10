/**
 * Free-only conversation guard. Uses the provider clients that the JARVIS
 * server already registered from JARVIS_PROVIDER_1..10 or legacy GROQ_API_KEY.
 * Merely having a credential is NOT proof of free billing.
 *
 * Explicitly approve exact provider+model pairs only after checking that
 * individual provider account's pricing and billing state. Fail closed if
 * the list is missing, misformatted, or the endpoint is unexpected.
 */
export const FREE_CHAT_DAILY_LIMIT = 8;
export const FREE_CHAT_MAX_INPUT = 700;
export const FREE_CHAT_MAX_OUTPUT_TOKENS = 384;

// No provider is approved by default. A provider's name alone cannot attest
// that its configured model or billing plan is free of charge.
const ENDPOINT_HOSTS = Object.freeze({
  "huggingface": ["router.huggingface.co", "api-inference.huggingface.co"],
  "hugging face": ["router.huggingface.co", "api-inference.huggingface.co"],
  "nvidia": ["integrate.api.nvidia.com"],
  "zai": ["api.z.ai", "open.bigmodel.cn"],
  "z.ai": ["api.z.ai", "open.bigmodel.cn"],
  "openrouter": ["openrouter.ai"],
  "cloudflare": ["api.cloudflare.com"],
  "groq": ["api.groq.com"],
  "gemini": ["generativelanguage.googleapis.com"],
  "google gemini": ["generativelanguage.googleapis.com"],
});

const normalizeName = (x) => String(x || "").trim().toLowerCase();

export function approvedFreeChatProviders(env = {}, configuredProviders = []) {
  const source = env.JARVIS_FREE_CHAT_APPROVED_MODELS_JSON;
  if (typeof source !== "string" || source.length > 5000) return [];
  let approved;
  try { approved = JSON.parse(source); } catch { return []; }
  if (!Array.isArray(approved) || approved.length < 1 || approved.length > 10) return [];
  if (!Array.isArray(configuredProviders)) return [];

  const allow = new Set();
  for (const pair of approved) {
    const name = normalizeName(pair?.provider);
    const model = pair?.model;
    if (!Object.hasOwn(ENDPOINT_HOSTS, name) ||
        typeof model !== "string" || model.length < 1 || model.length > 200 ||
        model.trim() !== model || !/^[a-zA-Z0-9@._:/+-]+$/.test(model) ||
        (name === "openrouter" && !model.endsWith(":free"))) {
      // One bad entry invalidates the entire approval list.
      return [];
    }
    allow.add(JSON.stringify([name, model]));
  }

  const matches = [];
  for (const provider of configuredProviders) {
    const name = normalizeName(provider?.name);
    const model = provider?.model;
    if (!allow.has(JSON.stringify([name, model]))) continue;
    if (!provider.client?.chat?.completions?.create) continue;
    const address = provider.client.baseURL;
    let host;
    try {
      const parsed = new URL(address);
      if (parsed.protocol !== "https:") continue;
      host = parsed.hostname.toLowerCase();
    } catch { continue; }
    if (!ENDPOINT_HOSTS[name]?.includes(host)) continue;
    // Exactly one matching active client per pair. No OpenAI paid API fallback.
    if (!matches.some((p) => p.name === provider.name && p.model === model)) {
      matches.push({ name: provider.name, model, client: provider.client });
    }
  }
  return matches;
}

export function freeChatPolicy(env = {}, configuredProviders = []) {
  const approved = approvedFreeChatProviders(env, configuredProviders);
  const enabled = env.JARVIS_FREE_CHAT_ENABLED === "true" &&
    env.JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN === "true" &&
    approved.length > 0;
  return {
    enabled,
    freeOnly: true,
    requiresExplicitModelApproval: true,
    model: enabled ? approved[0].model : "",
    providerCount: enabled ? approved.length : 0,
    providers: enabled
      ? approved.map((p) => ({ name: p.name, model: p.model }))
      : [],
    dailyLimit: FREE_CHAT_DAILY_LIMIT,
    maxInputChars: FREE_CHAT_MAX_INPUT,
    maxOutputTokens: FREE_CHAT_MAX_OUTPUT_TOKENS,
    noPaidFallback: true,
    noTools: true,
    noAutomaticActions: true,
    noPersistence: true,
    ...(!enabled ? { reason: "no_explicitly_approved_free_model" } : {}),
  };
}

/** One and only one approved provider per request, deterministic rotation. */
export function chooseFreeChatProvider(env, configuredProviders, reservedCount) {
  const p = freeChatPolicy(env, configuredProviders);
  if (!p.enabled || !Number.isInteger(reservedCount) || reservedCount < 1) return null;
  const safe = approvedFreeChatProviders(env, configuredProviders);
  return safe[(reservedCount - 1) % safe.length] || null;
}

export function validateFreeChatMessage(raw) {
  if (typeof raw !== "string" || raw.trim().length < 1 ||
      raw.length > FREE_CHAT_MAX_INPUT || raw.includes("\u0000")) {
    throw new TypeError("Mensagem inválida ou muito longa para o modo seguro.");
  }
  return raw.trim();
}

let tableReady = null;

export async function reserveFreeChatDailyQuota(pool, deviceId) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Banco indisponível.");
  if (typeof deviceId !== "string" ||
      !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(deviceId)) {
    throw new TypeError("Dispositivo inválido.");
  }
  if (!tableReady) {
    tableReady = pool.query(`CREATE TABLE IF NOT EXISTS jarvis_free_chat_daily (
      device_id TEXT NOT NULL,
      day_utc DATE NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, day_utc)
    )`).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  await tableReady;
  // Atomically reserve a quota slot in PostgreSQL before contacting a
  // provider. Failed requests still count, so there is no retry spending loop.
  const result = await pool.query(
    `INSERT INTO jarvis_free_chat_daily (device_id, day_utc, request_count)
     VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (device_id, day_utc)
     DO UPDATE SET request_count = jarvis_free_chat_daily.request_count + 1
       WHERE jarvis_free_chat_daily.request_count < $2
     RETURNING request_count`,
    [deviceId, FREE_CHAT_DAILY_LIMIT]
  );
  return {
    accepted: result.rowCount === 1,
    used: result.rowCount === 1 ? Number(result.rows[0].request_count) : FREE_CHAT_DAILY_LIMIT,
    limit: FREE_CHAT_DAILY_LIMIT,
  };
}
