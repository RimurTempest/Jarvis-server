import { detectCapabilityLearningRequest } from "./learning-intent.mjs";

const MAX_AUTO_MEMORY_LENGTH = 600;

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksSensitive(content) {
  const value = String(content ?? "");
  return /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|senha|passphrase|authorization\s*:\s*bearer|bearer\s+[a-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(value)
    || /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(value)
    || /\b(?:\d[ -]*?){13,19}\b/.test(value);
}

/**
 * Detects only explicit, durable preferences and corrections.
 * A one-off action is not a permanent preference, and capability-learning
 * requests must be routed to the capability registry instead.
 */
export function detectExplicitLearning(message) {
  const raw = String(message ?? "").trim();
  const normalized = normalizeText(raw);
  if (!raw || raw.length > MAX_AUTO_MEMORY_LENGTH) return null;
  if (detectCapabilityLearningRequest(raw)) return null;
  if (looksSensitive(raw) || /\b(cpf|rg|cartao de credito|cartão de crédito|cvv|codigo de seguranca|código de segurança|seed phrase|frase de recuperacao|frase de recuperação)\b/i.test(raw)) return null;

  const preferencePatterns = [
    /\b(prefiro|minha preferencia e|minha preferência é)\b/i,
    /\b(me chame de|quero ser chamado de|quero que me chame de)\b/i,
    /\b(daqui em diante|de agora em diante|sempre faça|sempre faca|sempre responda|não altere|nao altere)\b/i,
    /\b(quero que você sempre|quero que voce sempre|não quero que você|nao quero que voce)\b/i,
    /\b(quero que você (?:entenda|interprete|responda|se lembre|mantenha|considere|evite|priorize)|quero que voce (?:entenda|interprete|responda|se lembre|mantenha|considere|evite|priorize))\b/i,
    /\b(?:a partir de agora|quando eu pedir|quando eu solicitar|nas próximas conversas|nas proximas conversas)\b.{0,100}\b(?:quero|preciso|prefiro|entenda|interprete|responda|considere|evite|priorize|pesquise|lembre)\b/i,
  ];
  if (preferencePatterns.some((pattern) => pattern.test(raw)) && normalized.length >= 10) {
    return { type: "explicit_preference", category: "preferencia", content: raw, confidence: 0.95 };
  }

  const correctionPatterns = [
    /^corrigindo[: ,]/i,
    /^correção[: ,]/i,
    /^correcao[: ,]/i,
    /^na verdade[, :]/i,
    /^isso está errado[, :]/i,
    /^isso esta errado[, :]/i,
    /^você entendeu errado[, :]/i,
    /^voce entendeu errado[, :]/i,
    /\b(não foi isso que eu pedi|nao foi isso que eu pedi|não foi isso que eu quis dizer|nao foi isso que eu quis dizer|o que eu quis dizer foi|minha intenção era|minha intencao era)\b/i,
  ];
  if (correctionPatterns.some((pattern) => pattern.test(raw))) {
    return { type: "user_correction", category: null, content: raw, confidence: 0.8 };
  }
  return null;
}
