import { validateAndroidDeviceCredentials } from "./android-device-auth.mjs";
import { claimNextAndroidAction, completeAndroidAction } from "./postgres-action-queue.mjs";

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function deviceAuth(req, res, next) {
  const result = validateAndroidDeviceCredentials({
    authorization: req.headers?.authorization,
    deviceIdHeader: req.headers?.["x-jarvis-device-id"],
    expectedToken: process.env.JARVIS_ANDROID_DEVICE_TOKEN,
    expectedDeviceId: process.env.JARVIS_ANDROID_DEVICE_ID,
  });
  if (!result.ok) return sendError(res, 401, "Dispositivo Android não autorizado.");
  return next();
}

/**
 * Register the Android delivery endpoints on an existing Express app.
 * The dedicated device token is independent from JARVIS_API_TOKEN and must
 * be configured only on the server and the authorized device.
 *
 * This module deliberately exposes polling/results only. It does not enqueue
 * actions from chat or allow a device to declare a capability validated.
 */
export function registerAndroidActionRoutes(app, {
  pool,
  initializeDatabase,
  getEnv = () => process.env,
  claimAction = claimNextAndroidAction,
  completeAction = completeAndroidAction,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("app Express inválido.");
  }
  if (typeof initializeDatabase !== "function") {
    throw new TypeError("initializeDatabase é obrigatório.");
  }

  function authenticate(req, res, next) {
    const env = getEnv();
    const result = validateAndroidDeviceCredentials({
      authorization: req.headers?.authorization,
      deviceIdHeader: req.headers?.["x-jarvis-device-id"],
      expectedToken: env?.JARVIS_ANDROID_DEVICE_TOKEN,
      expectedDeviceId: env?.JARVIS_ANDROID_DEVICE_ID,
    });
    if (!result.ok) return sendError(res, 401, "Dispositivo Android não autorizado.");
    return next();
  }

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
