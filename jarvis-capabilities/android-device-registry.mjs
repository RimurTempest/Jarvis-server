import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_TTL_MS = 10 * 60 * 1000;

function cleanDeviceId(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 ||
      !/^[a-z0-9][a-z0-9._:-]*$/i.test(value.trim())) {
    throw new TypeError("deviceId inválido.");
  }
  return value.trim();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function matches(value, expectedHash) {
  if (typeof value !== "string" || !value || !expectedHash) return false;
  const actual = digest(value);
  const expected = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Data inválida.");
  return date;
}

export async function initializeAndroidDeviceRegistry(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_android_devices (
    device_id TEXT PRIMARY KEY,
    token_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_android_pairing_codes (
    id TEXT PRIMARY KEY,
    code_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_jarvis_android_pairing_expiry ON jarvis_android_pairing_codes (expires_at) WHERE consumed_at IS NULL");
}

export async function createAndroidPairingCode(pool, { now = new Date(), ttlMs = DEFAULT_PAIRING_TTL_MS } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  const current = validDate(now);
  if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > MAX_PAIRING_TTL_MS) {
    throw new RangeError("ttlMs deve estar entre 30000 e 600000 ms.");
  }
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(current.getTime() + ttlMs);
  await pool.query(
    "INSERT INTO jarvis_android_pairing_codes (id, code_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [randomBytes(16).toString("hex"), digest(code), current, expiresAt]
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function enrollAndroidDevice(pool, { code, deviceId, now = new Date() } = {}) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("pool PostgreSQL inválido.");
  if (typeof code !== "string" || code.length < 20 || code.length > 100) throw new TypeError("Código de pareamento inválido.");
  const cleanId = cleanDeviceId(deviceId);
  const current = validDate(now);
  const token = randomBytes(32).toString("base64url");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consumed = await client.query(
      `UPDATE jarvis_android_pairing_codes SET consumed_at = $1
       WHERE code_hash = $2 AND consumed_at IS NULL AND expires_at > $1 RETURNING id`,
      [current, digest(code)]
    );
    if (!consumed.rowCount) {
      const error = new Error("Código de pareamento inválido, expirado ou já utilizado.");
      error.code = "PAIRING_CODE_INVALID";
      throw error;
    }
    await client.query(
      "INSERT INTO jarvis_android_devices (device_id, token_hash, created_at) VALUES ($1, $2, $3)",
      [cleanId, digest(token), current]
    );
    await client.query("COMMIT");
    return { deviceId: cleanId, token, createdAt: current.toISOString() };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error?.code === "23505") {
      const conflict = new Error("O identificador do dispositivo já está registrado.");
      conflict.code = "DEVICE_ALREADY_REGISTERED";
      throw conflict;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateAndroidDevice(pool, { deviceId, token, now = new Date() } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  let cleanId;
  try { cleanId = cleanDeviceId(deviceId); } catch { return { ok: false, reason: "invalid_device_id" }; }
  if (typeof token !== "string" || token.length < 32 || token.length > 200) return { ok: false, reason: "invalid_token" };
  const current = validDate(now);
  const result = await pool.query(
    "SELECT token_hash FROM jarvis_android_devices WHERE device_id = $1 AND revoked_at IS NULL",
    [cleanId]
  );
  if (!result.rowCount || !matches(token, result.rows[0].token_hash)) return { ok: false, reason: "invalid_credentials" };
  await pool.query("UPDATE jarvis_android_devices SET last_seen_at = $1 WHERE device_id = $2 AND revoked_at IS NULL", [current, cleanId]);
  return { ok: true, reason: null };
}

export async function revokeAndroidDevice(pool, { deviceId, now = new Date() } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  const cleanId = cleanDeviceId(deviceId);
  const current = validDate(now);
  const result = await pool.query(
    "UPDATE jarvis_android_devices SET revoked_at = $1 WHERE device_id = $2 AND revoked_at IS NULL RETURNING device_id",
    [current, cleanId]
  );
  return { revoked: result.rowCount === 1, deviceId: cleanId };
}
