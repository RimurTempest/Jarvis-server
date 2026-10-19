/**
 * Detects generic user requests for JARVIS to learn a new capability.
 * It extracts the task goal without embedding task-specific actions.
 */
export function detectCapabilityLearningRequest(message) {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 4000) return null;

  const patterns = [
    /^(?:jarvis[,! ]+)?aprenda\s+(?:a\s+)?(?:fazer|realizar|executar|usar|conseguir|como\s+fazer|como\s+realizar|como\s+usar)\s+(.+?)\s*[.!?]*$/i,
    /^(?:quero\s+que\s+voc[eê]\s+)?aprenda\s+(?:a\s+)?(?:fazer|realizar|executar|usar|conseguir|como\s+fazer|como\s+realizar|como\s+usar)\s+(.+?)\s*[.!?]*$/i,
    /^(?:quero\s+que\s+voc[eê]\s+)?aprenda\s+(.+?)\s*[.!?]*$/i,
    /^(?:jarvis[,! ]+)?aprenda\s+(?:a\s+)?(.+?)\s*[.!?]*$/i,
    /^(?:learn\s+to|learn\s+how\s+to)\s+(.+?)\s*[.!?]*$/i,
    /^(?:i\s+want\s+you\s+to\s+learn\s+to)\s+(.+?)\s*[.!?]*$/i,
    /^(?:jarvis[,! ]+)?quero\s+que\s+voc[eê]\s+(?:passe\s+a\s+)?(?:consiga|conseguir|possa|seja\s+capaz\s+de)\s+(.+?)\s*[.!?]*$/i,
    /^(?:quero\s+que\s+voc[eê]\s+)?(?:adicione|implemente|desenvolva|crie)\s+(?:a\s+|uma\s+)?(?:capacidade|fun[cç][aã]o|recurso)\s+(?:de|para)\s+(.+?)\s*[.!?]*$/i,
    /^(?:quero|preciso)\s+(?:de\s+)?(?:uma\s+)?(?:nova\s+)?(?:capacidade|fun[cç][aã]o|recurso)\s+(?:para|de)\s+(.+?)\s*[.!?]*$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const goal = String(match[match.length - 1] ?? "").trim().replace(/[.!?]+$/, "").trim();
    if (goal.length < 3 || goal.length > 3500) return null;
    if (/^(?:aqui|isso|aquilo|essa tarefa|esta tarefa)$/i.test(goal)) return null;
    // Do not turn a concrete, immediate action into a software-development job.
    if (/^(?:enviar|mandar|escrever)\s+(?:um|uma)\s+e-?mail\s+(?:para|ao|à)\b/i.test(goal)) return null;
    if (/^(?:fazer|iniciar|realizar)\s+(?:uma\s+)?(?:liga[cç][aã]o|chamada)\s+(?:para|com)\b/i.test(goal)) return null;
    return { goal, originalRequest: raw };
  }
  return null;
}
