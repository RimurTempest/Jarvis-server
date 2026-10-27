import { timingSafeEqual, createHash } from "node:crypto";
import { createEvolutionStore, validId, validOwner } from "./evolution-additive-store.mjs";

function equalToken(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" ||
      expected.length < 32 || actual.length < 32 || actual.length > 512) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function bearer(request) {
  const raw = request.headers?.authorization;
  if (typeof raw !== "string") return null;
  const found = /^Bearer ([^\s]+)$/i.exec(raw);
  return found ? found[1] : null;
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
export function validateEvolutionSettings(env) {
  if (env.JARVIS_EVOLUTION_BRIDGE_ENABLED !== "1" ||
      env.JARVIS_EVOLUTION_SINGLE_OWNER !== "1") {
    throw new Error("Ponte deve ser ativada explicitamente em modo proprietário único.");
  }
  const ownerId = validOwner(env.JARVIS_EVOLUTION_OWNER_ID);
  const admin = env.JARVIS_EVOLUTION_ADMIN_TOKEN;
  const runner = env.JARVIS_EVOLUTION_RUNNER_TOKEN;
  if (typeof admin !== "string" || admin.length < 32 ||
      typeof runner !== "string" || runner.length < 32 ||
      admin === runner || admin === env.JARVIS_API_TOKEN ||
      runner === env.JARVIS_API_TOKEN) {
    throw new Error("Credenciais exclusivas de administrador e executor obrigatórias.");
  }
  return { ownerId, admin, runner };
}

export function registerEvolutionBridge({
  app, pool, authenticateDevice, initializeLegacyRegistry,
  env = process.env, storeOverride
}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function" ||
      !pool || typeof authenticateDevice !== "function" ||
      typeof initializeLegacyRegistry !== "function") {
    throw new TypeError("Express, Pool e autenticação legada obrigatórios.");
  }
  const settings = validateEvolutionSettings(env);
  const store = storeOverride || createEvolutionStore(pool);
  let initializing = null;
  async function ready() {
    if (!initializing) {
      initializing = Promise.resolve().then(async () => {
        await initializeLegacyRegistry(pool);
        await store.initialize();
      }).catch(error => {
        initializing = null;
        throw error;
      });
    }
    return initializing;
  }
  const handle = fn => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      await ready();
      await fn(req, res);
    } catch (error) {
      const status = Number.isInteger(error?.status) &&
        error.status >= 400 && error.status < 500 ? error.status : 503;
      res.status(status).json({
        error: status === 503 ? "Serviço de evolução indisponível." : error.message
      });
    }
  };
  async function deviceOwner(req) {
    const deviceId = req.headers?.["x-jarvis-device-id"];
    const token = bearer(req);
    if (typeof deviceId !== "string" || !token) {
      throw httpError(401, "Credencial do dispositivo ausente.");
    }
    const auth = await authenticateDevice(pool, { deviceId, token });
    if (auth?.ok !== true) throw httpError(401, "Pareamento inválido ou revogado.");
    const ownerId = await store.resolveOwner(deviceId);
    if (ownerId !== settings.ownerId) {
      throw httpError(403, "Proprietário do dispositivo não autorizado.");
    }
    return ownerId;
  }
  function ownerAdmin(req) {
    if (!equalToken(bearer(req), settings.admin)) {
      throw httpError(401, "Autorização administrativa inválida.");
    }
    return settings.ownerId;
  }
  function runner(req) {
    if (!equalToken(bearer(req), settings.runner)) {
      throw httpError(401, "Executor não autorizado.");
    }
  }

  app.post("/api/evolution/owner/devices/bind", handle(async (req, res) => {
    const ownerId = ownerAdmin(req);
    const deviceId = req.body?.deviceId;
    if (typeof deviceId !== "string" || req.body?.confirmOwnerBinding !== true) {
      throw httpError(422, "Vinculação requer dispositivo e confirmação administrativa explícita.");
    }
    // O cadastro legado verifica uma autenticação recente do Android (last_seen_at).
    // Não solicitamos que o proprietário extraia o token do Android Keystore.
    const bound = await store.bindDevice(deviceId, ownerId);
    res.status(200).json({ deviceId: bound.device_id, ownerBound: true,
      approvedDevelopment: false });
  }));

  app.get("/api/android/evolution/requests", handle(async (req, res) => {
    const ownerId = await deviceOwner(req);
    res.status(200).json({ tasks: await store.list(ownerId) });
  }));
  app.post("/api/android/evolution/requests", handle(async (req, res) => {
    const ownerId = await deviceOwner(req);
    const task = await store.create(
      ownerId, req.body?.request, req.body?.clientRequestId
    );
    res.status(201).json({ task, executed: false, approved: false,
      installed: false });
  }));

  app.get("/api/evolution/owner/requests", handle(async (req, res) => {
    const ownerId = ownerAdmin(req);
    res.status(200).json({ tasks: await store.list(ownerId) });
  }));
  app.post("/api/evolution/owner/requests/:id/authorize-development",
    handle(async (req, res) => {
      const ownerId = ownerAdmin(req);
      const taskId = validId(req.params.id);
      const approval = await store.authorize(ownerId, taskId);
      res.status(200).json({
        ...approval, published: false, installed: false
      });
    })
  );

  // A fila é reivindicada atomicamente; nenhum código é executado no Render.
  app.post("/api/evolution/runner/claim", handle(async (req, res) => {
    runner(req);
    const task = await store.claim();
    res.status(200).json({
      task,
      permissions: { publish: false, install: false, deploy: false }
    });
  }));
  app.post("/api/evolution/runner/requests/:id/renew",
    handle(async (req, res) => {
      runner(req);
      const lease = await store.renewLease(
        validId(req.params.id), req.body?.leaseToken
      );
      res.status(200).json({
        lease: { id: lease.id, expiresAt: lease.lease_expires_at },
        permissions: { publish: false, install: false, deploy: false }
      });
    })
  );

  app.post("/api/evolution/runner/requests/:id/report",
    handle(async (req, res) => {
      runner(req);
      const result = await store.report(
        validId(req.params.id), req.body?.leaseToken, req.body?.outcome
      );
      res.status(200).json({ task: result, published: false,
        installed: false, learned: false });
    })
  );

  return { ready };
}
