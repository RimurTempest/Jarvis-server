/**
 * Strict, default-off policy for first voice-to-AI experiments.
 * No search, memory writes, learned skills, Android actions or fallback models.
 * Note: provider account billing state cannot be verified by this process.
 * Human must confirm that the Groq organization is on the Free plan.
 */
export const FREE_CHAT_MODEL = "openai/gpt-oss-20b";
export const FREE_CHAT_DAILY_LIMIT = 8;
export const FREE_CHAT_MAX_INPUT = 700;
export const FREE_CHAT_MAX_OUTPUT_TOKENS = 384;

export function freeChatPolicy(env = {}) {
  const secretAvailable = typeof env.GROQ_API_KEY === "string" &&
    env.GROQ_API_KEY.trim().length >= 16;
  const enabled = env.JARVIS_FREE_CHAT_ENABLED === "true" &&
    env.JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN === "true" &&
    secretAvailable;
  return {
    enabled,
    model: FREE_CHAT_MODEL,
    dailyLimit: FREE_CHAT_DAILY_LIMIT,
    maxInputChars: FREE_CHAT_MAX_INPUT,
    maxOutputTokens: FREE_CHAT_MAX_OUTPUT_TOKENS,
    noPaidFallback: true,
    noTools: true,
    noAutomaticActions: true,
    noPersistence: true,
    ...(enabled ? {} : { reason: "free_plan_confirmation_or_provider_missing" }),
  };
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
