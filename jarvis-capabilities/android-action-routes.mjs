import { timingSafeEqual } from "node:crypto";
import { authenticateAndroidDevice, createAndroidPairingCode, enrollAndroidDevice, initializeAndroidDeviceRegistry, revokeAndroidDevice } from "./android-device-registry.mjs";
import { claimNextAndroidAction, completeAndroidAction } from "./postgres-action-queue.mjs";

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function bearerMatches(authorization, expected) {
  if (typeof authorization !== "string" || typeof expected !== "string" || expected.length < 32) return false;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const buckets = new Map();
  return (key) => {
    const current = now();
    const previous = buckets.get(key);
    if (!previous || current - previous.startedAt >= windowMs) {
      buckets.set(key, { startedAt: current, count: 1 });
      return true;
    }
    previous.count += 1;
    return previous.count <= limit;
  };
}

/** Register enrollment and device-bound action delivery routes. */
export function registerAndroidActionRoutes(app, {
  pool,
  initializeDatabase,
  getEnv = () => process.env,
  claimAction = claimNextAndroidAction,
  completeAction = completeAndroidAction,
  pairingLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 }),
  enrollmentLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }),
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") throw new TypeError("app Express inválido.");
  if (typeof initializeDatabase !== "function") throw new TypeError("initializeDatabase é obrigatório.");

  let registryReady;
  async function ensureRegistry() {
    if (!registryReady) {
      registryReady = initializeAndroidDeviceRegistry(pool).catch((error) => {
        registryReady = null;
        throw error;
      });
    }
    return registryReady;
  }

  function adminAuthorized(req) {
    return bearerMatches(req.headers?.authorization, getEnv()?.JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN);
  }

  async function authenticate(req, res, next) {
    if (!pool) return sendError(res, 503, "Autenticação de dispositivos indisponível.");
    try {
      await initializeDatabase();
      await ensureRegistry();
      const authorization = req.headers?.authorization;
      const match = typeof authorization === "string" ? /^Bearer\s+([^\s]+)$/i.exec(authorization) : null;
      const deviceId = req.headers?.["x-jarvis-device-id"];
      const result = await authenticateAndroidDevice(pool, {
        deviceId,
        token: match?.[1],
      });
      if (!result.ok) return sendError(res, 401, "Dispositivo Android não autorizado.");
      return next();
    } catch {
      return sendError(res, 503, "Autenticação de dispositivos indisponível.");
    }
  }

  app.post("/api/android/enrollment/pairing-code", async (req, res) => {
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
    if (!pairingLimiter(ip)) return sendError(res, 429, "Limite de solicitações excedido.");
    if (!adminAuthorized(req)) return sendError(res, 401, "Operação administrativa não autorizada.");
    if (!pool) return sendError(res, 503, "Registro de dispositivos indisponível.");
    try {
      await initializeDatabase();
      await ensureRegistry();
      const ttlMs = req.body?.ttlMs === undefined ? undefined : req.body.ttlMs;
      const pairing = await createAndroidPairingCode(pool, ttlMs === undefined ? {} : { ttlMs });
      return res.status(201).json({ code: pairing.code, expiresAt: pairing.expiresAt });
    } catch {
      return sendError(res, 500, "Não foi possível criar o código de pareamento.");
    }
  });

  app.post("/api/android/enrollment/complete", async (req, res) => {
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
    if (!enrollmentLimiter(ip)) return sendError(res, 429, "Limite de tentativas excedido.");
    if (!pool) return sendError(res, 503, "Registro de dispositivos indisponível.");
    const code = req.body?.code;
    const deviceId = req.body?.deviceId;
    if (typeof code !== "string" || typeof deviceId !== "string") {
      return sendError(res, 400, "Código e identificador do dispositivo são obrigatórios.");
    }
    try {
      await initializeDatabase();
      await ensureRegistry();
      const enrolled = await enrollAndroidDevice(pool, { code, deviceId });
      return res.status(201).json(enrolled);
    } catch (error) {
      if (error?.code === "DEVICE_ALREADY_REGISTERED") return sendError(res, 409, "O dispositivo já está registrado.");
      if (error?.code === "PAIRING_CODE_INVALID") return sendError(res, 400, "Código de pareamento inválido ou expirado.");
      if (error instanceof TypeError) return sendError(res, 400, "Dados de pareamento inválidos.");
      console.error("Falha ao concluir pareamento Android:", error?.message || "erro desconhecido");
      return sendError(res, 500, "Não foi possível registrar o dispositivo.");
    }
  });

  // Fonte de verdade para a interface Android: só retorna vinculado após
  // validar o deviceId e o token contra o registro ativo no banco.
  app.get("/api/android/enrollment/status", authenticate, (req, res) => {
    return res.status(200).json({
      linked: true,
      deviceId: req.headers["x-jarvis-device-id"],
      checkedAt: new Date().toISOString(),
    });
  });

  app.post("/api/android/devices/:id/revoke", async (req, res) => {
    if (!adminAuthorized(req)) return sendError(res, 401, "Operação administrativa não autorizada.");
    if (!pool) return sendError(res, 503, "Registro de dispositivos indisponível.");
    try {
      await initializeDatabase();
      await ensureRegistry();
      const result = await revokeAndroidDevice(pool, { deviceId: req.params?.id });
      if (!result.revoked) return sendError(res, 404, "Dispositivo ativo não encontrado.");
      return res.status(200).json({ deviceId: result.deviceId, revoked: true });
    } catch (error) {
      if (error instanceof TypeError) return sendError(res, 400, "Identificador do dispositivo inválido.");
      return sendError(res, 500, "Não foi possível revogar o dispositivo.");
    }
  });

  app.get("/api/android/actions/next", authenticate, async (req, res) => {
    if (!pool) return sendError(res, 503, "Fila de ações indisponível.");
    const deviceId = req.headers?.["x-jarvis-device-id"];
    try {
      await initializeDatabase();
      const action = await claimAction(pool, { deviceId });
      if (!action) return res.status(200).json({ action: null });
      return res.status(200).json({ action });
    } catch {
      return sendError(res, 500, "Não foi possível consultar a fila de ações.");
    }
  });

  app.post("/api/android/actions/:id/result", authenticate, async (req, res) => {
    if (!pool) return sendError(res, 503, "Fila de ações indisponível.");
    const deviceId = req.headers?.["x-jarvis-device-id"];
    const leaseToken = req.headers?.["x-jarvis-lease-token"];
    if (typeof leaseToken !== "string" || leaseToken.length < 32 || leaseToken.length > 200) {
      return sendError(res, 400, "Token de entrega inválido.");
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        !req.body.result || typeof req.body.result !== "object" || Array.isArray(req.body.result)) {
      return sendError(res, 400, "O resultado da ação deve ser um objeto.");
    }
    try {
      await initializeDatabase();
      const completed = await completeAction(pool, {
        id: req.params?.id,
        deviceId,
        leaseToken,
        result: req.body.result,
      });
      return res.status(200).json({ action: completed });
    } catch (error) {
      const message = String(error?.message || "");
      if (/não encontrada|não está em entrega ativa|não corresponde|inválido|expirou/i.test(message)) {
        return sendError(res, 409, "A entrega não corresponde a uma ação ativa.");
      }
      return sendError(res, 500, "Não foi possível registrar o resultado da ação.");
    }
  });
}
