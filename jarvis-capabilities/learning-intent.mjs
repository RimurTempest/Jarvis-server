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
    /^(?:quero\s+que\s+voc[eê]\s+(?:consiga|possa|seja\s+capaz\s+de)|preciso\s+que\s+voc[eê]\s+(?:consiga|possa)|voc[eê]\s+precisa\s+conseguir)\s+(.+?)\s*[.!?]*$/i,
    /^(?:i\s+want\s+you\s+to\s+(?:be\s+able\s+to|learn\s+to)|you\s+need\s+to\s+be\s+able\s+to)\s+(.+?)\s*[.!?]*$/i,
    /^(?:learn\s+to|learn\s+how\s+to)\s+(.+?)\s*[.!?]*$/i,
    /^(?:i\s+want\s+you\s+to\s+learn\s+to)\s+(.+?)\s*[.!?]*$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const goal = String(match[match.length - 1] ?? "").trim().replace(/[.!?]+$/, "").trim();
    if (goal.length < 3 || goal.length > 3500) return null;
    if (/^(?:aqui|isso|aquilo|essa tarefa|esta tarefa)$/i.test(goal)) return null;
    return { goal, originalRequest: raw };
  }
  return null;
}
