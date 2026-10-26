import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual
} from "node:crypto";

const hash = value =>
  createHash("sha256").update(value, "utf8").digest("hex");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bearer = req =>
  /^Bearer\s+(\S+)$/i.exec(
    req.get("Authorization") || ""
  )?.[1] || "";

function equalSecrets(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function installJarvisBridge({
  app,
  express,
  pool,
  env = process.env
}) {
  if (env.JARVIS_BRIDGE_ENABLED !== "1") return;

  const ownerId = env.JARVIS_OWNER_ID;
  const adminToken = env.JARVIS_OWNER_ADMIN_TOKEN;

  if (!pool) {
    throw new Error("PostgreSQL obrigatório.");
  }

  if (
    !ownerId ||
    ownerId.length < 8 ||
    !adminToken ||
    adminToken.length < 32
  ) {
    throw new Error("Configuração administrativa incompleta.");
  }

  let initialization = null;

  function initialize() {
    if (!initialization) {
      initialization = pool.query(`
        CREATE TABLE IF NOT EXISTS jarvis_android_enrollment_codes (
          code_hash CHAR(64) PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS jarvis_android_devices (
          device_id UUID PRIMARY KEY,
          owner_id TEXT NOT NULL,
          token_hash CHAR(64) NOT NULL,
          revoked_at TIMESTAMPTZ,
          last_seen_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS jarvis_evolution_requests (
          id UUID PRIMARY KEY,
          owner_id TEXT NOT NULL,
          request_text TEXT NOT NULL,
          client_request_id UUID,
          state TEXT NOT NULL DEFAULT 'requested',
          approved_at TIMESTAMPTZ,
          development_authorized_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS
          jarvis_evolution_request_idempotency_idx
        ON jarvis_evolution_requests (
          owner_id,
          client_request_id
        )
        WHERE client_request_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS jarvis_evolution_events (
          id BIGSERIAL PRIMARY KEY,
          request_id UUID NOT NULL
            REFERENCES jarvis_evolution_requests(id)
            ON DELETE CASCADE,
          previous_state TEXT,
          next_state TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          evidence JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `).catch(error => {
        initialization = null;
        throw error;
      });
    }

    return initialization;
  }

  const safe = fn => async (req, res) => {
    try {
      await initialize();
      await fn(req, res);
    } catch (error) {
      const status = error.status || 503;
      res.status(status).json({
        error: status === 503
          ? "Serviço de evolução indisponível."
          : error.message
      });
    }
  };

  function requireOwner(req, res, next) {
    if (!equalSecrets(bearer(req), adminToken)) {
      return res.status(401).json({
        error: "Credencial administrativa necessária."
      });
    }
    next();
  }

  async function requireDevice(req, res, next) {
    try {
      await initialize();

      const deviceId = req.get("X-Jarvis-Device-Id");
      const token = bearer(req);

      if (
        !uuidPattern.test(deviceId || "") ||
        !/^[A-Za-z0-9_-]{32,160}$/.test(token)
      ) {
        return res.status(401).json({
          error: "Dispositivo não vinculado."
        });
      }

      const result = await pool.query(
        `SELECT owner_id
         FROM jarvis_android_devices
         WHERE device_id=$1::uuid
         AND token_hash=$2
         AND revoked_at IS NULL`,
        [deviceId, hash(token)]
      );

      if (!result.rows.length) {
        return res.status(401).json({
          error: "Dispositivo não vinculado."
        });
      }

      req.jarvisOwnerId = result.rows[0].owner_id;
      req.jarvisDeviceId = deviceId;
      next();
    } catch {
      res.status(503).json({
        error: "Verificação do vínculo indisponível."
      });
    }
  }

  const router = express.Router();

  router.post(
    "/enrollment/start",
    requireOwner,
    safe(async (req, res) => {
      const code = randomBytes(32).toString("base64url");

      await pool.query(
        `INSERT INTO jarvis_android_enrollment_codes
         (code_hash, owner_id, expires_at)
         VALUES ($1,$2,NOW() + INTERVAL '5 minutes')`,
        [hash(code), ownerId]
      );

      res.set("Cache-Control", "no-store");

      res.status(201).json({
        code,
        expiresInSeconds: 300
      });
    })
  );

  router.post(
    "/enrollment/complete",
    safe(async (req, res) => {
      const { code, deviceId } = req.body || {};

      if (
        !/^[A-Za-z0-9_-]{32,160}$/.test(code || "") ||
        !uuidPattern.test(deviceId || "")
      ) {
        throw fail(422, "Código ou dispositivo inválido.");
      }

      const db = await pool.connect();

      try {
        await db.query("BEGIN");

        const claim = await db.query(
          `UPDATE jarvis_android_enrollment_codes
           SET consumed_at=NOW()
           WHERE code_hash=$1
           AND expires_at>NOW()
           AND consumed_at IS NULL
           RETURNING owner_id`,
          [hash(code)]
        );

        if (!claim.rows.length) {
          throw fail(401, "Código expirado ou utilizado.");
        }

        const token = randomBytes(48).toString("base64url");

        const linked = await db.query(
          `INSERT INTO jarvis_android_devices
           (device_id,owner_id,token_hash)
           VALUES ($1::uuid,$2,$3)
           ON CONFLICT (device_id)
           DO UPDATE SET
             token_hash=EXCLUDED.token_hash,
             revoked_at=NULL,
             updated_at=NOW()
           WHERE jarvis_android_devices.owner_id=
             EXCLUDED.owner_id
           RETURNING device_id`,
          [deviceId, claim.rows[0].owner_id, hash(token)]
        );

        if (!linked.rows.length) {
          throw fail(409, "Dispositivo pertence a outro proprietário.");
        }

        await db.query("COMMIT");

        res.set("Cache-Control", "no-store");

        res.status(201).json({
          deviceId,
          token,
          linked: true
        });
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    })
  );

  router.get(
    "/enrollment/status",
    requireDevice,
    (req, res) => {
      res.set("Cache-Control", "no-store");

      res.json({
        linked: true,
        deviceId: req.jarvisDeviceId,
        ownerAuthenticated: true,
        capabilities: {
          taskDelivery: false,
          memoryProbe: false
        }
      });
    }
  );

  router.post(
    "/enrollment/revoke",
    requireOwner,
    safe(async (req, res) => {
      const deviceId = req.body?.deviceId;

      if (!uuidPattern.test(deviceId || "")) {
        throw fail(422, "Dispositivo inválido.");
      }

      const result = await pool.query(
        `UPDATE jarvis_android_devices
         SET revoked_at=NOW(), updated_at=NOW()
         WHERE device_id=$1::uuid
         AND owner_id=$2
         AND revoked_at IS NULL
         RETURNING device_id`,
        [deviceId, ownerId]
      );

      if (!result.rows.length) {
        throw fail(404, "Dispositivo não encontrado.");
      }

      res.json({ deviceId, revoked: true });
    })
  );

  router.get(
    "/evolution/requests",
    requireDevice,
    safe(async (req, res) => {
      const result = await pool.query(
        `SELECT id, state, created_at,
                updated_at, development_authorized_at
         FROM jarvis_evolution_requests
         WHERE owner_id=$1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.jarvisOwnerId]
      );

      res.set("Cache-Control", "no-store");
      res.json({ tasks: result.rows });
    })
  );

  router.post(
    "/evolution/requests",
    requireDevice,
    safe(async (req, res) => {
      const request = req.body?.request;
      const clientRequestId =
        req.body?.clientRequestId ?? null;

      if (
        typeof request !== "string" ||
        request.trim().length < 5 ||
        request.length > 4000 ||
        (clientRequestId !== null &&
          !uuidPattern.test(clientRequestId))
      ) {
        throw fail(422, "Pedido inválido.");
      }

      const db = await pool.connect();
      let task;

      try {
        await db.query("BEGIN");

        const inserted = await db.query(
          `INSERT INTO jarvis_evolution_requests
           (id,owner_id,request_text,client_request_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (owner_id,client_request_id)
             WHERE client_request_id IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [
            randomUUID(),
            req.jarvisOwnerId,
            request.trim(),
            clientRequestId
          ]
        );

        if (inserted.rows.length) {
          task = inserted.rows[0];

          await db.query(
            `INSERT INTO jarvis_evolution_events
             (request_id,previous_state,next_state,
              actor_type,evidence)
             VALUES ($1,NULL,'requested','owner',$2::jsonb)`,
            [
              task.id,
              JSON.stringify({ received: true })
            ]
          );
        } else {
          const previous = await db.query(
            `SELECT * FROM jarvis_evolution_requests
             WHERE owner_id=$1 AND client_request_id=$2`,
            [req.jarvisOwnerId, clientRequestId]
          );

          task = previous.rows[0];

          if (
            !task ||
            task.request_text !== request.trim()
          ) {
            throw fail(409, "Identificador já utilizado.");
          }
        }

        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }

      res.set("Cache-Control", "no-store");

      res.status(201).json({
        task,
        developmentAuthorized:
          Boolean(task.development_authorized_at),
        awaitingAdministrativeAuthorization:
          !task.development_authorized_at,
        implemented: false,
        installed: false
      });
    })
  );

  app.use("/api/android", router);

  app.get(
    "/api/evolution/requests",
    requireOwner,
    safe(async (req, res) => {
      const result = await pool.query(
        `SELECT id, request_text, state,
                created_at, development_authorized_at
         FROM jarvis_evolution_requests
         WHERE owner_id=$1
         ORDER BY created_at DESC
         LIMIT 50`,
        [ownerId]
      );

      res.set("Cache-Control", "no-store");
      res.json({ tasks: result.rows });
    })
  );

  app.get("/android-pairing", (req, res) => {
    const nonce = randomBytes(18).toString("base64");

    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        `default-src 'none'; base-uri 'none'; ` +
        `form-action 'none'; connect-src 'self'; ` +
        `script-src 'nonce-${nonce}'; ` +
        `style-src 'unsafe-inline'`
    });

    res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS - Pareamento</title>
<style>
body {
  font: 16px system-ui;
  background: #091a2c;
  color: #d8faff;
  max-width: 460px;
  margin: 4rem auto;
  padding: 1rem;
}
input, button {
  box-sizing: border-box;
  display: block;
  width: 100%;
  padding: 1rem;
  margin-top: 1rem;
}
button { background: #36c4ef; }
#code { overflow-wrap: anywhere; }
</style>
<h2>Vincular aparelho J.A.R.V.I.S.</h2>
<p>O código temporário vale por cinco minutos.</p>
<input type="password" id="admin"
  placeholder="Credencial administrativa">
<button id="create" type="button">Gerar código</button>
<p id="status" role="status"></p>
<strong id="code"></strong>
<script nonce="${nonce}">
document.getElementById("create").onclick = async () => {
  const input = document.getElementById("admin");
  const token = input.value;
  input.value = "";
  const status = document.getElementById("status");
  const code = document.getElementById("code");
  code.textContent = "";
  try {
    const response = await fetch("/api/android/enrollment/start", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token }
    });
    if (!response.ok) throw Error("Autorização recusada.");
    const data = await response.json();
    code.textContent = data.code;
    status.textContent = "Digite o código no Android.";
  } catch (error) {
    status.textContent = error.message;
  }
};
</script>
</html>`);
  });
}
