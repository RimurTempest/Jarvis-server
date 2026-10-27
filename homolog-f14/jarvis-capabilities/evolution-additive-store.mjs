import { randomUUID, randomBytes, createHash } from "node:crypto";

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
export function validId(value) {
  if (typeof value !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw httpError(422, "Identificador UUID inválido.");
  }
  return value.toLowerCase();
}
export function validOwner(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw httpError(403, "Identidade do proprietário não configurada.");
  }
  return value;
}
export function validRequest(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4000) {
    throw httpError(422, "Descrição da capacidade inválida.");
  }
  const cleaned = value.trim();
  if (/(?:api[_ -]?key|authorization\s*:\s*bearer|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(cleaned)) {
    throw httpError(422, "Remova credenciais da descrição da capacidade.");
  }
  return cleaned;
}
export function hashToken(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export const EVOLUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS jarvis_supervised_v11_owner_bindings (
  device_id TEXT PRIMARY KEY REFERENCES jarvis_android_devices(device_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jarvis_supervised_v11_binding_owner_idx
  ON jarvis_supervised_v11_owner_bindings (owner_id);
CREATE TABLE IF NOT EXISTS jarvis_supervised_v11_requests (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_text TEXT NOT NULL CHECK (length(request_text) BETWEEN 1 AND 4000),
  client_request_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'claimed', 'needs_review', 'blocked')),
  development_authorized_at TIMESTAMPTZ,
  lease_hash BYTEA,
  lease_expires_at TIMESTAMPTZ,
  lease_started_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  report JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, client_request_id)
);
ALTER TABLE jarvis_supervised_v11_requests
  ADD COLUMN IF NOT EXISTS lease_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS jarvis_supervised_v11_queue_idx
  ON jarvis_supervised_v11_requests (development_authorized_at, created_at)
  WHERE development_authorized_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS jarvis_supervised_v11_owner_idx
  ON jarvis_supervised_v11_requests (owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jarvis_supervised_v11_audit (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID REFERENCES jarvis_supervised_v11_requests(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'device', 'runner')),
  event TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function createEvolutionStore(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("Pool PostgreSQL obrigatório.");
  }
  async function tx(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  async function initialize() {
    // Nunca altera jarvis_android_devices: usa o esquema TEXT/BYTEA da revisão ativa.
    await pool.query(EVOLUTION_SCHEMA);
  }
  async function bindDevice(deviceId, ownerId) {
    const owner = validOwner(ownerId);
    if (typeof deviceId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(deviceId)) {
      throw httpError(422, "Dispositivo inválido.");
    }
    return tx(async db => {
      const found = await db.query(
        `SELECT device_id FROM jarvis_android_devices
         WHERE device_id = $1 AND revoked_at IS NULL
           AND last_seen_at > NOW() - INTERVAL '15 minutes' FOR UPDATE`, [deviceId]
      );
      if (found.rowCount !== 1) throw httpError(404, "Dispositivo inexistente, revogado ou sem autenticação recente.");
      const result = await db.query(
        `INSERT INTO jarvis_supervised_v11_owner_bindings (device_id, owner_id)
         VALUES ($1, $2) ON CONFLICT (device_id)
         DO UPDATE SET owner_id = EXCLUDED.owner_id
         WHERE jarvis_supervised_v11_owner_bindings.owner_id = EXCLUDED.owner_id
         RETURNING device_id, owner_id`, [deviceId, owner]
      );
      if (result.rowCount !== 1) throw httpError(409, "Dispositivo vinculado a outro proprietário.");
      return result.rows[0];
    });
  }
  async function resolveOwner(deviceId) {
    const result = await pool.query(
      `SELECT b.owner_id FROM jarvis_supervised_v11_owner_bindings b
       JOIN jarvis_android_devices d ON d.device_id = b.device_id
       WHERE b.device_id = $1 AND d.revoked_at IS NULL`, [deviceId]
    );
    if (!result.rows[0]) throw httpError(403, "Dispositivo ainda não vinculado a um proprietário.");
    return result.rows[0].owner_id;
  }
  async function create(ownerId, input, clientRequestId) {
    const owner = validOwner(ownerId);
    const request = validRequest(input);
    const idempotency = validId(clientRequestId);
    return tx(async db => {
      const result = await db.query(
        `INSERT INTO jarvis_supervised_v11_requests
            (id, owner_id, request_text, client_request_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, client_request_id) DO NOTHING
         RETURNING *`, [randomUUID(), owner, request, idempotency]
      );
      if (result.rows[0]) {
        await db.query(
          `INSERT INTO jarvis_supervised_v11_audit (request_id, actor, event)
           VALUES ($1, 'device', 'requested')`, [result.rows[0].id]
        );
        return result.rows[0];
      }
      const prior = await db.query(
        `SELECT * FROM jarvis_supervised_v11_requests
         WHERE owner_id = $1 AND client_request_id = $2`, [owner, idempotency]
      );
      if (!prior.rows[0] || prior.rows[0].request_text !== request) {
        throw httpError(409, "Identificador de repetição usado para outro pedido.");
      }
      return prior.rows[0];
    });
  }
  async function list(ownerId) {
    return (await pool.query(
      `SELECT id, request_text, state, development_authorized_at,
              created_at, updated_at
       FROM jarvis_supervised_v11_requests WHERE owner_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 50`, [validOwner(ownerId)]
    )).rows;
  }
  async function authorize(ownerId, id) {
    return tx(async db => {
      const owner = validOwner(ownerId);
      const taskId = validId(id);
      const locked = await db.query(
        `SELECT id, state, development_authorized_at
         FROM jarvis_supervised_v11_requests WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
        [taskId, owner]
      );
      if (!locked.rows[0]) throw httpError(404, "Solicitação não encontrada.");
      if (locked.rows[0].state !== "requested") {
        throw httpError(409, "Somente solicitações novas podem ser autorizadas.");
      }
      if (locked.rows[0].development_authorized_at) {
        return { id: taskId, developmentAuthorized: true, newlyAuthorized: false };
      }
      const result = await db.query(
        `UPDATE jarvis_supervised_v11_requests
         SET development_authorized_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND state = 'requested'
         RETURNING id`, [taskId, owner]
      );
      if (result.rowCount !== 1) throw httpError(409, "Autorização não registrada.");
      await db.query(
        `INSERT INTO jarvis_supervised_v11_audit
          (request_id, actor, event, details)
         VALUES ($1, 'owner', 'development_authorized',
          '{"publicationApproved":false,"installationApproved":false}'::jsonb)`,
        [taskId]
      );
      return { id: taskId, developmentAuthorized: true, newlyAuthorized: true };
    });
  }
  /** Revoke development authority and fence the active reservation atomically. */
  async function revokeDevelopment(ownerId, id) {
    const owner = validOwner(ownerId);
    const taskId = validId(id);
    return tx(async db => {
      const row = await db.query(
        `SELECT state, development_authorized_at
           FROM jarvis_supervised_v11_requests
          WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [taskId, owner]
      );
      const task = row.rows[0];
      if (!task) throw httpError(404, "Solicitação não encontrada.");
      if (!task.development_authorized_at && task.state === "blocked") {
        const prior = await db.query(
          `SELECT 1 FROM jarvis_supervised_v11_audit
            WHERE request_id = $1 AND actor = 'owner' AND event = 'development_revoked' LIMIT 1`,
          [taskId]
        );
        if (prior.rowCount === 1) return { id: taskId, revoked: true, newlyRevoked: false };
      }
      if (!task.development_authorized_at || !["requested", "claimed"].includes(task.state)) {
        throw httpError(409, "Autorização não está ativa ou a solicitação já foi concluída.");
      }
      await db.query(
        `UPDATE jarvis_supervised_v11_requests
            SET state = 'blocked', development_authorized_at = NULL,
                lease_hash = NULL, lease_expires_at = NULL, lease_started_at = NULL,
                report = jsonb_build_object('summary', 'Autorização revogada pelo proprietário.',
                  'testsExecuted', false, 'testsPassed', false, 'validatedByCi', false,
                  'installed', false, 'learned', false), updated_at = NOW()
          WHERE id = $1 AND owner_id = $2`, [taskId, owner]
      );
      await db.query(
        `INSERT INTO jarvis_supervised_v11_audit (request_id, actor, event, details)
         VALUES ($1, 'owner', 'development_revoked',
           '{"publicationApproved":false,"installationApproved":false}'::jsonb)`, [taskId]
      );
      return { id: taskId, revoked: true, newlyRevoked: true };
    });
  }
  async function claim() {
    // Uma reserva que expirou após a terceira tentativa não pode ficar
    // eternamente em "claimed". O registro de auditoria e a mudança de estado
    // são feitos pela mesma instrução SQL, sob bloqueio da linha.
    await pool.query(`
      WITH exhausted AS (
        UPDATE jarvis_supervised_v11_requests
        SET state = 'blocked',
            lease_hash = NULL, lease_expires_at = NULL,
            lease_started_at = NULL,
            report = jsonb_build_object(
              'summary', 'Tentativas esgotadas; exige revisão administrativa.',
              'testsExecuted', false, 'testsPassed', false,
              'validatedByCi', false, 'installed', false, 'learned', false
            ),
            updated_at = NOW()
        WHERE state = 'claimed' AND attempts >= 3
          AND lease_expires_at <= NOW()
        RETURNING id
      )
      INSERT INTO jarvis_supervised_v11_audit
        (request_id, actor, event, details)
      SELECT id, 'runner', 'lease_exhausted',
        '{"manualReviewRequired":true,"installed":false,"learned":false}'::jsonb
      FROM exhausted
    `);
    const leaseToken = randomBytes(32).toString("base64url");
    const claimed = await pool.query(
      `WITH next AS (
         SELECT id FROM jarvis_supervised_v11_requests
         WHERE development_authorized_at IS NOT NULL
           AND attempts < 3
           AND (state = 'requested' OR
                (state = 'claimed' AND lease_expires_at < NOW()))
         ORDER BY development_authorized_at, created_at, id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE jarvis_supervised_v11_requests r
       SET state = 'claimed', attempts = attempts + 1,
           lease_hash = $1, lease_expires_at = NOW() + INTERVAL '15 minutes',
           lease_started_at = NOW(), updated_at = NOW()
       FROM next WHERE r.id = next.id
       RETURNING r.id, r.request_text, r.attempts, r.owner_id`,
      [hashToken(leaseToken)]
    );
    if (!claimed.rows[0]) return null;
    return {
      id: claimed.rows[0].id,
      request: claimed.rows[0].request_text,
      attempt: claimed.rows[0].attempts,
      leaseToken
    };
  }
  async function renewLease(id, token) {
    const taskId = validId(id);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw httpError(401, "Lease inválido.");
    }
    const refreshed = await pool.query(
      `UPDATE jarvis_supervised_v11_requests
       SET lease_expires_at = NOW() + INTERVAL '15 minutes',
           updated_at = NOW()
       WHERE id = $1 AND lease_hash = $2 AND state = 'claimed'
         AND development_authorized_at IS NOT NULL
         AND lease_expires_at > NOW()
         AND lease_started_at > NOW() - INTERVAL '90 minutes'
       RETURNING id, lease_expires_at`, [taskId, hashToken(token)]
    );
    if (!refreshed.rows[0]) {
      throw httpError(409, "Lease inválido, expirado ou prazo máximo excedido.");
    }
    return refreshed.rows[0];
  }

  async function report(id, token, outcome) {
    const taskId = validId(id);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw httpError(401, "Lease inválido.");
    }
    if (!outcome || typeof outcome !== "object" ||
        !["needs_review", "blocked"].includes(outcome.status) ||
        typeof outcome.summary !== "string" ||
        !outcome.summary.trim() || outcome.summary.length > 1000) {
      throw httpError(422, "Relatório do executor inválido.");
    }
    if (outcome.status === "needs_review" &&
        (outcome.testsPassed !== true || outcome.testsExecuted !== true ||
         !/^[a-f0-9]{40}$/i.test(outcome.commitSha || "") ||
         outcome.branch !== `work/evolution/${taskId}`)) {
      throw httpError(422, "Faltam testes ou commit para a revisão.");
    }
    const safeReport = {
      summary: outcome.summary.trim(),
      testsExecuted: outcome.testsExecuted === true,
      testsPassed: outcome.testsPassed === true,
      commitSha: outcome.status === "needs_review" ? outcome.commitSha : null,
      branch: outcome.status === "needs_review" ? outcome.branch : null,
      validatedByCi: false,
      installed: false,
      learned: false
    };
    return tx(async db => {
      const updated = await db.query(
        `UPDATE jarvis_supervised_v11_requests
         SET state = $3, report = $4::jsonb,
             lease_hash = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND lease_hash = $2 AND state = 'claimed'
           AND lease_expires_at > NOW() AND development_authorized_at IS NOT NULL
           AND lease_started_at > NOW() - INTERVAL '90 minutes'
         RETURNING id, state`, [taskId, hashToken(token),
          outcome.status, JSON.stringify(safeReport)]
      );
      if (!updated.rows[0]) throw httpError(409, "Lease ausente, expirado ou já concluído.");
      await db.query(
        `INSERT INTO jarvis_supervised_v11_audit (request_id, actor, event, details)
         VALUES ($1, 'runner', $2, $3::jsonb)`,
        [taskId, outcome.status, JSON.stringify(safeReport)]
      );
      return { ...updated.rows[0], learned: false, installed: false };
    });
  }
  return { initialize, bindDevice, resolveOwner, create, list, authorize, revokeDevelopment, claim, renewLease, report };
}
