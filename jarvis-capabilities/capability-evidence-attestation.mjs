import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNED_FIELDS = Object.freeze([
  "kind",
  "summary",
  "passed",
  "reference",
  "observedAt",
  "scope",
  "capabilityId",
  "sourceRevision",
]);

const ALLOWED_ISSUERS = new Set([
  "source-review-runner",
  "code-review-runner",
  "automated-test-runner",
  "security-review-runner",
  "android-device-test-runner",
]);

function validSecret(secret) {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
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

function canonicalEvidence(evidence) {
  const payload = {};
  for (const field of SIGNED_FIELDS) payload[field] = evidence[field];
  return JSON.stringify(payload);
}

function signatureFor(evidence, issuer, secret) {
  return createHmac("sha256", secret)
    .update("jarvis-capability-evidence-v1\n", "utf8")
    .update(issuer, "utf8")
    .update("\n", "utf8")
    .update(canonicalEvidence(evidence), "utf8")
    .digest("base64url");
}

const ISSUER_ENV_VARS = Object.freeze({
  "source-review-runner": "JARVIS_EVIDENCE_KEY_SOURCE_REVIEW",
  "code-review-runner": "JARVIS_EVIDENCE_KEY_CODE_REVIEW",
  "automated-test-runner": "JARVIS_EVIDENCE_KEY_AUTOMATED_TEST",
  "security-review-runner": "JARVIS_EVIDENCE_KEY_SECURITY_REVIEW",
  "android-device-test-runner": "JARVIS_EVIDENCE_KEY_DEVICE_TEST",
});

/**
 * Load issuer secrets from server/runner environment without logging them.
 * Missing or short secrets are omitted; verification then fails closed.
 */
export function loadTrustedCapabilityEvidenceIssuers(env = process.env) {
  const trusted = Object.create(null);
  for (const [issuer, variable] of Object.entries(ISSUER_ENV_VARS)) {
    const secret = env?.[variable];
    if (validSecret(secret)) trusted[issuer] = secret;
  }
  return trusted;
}

/**
 * Sign evidence in a trusted runner only. Evidence is bound to one capability
 * ID and one full source commit SHA to prevent cross-capability/revision replay.
 * The secret must never be sent by a client or stored in evidence records.
 */
export function attestCapabilityEvidence(evidence, { issuer, secret } = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("evidence deve ser um objeto.");
  }
  if (!ALLOWED_ISSUERS.has(issuer)) throw new TypeError("issuer não permitido.");
  if (!validSecret(secret)) throw new TypeError("O segredo do emissor deve ter pelo menos 32 bytes.");
  for (const field of SIGNED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(evidence, field)) {
      throw new TypeError(`evidence.${field} é obrigatório.`);
    }
  }
  if (!validCapabilityId(evidence.capabilityId)) {
    throw new TypeError("evidence.capabilityId inválido.");
  }
  if (!validSourceRevision(evidence.sourceRevision)) {
    throw new TypeError("evidence.sourceRevision deve ser um SHA completo de 40 ou 64 caracteres hexadecimais.");
  }
  return {
    ...evidence,
    attestation: {
      version: 1,
      issuer,
      signature: signatureFor(evidence, issuer, secret),
    },
  };
}

/**
 * trustedIssuers maps trusted issuer names to secrets kept on the trusted
 * server/runner. Missing configuration, unknown issuers, malformed binding,
 * and tampering all fail closed.
 */
export function verifyCapabilityEvidenceAttestation(evidence, trustedIssuers = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  if (!validCapabilityId(evidence.capabilityId) || !validSourceRevision(evidence.sourceRevision)) return false;
  const attestation = evidence.attestation;
  if (
    !attestation ||
    attestation.version !== 1 ||
    !ALLOWED_ISSUERS.has(attestation.issuer) ||
    typeof attestation.signature !== "string"
  ) return false;

  const secret = trustedIssuers?.[attestation.issuer];
  if (!validSecret(secret)) return false;

  let expected;
  try {
    expected = Buffer.from(signatureFor(evidence, attestation.issuer, secret), "base64url");
  } catch {
    return false;
  }
  let actual;
  try {
    actual = Buffer.from(attestation.signature, "base64url");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
