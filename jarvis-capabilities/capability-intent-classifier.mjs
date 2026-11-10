function normalizeIntentText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ACTION_CUES = /\b(send|sending|email|e-mail|call|calling|phone|dial|schedule|book|reserve|open|install|configure|connect|download|upload|publish|submit|pay|buy|purchase|create|make|run|execute|automate|organize|delete|edit|change|turn on|turn off|search|find|look up|research|analyze|analyse|summarize|translate|compare|monitor|check|verify|identify|recognize|scan|transcribe|convert|calculate|remind|notify|track|fix|repair|optimize|integrate|sync|filter|classify|extract|generate|prepare|review|inspect|detect|discover|faca|fazer|ligar|ligacao|telefonar|telefonema|enviar|manda|mandar|mande|envie|envia|agendar|agende|marcar|marque|reservar|reserve|abrir|abra|instalar|instale|configurar|configure|conectar|conecte|baixar|baixe|descarregar|publicar|publique|pagar|pague|comprar|compre|criar|crie|executar|execute|automatizar|automatize|organizar|organize|apagar|excluir|editar|alterar|ativar|desativar|resolver|resolva|preparar|prepare|realizar|realize|pesquisar|pesquise|pesquisa|pesquisasse|procurar|procure|procurasse|buscar|busque|buscasse|encontrar|encontre|encontrasse|analisar|analise|analisasse|resumir|resuma|resumisse|traduzir|traduza|traduzisse|comparar|compare|comparasse|monitorar|monitore|monitorasse|verificar|verifique|verificasse|identificar|identifique|identificasse|reconhecer|reconheca|reconhecesse|escanear|escaneie|escaneasse|digitalizar|digitalize|digitalizasse|transcrever|transcreva|transcrevesse|converter|converta|convertesse|calcular|calcule|calculasse|lembrar|lembre|notificar|notifique|acompanhar|acompanhe|acompanhasse|corrigir|corrija|corrigisse|consertar|conserte|consertasse|otimizar|otimize|otimizasse|integrar|integre|integrasse|sincronizar|sincronize|sincronizasse|filtrar|filtre|filtrasse|classificar|classifique|classificasse|extrair|extraia|extraisse|gerar|gere|gerasse|revisar|revise|revisasse|inspecionar|inspecione|inspecionasse|detectar|detecte|detectasse|descobrir|descubra|descobrisse)\b/i;
const REQUEST_CUES = /\b(can you|could you|would you|please|i need you to|i want you to|i want to|i need to|help me|do this|take care of|handle this|quero|preciso|pode|poderia|gostaria|eu queria|por favor|me ajude|me ajuda|fa[cç]a|faz|consegue|conseguiria|voce consegue|voce pode|voce poderia|ser[aá] que voce pode|mande|manda|envie|envia|ligue|liga|telefone|agende|agendar|marque|marcar|reserve|reservar|abra|abrir|instale|instalar|configure|configurar|conecte|conectar|baixe|baixar|publique|publicar|pague|pagar|compre|comprar|crie|criar|execute|executar|automatize|organize|resolva|prepare|realize|pesquise|procure|busque|encontre|analise|resuma|traduza|compare|monitore|verifique|identifique|escaneie|digitalize|transcreva|converta|calcule|lembre|notifique|acompanhe|corrija|conserte|otimize|integre|sincronize|filtre|classifique|extraia|gere|revise|inspecione|detecte|descubra|cuide de|resolve pra mim|do it for me|take care of it)\b/i;
const INFORMATIONAL_CUES = /^(how do i|how can i|how does|what is|why does|explain|teach me|tell me how|como eu faco|como faco|como posso|como funciona|o que e|por que|me explique|explique|me ensine|ensine|quero aprender a|gostaria de aprender a|me diga como|pode me explicar|poderia me explicar)\b/i;

/** Cheap candidate filter; the model makes the actual intent decision. */
export function shouldClassifyCapabilityIntent(message) {
  const raw = String(message ?? "").trim();
  if (raw.length < 8 || raw.length > 8000) return false;
  const normalized = normalizeIntentText(raw);
  if (INFORMATIONAL_CUES.test(normalized)) return false;
  return ACTION_CUES.test(normalized) && REQUEST_CUES.test(normalized);
}

/** Parse classifier JSON; malformed responses fail closed to ordinary chat. */
export function parseCapabilityIntentClassification(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4000) return null;
  const candidate = raw.trim()
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/, "");
  let value;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.shouldResearch !== "boolean") return null;
  if (!value.shouldResearch) return { shouldResearch: false, goal: null };
  if (typeof value.goal !== "string") return null;
  const goal = value.goal.trim().replace(/[.!?]+$/, "").trim();
  if (goal.length < 3 || goal.length > 3500) return null;
  if (/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|senha|secret)\s*[:=]\s*\S+/i.test(goal) ||
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(goal) ||
      /\b(?:\d[ -]*?){10,}\b/.test(goal)) return null;
  return { shouldResearch: true, goal };
}
