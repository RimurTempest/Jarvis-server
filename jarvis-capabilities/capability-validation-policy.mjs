import { verifyCapabilityEvidenceAttestation } from "./capability-evidence-attestation.mjs";

/**
 * Generic, fail-closed capability validation policy.
 * Every evidence item must be signed and bound to the exact capability ID and
 * full source revision being evaluated. A signature authenticates an issuer's
 * assertion; it does not independently prove the assertion factually true.
 */
const REQUIRED_BASE_EVIDENCE = Object.freeze([
  "source_review",
  "code_review",
  "automated_test",
]);
const ALLOWED_EVIDENCE_KINDS = new Set([
  ...REQUIRED_BASE_EVIDENCE,
  "security_review",
  "device_test",
]);
const ALLOWED_RISK_LEVELS = new Set(["standard", "elevated", "high"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsReference(value) {
  if (!nonEmpty(value) || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  if (!nonEmpty(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validCapabilityId(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
}

function validSourceRevision(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

export function requiredCapabilityEvidence(profile = {}) {
  const riskLevel = profile.riskLevel ?? "standard";
  if (!ALLOWED_RISK_LEVELS.has(riskLevel)) {
    throw new TypeError("riskLevel deve ser standard, elevated ou high.");
  }
  if (profile.requiresDeviceTest !== undefined && typeof profile.requiresDeviceTest !== "boolean") {
    throw new TypeError("requiresDeviceTest deve ser booleano.");
  }

  const required = [...REQUIRED_BASE_EVIDENCE];
  if (riskLevel === "elevated" || riskLevel === "high") required.push("security_review");
  if (profile.requiresDeviceTest === true) required.push("device_test");
  return required;
}

/**
 * Evidence is only eligible for the exact capability and full source revision
 * supplied by the registry. Missing expected bindings fail closed.
 */
export function evaluateCapabilityEvidence(
  evidence,
  profile = {},
  { trustedIssuers = {}, capabilityId, sourceRevision } = {},
) {
  let required;
  try {
    required = requiredCapabilityEvidence(profile);
  } catch (error) {
    return { ok: false, required: [], missing: [], invalid: [], reason: error.message };
  }

  if (!validCapabilityId(capabilityId)) {
    return { ok: false, required, missing: required, invalid: ["capabilityId esperado inválido."], reason: "capabilityId esperado inválido." };
  }
  if (!validSourceRevision(sourceRevision)) {
    return { ok: false, required, missing: required, invalid: ["sourceRevision esperado deve ser um SHA completo."], reason: "sourceRevision esperado inválido." };
  }
  if (!Array.isArray(evidence)) {
    return { ok: false, required, missing: required, invalid: [], reason: "evidence deve ser uma lista." };
  }

  const invalid = [];
  const passedKinds = new Set();
  evidence.forEach((item, index) => {
    const prefix = `evidence[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      invalid.push(`${prefix} deve ser um objeto.`);
      return;
    }
    if (!ALLOWED_EVIDENCE_KINDS.has(item.kind)) {
      invalid.push(`${prefix}.kind não é permitido.`);
      return;
    }
    if (!nonEmpty(item.summary) || item.summary.trim().length > 1000) {
      invalid.push(`${prefix}.summary inválido.`);
    }
    if (typeof item.passed !== "boolean") {
      invalid.push(`${prefix}.passed deve ser booleano.`);
    }
    if (!isHttpsReference(item.reference)) {
      invalid.push(`${prefix}.reference deve ser uma URL HTTPS válida.`);
    }
    if (!validTimestamp(item.observedAt)) {
      invalid.push(`${prefix}.observedAt deve ser um timestamp ISO válido.`);
    }
    if (!nonEmpty(item.scope) || item.scope.trim().length > 500) {
      invalid.push(`${prefix}.scope inválido.`);
    }
    if (item.capabilityId !== capabilityId) {
      invalid.push(`${prefix}.capabilityId não corresponde à capacidade avaliada.`);
    }
    if (item.sourceRevision !== sourceRevision) {
      invalid.push(`${prefix}.sourceRevision não corresponde à revisão avaliada.`);
    }
    if (!verifyCapabilityEvidenceAttestation(item, trustedIssuers)) {
      invalid.push(`${prefix}.attestation não é válida para um emissor confiável.`);
    }
    if (item.passed === true && ALLOWED_EVIDENCE_KINDS.has(item.kind)) passedKinds.add(item.kind);
  });

  const missing = required.filter((kind) => !passedKinds.has(kind));
  const ok = invalid.length === 0 && missing.length === 0 && evidence.every((item) => item?.passed === true);
  return {
    ok,
    required,
    missing,
    invalid,
    reason: ok ? null : "A política de evidências não foi satisfeita.",
  };
}
