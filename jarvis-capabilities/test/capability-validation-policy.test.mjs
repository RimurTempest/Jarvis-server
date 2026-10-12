import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCapabilityEvidence,
  requiredCapabilityEvidence,
} from "../capability-validation-policy.mjs";

const observedAt = "2026-10-12T00:00:00.000Z";

function evidence(kind, overrides = {}) {
  return {
    kind,
    summary: `Verificação de ${kind}`,
    passed: true,
    reference: `https://example.com/evidence/${kind}`,
    observedAt,
    scope: "escopo genérico de capacidade",
    ...overrides,
  };
}

test("standard policy requires research review, code review and automated tests", () => {
  assert.deepEqual(requiredCapabilityEvidence(), [
    "source_review", "code_review", "automated_test",
  ]);
  assert.equal(evaluateCapabilityEvidence([
    evidence("source_review"),
    evidence("code_review"),
    evidence("automated_test"),
  ]), { trustedIssuers: TRUSTED_ISSUERS }).ok, true);
});

test("elevated and high risk profiles require security review", () => {
  for (const riskLevel of ["elevated", "high"]) {
    const result = evaluateCapabilityEvidence([
      evidence("source_review"),
      evidence("code_review"),
      evidence("automated_test"),
    ], { riskLevel }, { trustedIssuers: TRUSTED_ISSUERS });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["security_review"]);
  }
});

test("device test is mandatory when the capability depends on real device execution", () => {
  const result = evaluateCapabilityEvidence([
    evidence("source_review"),
    evidence("code_review"),
    evidence("automated_test"),
  ], { requiresDeviceTest: true }, { trustedIssuers: TRUSTED_ISSUERS });
  assert.deepEqual(result.missing, ["device_test"]);
});

test("failed or malformed evidence prevents validation", () => {
  const result = evaluateCapabilityEvidence([
    evidence("source_review", { passed: false }),
    evidence("code_review", { reference: "http://insecure.example.com/review" }),
    evidence("automated_test", { observedAt: "not-a-date" }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.length >= 2);
  assert.ok(result.missing.includes("source_review"));
});

test("unknown evidence types and invalid profiles fail closed", () => {
  assert.equal(evaluateCapabilityEvidence([
    evidence("source_review"),
    evidence("code_review"),
    evidence("automated_test"),
    evidence("user_says_it_worked"),
  ], {}, { trustedIssuers: TRUSTED_ISSUERS }).ok, false);
  assert.equal(evaluateCapabilityEvidence([], { riskLevel: "unknown" }, { trustedIssuers: TRUSTED_ISSUERS }).ok, false);
  assert.throws(() => requiredCapabilityEvidence({ requiresDeviceTest: "yes" }), /booleano/);
});

test("evidence metadata is not described as authenticated provenance", () => {
  const result = evaluateCapabilityEvidence([
    evidence("source_review"),
    evidence("code_review"),
    evidence("automated_test"),
  ]);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, "authenticated"), false);
});
