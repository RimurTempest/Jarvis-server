import { validateAndroidAction } from "./android-action-protocol.mjs";

function normalizePortuguese(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Conservative front gate: only classify messages that look like direct,
 * present-tense requests to perform an action now. This is not authorization;
 * every accepted action is validated and the Android client must confirm it.
 */
export function isDirectAndroidActionRequest(message) {
  const text = normalizePortuguese(message);
  if (!text || text.length > 4000) return false;

  // A request clause containing explicit negation must never become an action proposal.
  if (/\\b(?:nao|nunca|jamais)\\s+(?:por favor\\s+)?(?:abr[ae]|abrir|acesse|acessa|acessar|visite|visitar|ligue|ligar|copie|copiar|va para|vai para)\\b/.test(text)) return false;

  const imperativeAtStart = /^(?:(?:jarvis|por favor|por gentileza)[,:\\s]*)*(?:pode\\s+)?(?:abr[ae]|abrir|acesse|acessa|acessar|visite|visitar|ligue|ligar|copie|copiar|va para|vai para)\\b/.test(text);
  const explicitRequest = /\\b(quero que voce|preciso que voce|peco que voce)\\b.{0,100}\\b(abra|abrir|acesse|acessar|visite|ligue|ligar|copie|copiar)\\b/.test(text);
  return imperativeAtStart || explicitRequest;
}

const ACTION_TOOL = {
  type: "function",
  function: {
    name: "propose_android_action",
    description: "Propose one allowlisted Android action only when the user explicitly asks to perform it now. Never propose actions for hypotheticals, explanations, quoted text, research, or requests to learn how.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "object",
          additionalProperties: false,
          required: ["type", "packageName", "url", "phoneNumber", "setting", "text"],
          properties: {
            type: { type: "string", enum: ["open_app", "open_url", "dial_number", "open_settings", "copy_text"] },
            packageName: { type: ["string", "null"], maxLength: 255 },
            url: { type: ["string", "null"], maxLength: 2048 },
            phoneNumber: { type: ["string", "null"], maxLength: 40 },
            setting: { type: ["string", "null"], enum: ["wifi", "bluetooth", "display", "sound", "accessibility", "app_details", "default_apps", null] },
            text: { type: ["string", "null"], maxLength: 2000 }
          }
        }
      }
    }
  }
};

const ACTION_FIELDS = ["packageName", "url", "phoneNumber", "setting", "text"];

function proposalMatchesUserMessage(action, message) {
  const raw = String(message ?? "");
  const normalized = normalizePortuguese(raw);

  switch (action.type) {
    case "open_app":
      // Never trust a model-inferred package name. It must be present verbatim.
      return normalized.includes(String(action.packageName ?? "").toLowerCase());
    case "open_url": {
      const suppliedUrls = raw.match(/https?:\/\/[^\s<>"']+/gi) || [];
      let proposed;
      try { proposed = new URL(action.url); } catch { return false; }
      return suppliedUrls.some((rawUrl) => {
        let supplied;
        try { supplied = new URL(rawUrl.replace(/[),.!?;]+$/, "")); } catch { return false; }
        return supplied.protocol === proposed.protocol &&
          supplied.hostname.toLowerCase() === proposed.hostname.toLowerCase() &&
          supplied.port === proposed.port &&
          supplied.pathname === proposed.pathname &&
          supplied.search === proposed.search &&
          supplied.hash === proposed.hash;
      });
    }
    case "dial_number": {
      // Match one complete number supplied by the user; do not accept a shorter
      // suffix or silently drop a country/area code suggested by the model.
      const suppliedNumbers = raw.match(/\+?\d[\d ()-]{2,35}\d/g) || [];
      const proposedDigits = String(action.phoneNumber ?? "").replace(/\D/g, "");
      return suppliedNumbers.some((number) =>
        number.replace(/\D/g, "") === proposedDigits
      );
    }
    case "copy_text":
      return Boolean(action.text) && normalized.includes(normalizePortuguese(action.text));
    case "open_settings": {
      const settingTerms = {
        wifi: /\bwi[- ]?fi\b/,
        bluetooth: /\bbluetooth\b/,
        display: /\b(tela|visor|brilho|display)\b/,
        sound: /\b(som|volume|audio)\b/,
        accessibility: /\b(acessibilidade)\b/,
        app_details: /\b(detalhes do app|detalhes do aplicativo|informacoes do app)\b/,
        default_apps: /\b(aplicativos padrao|apps padrao)\b/,
      };
      return Boolean(settingTerms[action.setting]?.test(normalized));
    }
    default:
      return false;
  }
}

/**
 * Uses the configured provider only as an intent parser. Its output is
 * untrusted: protocol validation and user-message binding are both required.
 */
export async function proposeAndroidAction(provider, message) {
  if (!provider?.client?.chat?.completions?.create || typeof provider.model !== "string") {
    throw new TypeError("Provedor de IA inválido.");
  }
  if (!isDirectAndroidActionRequest(message)) return null;

  const completion = await provider.client.chat.completions.create({
    model: provider.model,
    messages: [
      {
        role: "system",
        content: [
          "Você é um classificador de intenção para ações locais do Android, não um executor.",
          "Só chame a ferramenta quando a mensagem pedir claramente uma ação agora.",
          "Nunca infira número de telefone, URL, texto para copiar ou nome de pacote que o usuário não forneceu.",
          "Para abrir um aplicativo, packageName deve ser um nome de pacote explicitamente fornecido pelo usuário; não adivinhe pacotes a partir de nomes comerciais.",
          "Para abrir configurações, escolha apenas o identificador permitido que corresponda ao pedido explícito.",
          "Se a intenção ou os dados estiverem ambíguos, não chame a ferramenta.",
          "Não execute nem proponha comandos de shell, JavaScript, intents arbitrários ou ações fora da ferramenta."
        ].join(" ")
      },
      { role: "user", content: String(message).slice(0, 4000) }
    ],
    tools: [ACTION_TOOL],
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_completion_tokens: 250,
    stream: false
  }, {
    // OpenAI-compatible SDK request options belong in the second argument;
    // putting timeout in the JSON body does not enforce a client-side deadline.
    timeout: 8000,
    maxRetries: 0
  });

  const calls = completion?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) return null;
  const call = calls[0];
  if (call?.type !== "function" || call?.function?.name !== "propose_android_action") return null;

  let parsed;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    return null;
  }
  if (!parsed?.action || typeof parsed.action !== "object" || Array.isArray(parsed.action)) return null;

  const candidate = { type: parsed.action.type };
  for (const field of ACTION_FIELDS) {
    if (parsed.action[field] !== null && parsed.action[field] !== undefined) {
      candidate[field] = parsed.action[field];
    }
  }

  try {
    const validated = validateAndroidAction(candidate);
    if (!proposalMatchesUserMessage(validated, message)) return null;
    return validated;
  } catch {
    // Invalid or ungrounded model output must never enter the queue.
    return null;
  }
}
