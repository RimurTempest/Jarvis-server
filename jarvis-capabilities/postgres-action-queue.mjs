import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createAndroidActionEnvelope, normalizeAndroidActionResult, validateAndroidAction } from "./android-action-protocol.mjs";

const MAX_LEASE_MS = 60_000;
const DEFAULT_LEASE_MS = 30_000;

function cleanDeviceId(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 ||
      !/^[a-z0-9][a-z0-9._:-]*$/i.test(value.trim())) {
    throw new TypeError("deviceId inválido.");
  }
  return value.trim();
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenMatches(token, expectedHash) {
  if (typeof token !== "string" || !token || !expectedHash) return false;
  const actual = hashToken(token);
  const expected = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeJson(value) {
  return JSON.stringify(value);
}

/**
 * Create the persistent queue table. Call during database initialization.
 * The lease token is never stored in plaintext; only its SHA-256 digest is saved.
 */
export async function initializeActionQueue(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_action_queue (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'completed', 'failed', 'expired')),
    action JSONB NOT NULL,
    requires_user_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    device_id TEXT,
    lease_token_hash BYTEA,
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ,
    result JSONB
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_jarvis_action_queue_pending ON jarvis_action_queue (created_at, id) WHERE state = 'pending'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_jarvis_action_queue_lease ON jarvis_action_queue (lease_expires_at) WHERE state = 'delivered'");
}

/**
 * Internal server-side enqueue only. Do not expose this directly to an unauthenticated
 * or general chat endpoint; caller must establish the user-approved action and capability.
 */
export async function enqueueAndroidAction(pool, { id, capabilityId, action, expiresAt }) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool PostgreSQL inválido.");
  const envelope = createAndroidActionEnvelope({ id, capabilityId, action, expiresAt });
  const expires = new Date(envelope.expiresAt);
  const normalized = validateAndroidAction(envelope.action);
  await pool.query(
    `INSERT INTO jarvis_action_queue
      (id, capability_id, state, action, requires_user_confirmation, expires_at)
     VALUES ($1, $2, 'pending', $3::jsonb, $4, $5)`,
    [envelope.id, envelope.capabilityId, safeJson(normalized), envelope.requiresUserConfirmation, expires]
  );
  return {
    id: envelope.id,
    capabilityId: envelope.capabilityId,
    state: "pending",
    action: normalized,
    requiresUserConfirmation: envelope.requiresUserConfirmation,
    expiresAt: envelope.expiresAt,
  };
}

/**
 * Atomically claims one action using a transaction and FOR UPDATE SKIP LOCKED.
 * Multiple polling workers cannot claim the same pending row at the same time.
 */
export async function claimNextAndroidAction(pool, { deviceId, now = new Date(), leaseMs = DEFAULT_LEASE_MS }) {
  const cleanId = cleanDeviceId(deviceId);
  const current = new Date(now);
  const currentMs = current.getTime();
  if (!Number.isFinite(currentMs)) throw new TypeError("now inválido.");
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) {
    throw new RangeError("leaseMs deve estar entre 1000 e 60000 ms.");
  }
  const client = await pool.connect();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, capability_id, action, requires_user_confirmation, expires_at, delivery_attempts
       FROM jarvis_action_queue
       WHERE state = 'pending' AND expires_at > $1
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [current]
    );
    if (!selected.rowCount) {
      await client.query(
        "UPDATE jarvis_action_queue SET state = 'expired', completed_at = $1, result = $2::jsonb WHERE state = 'pending' AND expires_at <= $1",
        [current, safeJson({ ok: false, message: "A ação expirou antes da entrega." })]
      );
      await client.query("COMMIT");
      return null;
    }
    const row = selected.rows[0];
    const leaseExpires = new Date(Math.min(currentMs + leaseMs, new Date(row.expires_at).getTime()));
    const updated = await client.query(
      `UPDATE jarvis_action_queue SET state = 'delivered', delivered_at = $1,
       lease_expires_at = $2, device_id = $3, lease_token_hash = $4,
       delivery_attempts = delivery_attempts + 1
       WHERE id = $5 AND state = 'pending'
       RETURNING id, capability_id, action, requires_user_confirmation, expires_at, delivery_attempts`,
      [current, leaseExpires, cleanId, tokenHash, row.id]
    );
    if (!updated.rowCount) throw new Error("A ação deixou de estar pendente durante a retirada.");
    await client.query("COMMIT");
    const claimed = updated.rows[0];
    return {
      id: claimed.id,
      capabilityId: claimed.capability_id,
      action: claimed.action,
      state: "delivered",
      requiresUserConfirmation: claimed.requires_user_confirmation,
      expiresAt: new Date(claimed.expires_at).toISOString(),
      deliveryAttempts: claimed.delivery_attempts,
      delivery: {
        deviceId: cleanId,
        leaseToken: token,
        deliveredAt: current.toISOString(),
        leaseExpiresAt: leaseExpires.toISOString(),
      },
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Accepts a result exactly once, only for the active device lease.
 * Database state is locked and rechecked before the result is committed.
 */
export async function completeAndroidAction(pool, { id, deviceId, leaseToken, result, now = new Date() }) {
  const cleanId = cleanDeviceId(deviceId);
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(id)) throw new TypeError("id inválido.");
  const current = new Date(now);
  const currentMs = current.getTime();
  if (!Number.isFinite(currentMs)) throw new TypeError("now inválido.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, capability_id, action, requires_user_confirmation, expires_at,
       state, device_id, lease_token_hash, lease_expires_at
       FROM jarvis_action_queue WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!selected.rowCount) throw new Error("Ação não encontrada.");
    const row = selected.rows[0];
    if (row.state !== "delivered") throw new Error("A ação não está em entrega ativa.");
    if (row.device_id !== cleanId || !tokenMatches(leaseToken, row.lease_token_hash)) {
      throw new Error("O dispositivo ou token de entrega não corresponde à sessão ativa.");
    }
    if (new Date(row.lease_expires_at).getTime() <= currentMs || new Date(row.expires_at).getTime() <= currentMs) {
      await client.query(
        "UPDATE jarvis_action_queue SET state = 'expired', completed_at = $1, result = $2::jsonb, lease_token_hash = NULL WHERE id = $3",
        [current, safeJson({ ok: false, message: "A entrega ou a ação expirou antes da confirmação." }), id]
      );
      await client.query("COMMIT");
      return { id, state: "expired", result: { ok: false, message: "A entrega ou a ação expirou antes da confirmação." } };
    }
    const normalized = normalizeAndroidActionResult({
      id: row.id,
      capabilityId: row.capability_id,
      action: row.action,
      state: "pending",
      requiresUserConfirmation: row.requires_user_confirmation,
      expiresAt: new Date(row.expires_at).toISOString(),
    }, result);
    const nextState = normalized.state === "completed" ? "completed" : normalized.state === "expired" ? "expired" : "failed";
    await client.query(
      "UPDATE jarvis_action_queue SET state = $1, completed_at = $2, result = $3::jsonb, lease_token_hash = NULL WHERE id = $4",
      [nextState, current, safeJson(normalized.result), id]
    );
    await client.query("COMMIT");
    return { id, state: nextState, result: normalized.result };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
