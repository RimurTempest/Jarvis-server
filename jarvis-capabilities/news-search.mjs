import { validateAndroidAction, createAndroidActionEnvelope } from "./android-action-protocol.mjs";

function sanitizeString(value, field, max = 500) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} deve ser um texto não vazio.`);
  }
  const clean = value.trim();
  if (clean.length > max) throw new RangeError(`${field} excede o tamanho máximo de ${max} caracteres.`);
  return clean;
}

function validateDateRange(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new TypeError("Datas de início e fim devem ser válidas.");
  }
  if (startDate > endDate) {
    throw new RangeError("A data de início não pode ser posterior à data de término.");
  }
  return { start: startDate.toISOString().split("T")[0], end: endDate.toISOString().split("T")[0] };
}

/**
 * Builds and validates a news article search query payload adhering to standard filters.
 */
searchNewsArticles({
  source,
  politicalFigure,
  startDate,
  endDate,
  maxResults = 10,
} = {}) {
  const cleanSource = sanitizeString(source, "source", 100);
  const cleanFigure = sanitizeString(politicalFigure, "politicalFigure", 150);
  const dates = validateDateRange(startDate, endDate);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new RangeError("maxResults deve estar entre 1 e 100.");
  }

  return {
    query: `${cleanFigure}`,
    filterQuery: `source:("${cleanSource}")`,
    dateRange: dates,
    maxResults,
    constructedAt: new Date().toISOString(),
  };
}
