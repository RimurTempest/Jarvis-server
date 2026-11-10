/**
 * Safe voice response streaming. Mirrors JARVIS Android 2.6's NDJSON
 * sentence-by-sentence speech contract, without giving the model tools,
 * persistent memory, automatic actions or a paid provider fallback.
 */
export function validateEphemeralHistory(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 6) {
    throw new TypeError("Histórico de conversa inválido.");
  }
  let chars = 0;
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !["user", "assistant"].includes(entry.role) ||
        typeof entry.content !== "string" ||
        entry.content.trim().length < 1 || entry.content.length > 350 ||
        /[\u0000-\u001f\u007f]/.test(entry.content)) {
      throw new TypeError("Turno de conversa inválido.");
    }
    chars += entry.content.length;
    if (chars > 1600) throw new TypeError("Histórico muito longo.");
    return { role: entry.role, content: entry.content.trim() };
  });
}

export function createSafeVoiceMessages(message, history = []) {
  return [
    {
      role: "system",
      content: "Você é JARVIS, assistente pessoal do Senhor. Converse naturalmente em português brasileiro, em respostas curtas e fluidas, com frases faláveis. Trate o usuário por Senhor quando natural. Use o histórico apenas para continuidade desta sessão, sem alegar memória permanente. Você não possui ferramentas neste canal: não pode navegar, executar ações, alterar o celular, pesquisar notícias ou instalar programas. Não afirme que executou nenhuma dessas ações. Não solicite senhas, cartões ou tokens. Se não souber informações atuais, admita a limitação.",
    },
    ...validateEphemeralHistory(history),
    { role: "user", content: message },
  ];
}

export function safeStreamLine(type, fields = {}) {
  return JSON.stringify({ type, ...fields }) + "\n";
}

export async function consumeSafeChatStream(stream, onDelta, maxChars = 3000) {
  if (typeof onDelta !== "function" || !stream?.[Symbol.asyncIterator]) {
    throw new TypeError("Resposta do provedor não é um fluxo de texto.");
  }
  let length = 0;
  let parts = 0;
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta !== "string" || !delta) continue;
    if (++parts > 2500) throw new Error("Fluxo de texto excessivo.");
    const available = maxChars - length;
    if (available <= 0) break;
    const segment = delta.slice(0, available);
    length += segment.length;
    onDelta(segment);
    if (length >= maxChars) break;
  }
  return length;
}
