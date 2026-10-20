function normalizeSourceRequest(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATIVE_SOURCE_REQUEST = /\b(?:nao\s+(?:quero|preciso|mostre|mostra|cite|citar|inclua|inclua|traga|coloque|adicione|apresente|exiba)|sem|dispense|dispensa)\s+(?:as?\s+)?(?:fontes|referencias|citacoes|links|urls|bibliografia)\b|\bnao\s+(?:cite|citar|mostre|mostrar|inclua|incluir|traga|trazer|coloque|colocar|adicione|adicionar|apresente|apresentar|exiba|exibir)\s+(?:as?\s+)?(?:fontes|referencias|citacoes|links|urls)\b/;

const POSITIVE_SOURCE_REQUEST = /\b(?:me\s+mostre|mostre|mostra|traga|cite|citar|inclua|coloque|adicione|apresente|exiba|quais\s+sao|qual\s+e|onde\s+estao|de\s+onde\s+(?:voce|vc)\s+tirou|quero\s+(?:ver\s+)?|preciso\s+das?)\s+(?:as?\s+)?(?:fontes|referencias|citacoes|links|urls|bibliografia)\b|\b(?:fontes|referencias|citacoes|links|urls|bibliografia)\s+(?:consultadas|utilizadas|usadas|originais|oficiais)\b|\b(?:com\s+fontes|inclua\s+as\s+fontes|traga\s+as\s+fontes|mostre\s+as\s+fontes)\b/;

export function shouldShowSources(message) {
  const text = normalizeSourceRequest(message);
  if (!text) return false;
  if (NEGATIVE_SOURCE_REQUEST.test(text)) return false;
  if (POSITIVE_SOURCE_REQUEST.test(text)) return true;
  return /^(?:fontes|referencias|citacoes|links|urls|bibliografia)$/.test(text);
}
