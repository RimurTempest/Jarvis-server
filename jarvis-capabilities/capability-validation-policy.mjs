import { verifyCapabilityEvidenceAttestation } from "./capability-evidence-attestation.mjs";

/**
 * Generic, fail-closed capability validation policy.
 *
 * Evidence metadata is a checklist, not proof of authenticity. A trusted CI/device
 * executor must produce and authenticate evidence before final validation is allowed.
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
 * Evaluates completeness and consistency, not who created the evidence.
 * Evidence records must include a stable HTTPS reference, ISO timestamp and scope.
 */
export function evaluateCapabilityEvidence(evidence, profile = {}, { trustedIssuers = {} } = {}) {
  let required;
  try {
    required = requiredCapabilityEvidence(profile);
  } catch (error) {
    return { ok: false, required: [], missing: [], invalid: [], reason: error.message };
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
    if (!verifyCapabilityEvidenceAttestation(item, trustedIssuers)) {\n      invalid.push(`${prefix}.attestation não é válida para um emissor confiável.`);\n    }\n    if (item.passed === true && ALLOWED_EVIDENCE_KINDS.has(item.kind)) passedKinds.add(item.kind);
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
