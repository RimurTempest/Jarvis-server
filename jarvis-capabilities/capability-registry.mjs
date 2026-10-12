/**
 * JARVIS generic capability lifecycle.
 *
 * This module records capability state; it does not claim to execute Android
 * actions. A capability becomes reusable only after independent test evidence
 * is recorded. Discovery text is treated as untrusted data, never as code.
 */

export const CAPABILITY_STATES = Object.freeze([
  "requested",
  "researching",
  "prepared",
  "testing",
  "validated",
  "blocked",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  requested: new Set(["researching", "blocked"]),
  researching: new Set(["prepared", "blocked"]),
  prepared: new Set(["testing", "blocked"]),
  testing: new Set(["validated", "prepared", "blocked"]),
  validated: new Set(["researching", "testing", "blocked"]),
  blocked: new Set(["researching"]),
});

const MAX_ID_LENGTH = 100;
const MAX_TEXT_LENGTH = 4000;

function cleanText(value, field, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} deve ser um texto não vazio.`);
  }
  const cleaned = value.trim();
  if (cleaned.length > max) {
    throw new RangeError(`${field} excede o limite de ${max} caracteres.`);
  }
  return cleaned;
}

function cleanId(value) {
  const id = cleanText(value, "id", MAX_ID_LENGTH);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) {
    throw new TypeError("id contém caracteres não permitidos.");
  }
  return id;
}

function cleanEvidenceList(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("evidence deve ser uma lista.");
  }
  if (value.length > 30) {
    throw new RangeError("evidence aceita no máximo 30 itens.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`evidence[${index}] deve ser um objeto.`);
    }
    const kind = cleanText(item.kind, `evidence[${index}].kind`, 40);
    const summary = cleanText(item.summary, `evidence[${index}].summary`, 1000);
    const passed = item.passed;
    if (typeof passed !== "boolean") {
      throw new TypeError(`evidence[${index}].passed deve ser booleano.`);
    }
    return { kind, summary, passed };
  });
}

export function createCapabilityRequest({ id, goal, requestedBy = "user" }) {
  const now = new Date().toISOString();
  return {
    id: cleanId(id),
    goal: cleanText(goal, "goal"),
    requestedBy: cleanText(requestedBy, "requestedBy", 100),
    state: "requested",
    research: null,
    requirements: [],
    executionPlan: null,
    evidence: [],
    validation: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply a lifecycle event immutably. Only explicit test evidence can validate
 * a capability; research or a prepared plan alone never does.
 */
export function transitionCapability(current, event) {
  if (!current || typeof current !== "object" || !CAPABILITY_STATES.includes(current.state)) {
    throw new TypeError("Registro de capacidade inválido.");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("Evento de capacidade inválido.");
  }

  const nextState = cleanText(event.state, "state", 30);
  if (!CAPABILITY_STATES.includes(nextState)) {
    throw new TypeError("Estado de capacidade desconhecido.");
  }
  if (!ALLOWED_TRANSITIONS[current.state].has(nextState)) {
    throw new Error(`Transição não permitida: ${current.state} -> ${nextState}.`);
  }

  const next = { ...current, updatedAt: new Date().toISOString() };

  if (event.research !== undefined) {
    next.research = cleanText(event.research, "research");
  }
  if (event.requirements !== undefined) {
    if (!Array.isArray(event.requirements) || event.requirements.length > 50) {
      throw new TypeError("requirements deve ser uma lista de até 50 itens.");
    }
    next.requirements = event.requirements.map((item, index) =>
      cleanText(item, `requirements[${index}]`, 500)
    );
  }
  if (event.executionPlan !== undefined) {
    next.executionPlan = cleanText(event.executionPlan, "executionPlan");
  }
  if (event.evidence !== undefined) {
    next.evidence = cleanEvidenceList(event.evidence);
  }

  if (nextState === "validated") {
    if (!next.executionPlan) {
      throw new Error("A capacidade não pode ser validada sem um plano de execução.");
    }
    if (!next.evidence.length || next.evidence.some((item) => !item.passed)) {
      throw new Error("A capacidade só pode ser validada com evidências de teste presentes e aprovadas.");
    }
    next.validation = {
      status: "validated",
      evidenceCount: next.evidence.length,
      validatedAt: new Date().toISOString(),
    };
  } else if (nextState === "blocked") {
    next.validation = {
      status: "blocked",
      reason: cleanText(event.reason, "reason", 1000),
      blockedAt: new Date().toISOString(),
    };
  } else if (nextState !== "validated") {
    next.validation = null;
  }

  next.state = nextState;
  return next;
}

export function capabilityCanBeReused(capability) {
  return Boolean(
    capability &&
    capability.state === "validated" &&
    capability.validation?.status === "validated" &&
    capability.executionPlan &&
    Array.isArray(capability.evidence) &&
    capability.evidence.length > 0 &&
    capability.evidence.every((item) => item.passed === true)
  );
}
