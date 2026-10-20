/**
 * Broad gate for semantic capability-intent classification.
 * This is only a cost-saving filter; the model makes the actual intent decision.
 */
function normalizeIntentText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ACTION_CUES = /\b(send|sending|email|e-mail|call|calling|phone|dial|schedule|book|reserve|open|install|configure|connect|download|upload|publish|submit|pay|buy|purchase|create|make|run|execute|automate|organize|delete|edit|change|turn on|turn off|faca|fazer|ligar|ligacao|telefonar|telefonema|enviar|mande|mandar|envie|email|e-mail|agendar|marcar|reservar|abrir|instalar|configurar|conectar|baixar|descarregar|publicar|pagar|comprar|criar|fazer|executar|automatizar|organizar|apagar|excluir|editar|alterar|ativar|desativar|resolver|preparar|realizar)\b/i;
const REQUEST_CUES = /\b(can you|could you|would you|please|i need you to|i want you to|i want to|i need to|help me|do this|take care of|handle this|quero|preciso|pode|poderia|gostaria|por favor|me ajude|me ajuda|fa[cç]a|faz|consegue|conseguiria|mande|envie|ligue|telefone|agende|marque|reserve|abra|instale|configure|conecte|baixe|publique|pague|compre|crie|execute|automatize|organize|resolva|prepare|realize|envia|envie|liga|ligue|faz isso|cuide de|resolve pra mim)\b/i;
const INFORMATIONAL_CUES = /^(how do i|how can i|how does|what is|why does|explain|teach me|como eu faco|como faco|como posso|como funciona|o que e|por que|me explique|explique|me ensine|ensine|quero aprender a|gostaria de aprender a)\b/i;

/** Returns true only when a message plausibly asks for task execution. */
export function shouldClassifyCapabilityIntent(message) {
  const raw = String(message ?? "").trim();
  if (raw.length < 8 || raw.length > 8000) return false;
  const normalized = normalizeIntentText(raw);
  if (INFORMATIONAL_CUES.test(normalized)) return false;
  return ACTION_CUES.test(normalized) && REQUEST_CUES.test(normalized);
}

/**
 * Parse a model classifier response. Invalid output returns null so callers can
 * safely fall back to ordinary chat rather than inventing a capability request.
 */
export function parseCapabilityIntentClassification(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4000) return null;
  let candidate = raw.trim();
  candidate = candidate.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  let value;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.shouldResearch !== "boolean") return null;
  if (!value.shouldResearch) return { shouldResearch: false, goal: null };
  if (typeof value.goal !== "string") return null;
  const goal = value.goal.trim().replace(/[.!?]+$/, "").trim();
  if (goal.length < 3 || goal.length > 3500) return null;
  return { shouldResearch: true, goal };
}
