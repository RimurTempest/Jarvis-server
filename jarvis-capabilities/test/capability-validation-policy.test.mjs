import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCapabilityEvidence, requiredCapabilityEvidence } from "../capability-validation-policy.mjs";
import { attestCapabilityEvidence } from "../capability-evidence-attestation.mjs";

const observedAt = "2026-10-12T00:00:00.000Z";
const capabilityId = "policy-task-01";
const sourceRevision = "b".repeat(40);
const TRUSTED_ISSUERS = {
  "source-review-runner": "test-source-review-secret-0123456789abcdef",
  "code-review-runner": "test-code-review-secret-0123456789abcdef",
  "automated-test-runner": "test-automated-test-secret-0123456789abcdef",
  "security-review-runner": "test-security-review-secret-0123456789abcdef",
  "android-device-test-runner": "test-device-test-secret-0123456789abcdef",
};
const ISSUER_BY_KIND = {
  source_review: "source-review-runner",
  code_review: "code-review-runner",
  automated_test: "automated-test-runner",
  security_review: "security-review-runner",
  device_test: "android-device-test-runner",
};
function evidence(kind, overrides = {}) {
  const raw = {
    kind, summary: `Verificação de ${kind}`, passed: true,
    reference: `https://example.com/evidence/${kind}`, observedAt,
    scope: "escopo genérico de capacidade", capabilityId, sourceRevision, ...overrides,
  };
  return attestCapabilityEvidence(raw, { issuer: ISSUER_BY_KIND[kind], secret: TRUSTED_ISSUERS[ISSUER_BY_KIND[kind]] });
}
const options = { trustedIssuers: TRUSTED_ISSUERS, capabilityId, sourceRevision };

test("standard policy requires signed source review, code review and automated tests", () => {
  assert.deepEqual(requiredCapabilityEvidence(), ["source_review", "code_review", "automated_test"]);
  assert.equal(evaluateCapabilityEvidence([evidence("source_review"), evidence("code_review"), evidence("automated_test")], {}, options).ok, true);
});
test("elevated and high risk profiles require security review", () => {
  for (const riskLevel of ["elevated", "high"]) {
    const result = evaluateCapabilityEvidence([evidence("source_review"), evidence("code_review"), evidence("automated_test")], { riskLevel }, options);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["security_review"]);
  }
});
test("device test is mandatory when real device execution is claimed", () => {
  const result = evaluateCapabilityEvidence([evidence("source_review"), evidence("code_review"), evidence("automated_test")], { requiresDeviceTest: true }, options);
  assert.deepEqual(result.missing, ["device_test"]);
});
test("failed or malformed evidence prevents validation", () => {
  const result = evaluateCapabilityEvidence([
    evidence("source_review", { passed: false }),
    evidence("code_review", { reference: "http://insecure.example.com/review" }),
    evidence("automated_test", { observedAt: "not-a-date" }),
  ], {}, options);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.length >= 2);
  assert.ok(result.missing.includes("source_review"));
});
test("unknown evidence types and invalid profiles fail closed", () => {
  const result = evaluateCapabilityEvidence([
    evidence("source_review"), evidence("code_review"), evidence("automated_test"),
    { ...evidence("automated_test"), kind: "user_says_it_worked" },
  ], {}, options);
  assert.equal(result.ok, false);
  assert.equal(evaluateCapabilityEvidence([], { riskLevel: "unknown" }, options).ok, false);
  assert.throws(() => requiredCapabilityEvidence({ requiresDeviceTest: "yes" }), /booleano/);
});
test("missing trusted issuer configuration prevents validation", () => {
  const result = evaluateCapabilityEvidence([evidence("source_review"), evidence("code_review"), evidence("automated_test")]);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.some((item) => item.includes("attestation")));
});
test("attestation tampering is detected", () => {
  const item = evidence("source_review");
  const altered = { ...item, scope: "different scope" };
  const result = evaluateCapabilityEvidence([altered, evidence("code_review"), evidence("automated_test")], {}, options);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.some((entry) => entry.includes("attestation")));
});


test("evidence cannot be replayed for another capability or source revision", () => {
  const source = evidence("source_review");
  const otherCapability = evaluateCapabilityEvidence(
    [{ ...source, capabilityId: "other-capability" }, evidence("code_review"), evidence("automated_test")],
    {},
    options,
  );
  assert.equal(otherCapability.ok, false);
  assert.ok(otherCapability.invalid.some((entry) => entry.includes("capabilityId")));
  const otherRevision = evaluateCapabilityEvidence(
    [{ ...source, sourceRevision: "c".repeat(40) }, evidence("code_review"), evidence("automated_test")],
    {},
    options,
  );
  assert.equal(otherRevision.ok, false);
  assert.ok(otherRevision.invalid.some((entry) => entry.includes("sourceRevision")));
});

test("validation fails closed when expected capability or revision is absent", () => {
  const records = [evidence("source_review"), evidence("code_review"), evidence("automated_test")];
  assert.equal(evaluateCapabilityEvidence(records, {}, { trustedIssuers: TRUSTED_ISSUERS }).ok, false);
  assert.equal(evaluateCapabilityEvidence(records, {}, { ...options, sourceRevision: "short" }).ok, false);
});
