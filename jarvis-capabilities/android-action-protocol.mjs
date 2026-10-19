/**
 * Strict protocol for structured Android action requests.
 *
 * This validates data only; it never executes commands, shell text, JavaScript,
 * arbitrary intents, or code supplied by an AI model or a web page.
 */
const MAX_TEXT = 2000;
const SAFE_SETTINGS = new Set([
  "wifi",
  "bluetooth",
  "display",
  "sound",
  "accessibility",
  "app_details",
  "default_apps",
]);

function cleanString(value, field, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} deve ser um texto não vazio.`);
  }
  const cleaned = value.trim();
  if (cleaned.length > max) throw new RangeError(`${field} excede o limite permitido.`);
  return cleaned;
}

function cleanIdentifier(value, field) {
  const id = cleanString(value, field, 100);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) {
    throw new TypeError(`${field} contém caracteres inválidos.`);
  }
  return id;
}

export function validateAndroidAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("action deve ser um objeto estruturado.");
  }
  const type = cleanString(action.type, "action.type", 40);
  switch (type) {
    case "open_app": {
      const packageName = cleanString(action.packageName, "action.packageName", 255);
      if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName)) {
        throw new TypeError("Nome de pacote Android inválido.");
      }
      return { type, packageName };
    }
    case "open_url": {
      const rawUrl = cleanString(action.url, "action.url", 2048);
      let url;
      try { url = new URL(rawUrl); }
      catch { throw new TypeError("URL inválida."); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new TypeError("Somente URLs HTTP(S) sem credenciais são permitidas.");
      }
      return { type, url: url.toString() };
    }
    case "dial_number": {
      const phoneNumber = cleanString(action.phoneNumber, "action.phoneNumber", 40);
      if (!/^\+?[0-9][0-9 ()-]{3,35}$/.test(phoneNumber)) {
        throw new TypeError("Número telefônico inválido.");
      }
      return { type, phoneNumber, requiresUserConfirmation: true };
    }
    case "open_settings": {
      const setting = cleanString(action.setting, "action.setting", 40);
      if (!SAFE_SETTINGS.has(setting)) throw new TypeError("Tela de configuração não permitida.");
      return { type, setting };
    }
    case "copy_text": {
      return { type, text: cleanString(action.text, "action.text", MAX_TEXT) };
    }
    default:
      throw new TypeError("Tipo de ação Android não permitido.");
  }
}

export function createAndroidActionEnvelope({ id, capabilityId, action, requestedBy = "jarvis", expiresAt }) {
  const now = new Date();
  const expiration = expiresAt === undefined
    ? new Date(now.getTime() + 2 * 60 * 1000)
    : new Date(expiresAt);
  if (Number.isNaN(expiration.getTime()) || expiration <= now || expiration.getTime() > now.getTime() + 10 * 60 * 1000) {
    throw new RangeError("A ação deve expirar entre agora e os próximos 10 minutos.");
  }
  const normalizedAction = validateAndroidAction(action);
  return {
    id: cleanIdentifier(id, "id"),
    capabilityId: cleanIdentifier(capabilityId, "capabilityId"),
    requestedBy: cleanString(requestedBy, "requestedBy", 100),
    action: normalizedAction,
    state: "pending",
    // Every queued action requires a final confirmation on the Android device.
    requiresUserConfirmation: true,
    createdAt: now.toISOString(),
    expiresAt: expiration.toISOString(),
    completedAt: null,
    result: null,
  };
}

export function normalizeAndroidActionResult(envelope, result) {
  if (!envelope || typeof envelope !== "object" || envelope.state !== "pending") {
    throw new Error("A ação não está pendente.");
  }
  if (new Date(envelope.expiresAt).getTime() <= Date.now()) {
    return { ...envelope, state: "expired", completedAt: new Date().toISOString(), result: { ok: false, message: "A ação expirou." } };
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") {
    throw new TypeError("O resultado deve informar ok como booleano.");
  }
  const message = typeof result.message === "string" ? result.message.trim().slice(0, 1000) : "";
  if (envelope.requiresUserConfirmation && result.ok && result.userConfirmed !== true) {
    throw new Error("Esta ação exige confirmação explícita do usuário no dispositivo.");
  }
  return {
    ...envelope,
    state: result.ok ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    result: {
      ok: result.ok,
      message,
      userConfirmed: envelope.requiresUserConfirmation ? result.userConfirmed === true : undefined,
    },
  };
}
