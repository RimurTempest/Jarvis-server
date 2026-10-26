import { validateAndroidAction } from "./android-action-protocol.mjs";

/**
 * Protocolo para monitoramento de bateria e disparo de notificações.
 * Valida os parâmetros estruturados de nível de bateria, status de carregamento
 * e mensagens de notificação sem executar código arbitrário.
 */
export function validateBatteryNotificationAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("A ação de bateria deve ser um objeto estruturado.");
  }
  const type = String(action.type || "").trim();
  if (type !== "battery_notification") {
    throw new TypeError("Tipo de ação de bateria inválido.");
  }
  const levelThreshold = Number(action.levelThreshold);
  if (!Number.isInteger(levelThreshold) || levelThreshold < 1 || levelThreshold > 99) {
    throw new RangeError("levelThreshold deve ser um inteiro entre 1 e 99.");
  }
  const chargingState = action.chargingState === undefined ? null : Boolean(action.chargingState);
  const title = typeof action.title === "string" && action.title.trim() ? action.title.trim().slice(0, 100) : "Aviso de Bateria";
  const message = typeof action.message === "string" && action.message.trim() ? action.message.trim().slice(0, 500) : "O nível da bateria atingiu o limite configurado.";

  return {
    type,
    levelThreshold,
    chargingState,
    title,
    message,
  };
}

export function createBatteryMonitorEnvelope({ id, capabilityId, action, requestedBy = "jarvis", expiresAt }) {
  const normalized = validateBatteryNotificationAction(action);
  return {
    id,
    capabilityId,
    requestedBy,
    action: normalized,
    state: "pending",
    requiresUserConfirmation: false,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    completedAt: null,
    result: null,
  };
}
