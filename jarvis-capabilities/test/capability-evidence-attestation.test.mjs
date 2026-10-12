import test from "node:test";
import assert from "node:assert/strict";
import { attestCapabilityEvidence, verifyCapabilityEvidenceAttestation, loadTrustedCapabilityEvidenceIssuers } from "../capability-evidence-attestation.mjs";

const secret = "trusted-runner-secret-0123456789abcdef";
const trustedIssuers = { "automated-test-runner": secret };
const evidence = {
  kind: "automated_test",
  summary: "All automated tests passed",
  passed: true,
  reference: "https://github.com/example/repo/actions/runs/123",
  observedAt: "2026-10-12T00:00:00.000Z",
  scope: "commit abc123",
};

test("trusted issuer can sign and verify evidence", () => {
  const signed = attestCapabilityEvidence(evidence, { issuer: "automated-test-runner", secret });
  assert.equal(verifyCapabilityEvidenceAttestation(signed, trustedIssuers), true);
});
test("tampering with a signed field invalidates the attestation", () => {
  const signed = attestCapabilityEvidence(evidence, { issuer: "automated-test-runner", secret });
  assert.equal(verifyCapabilityEvidenceAttestation({ ...signed, passed: false }, trustedIssuers), false);
  assert.equal(verifyCapabilityEvidenceAttestation({ ...signed, scope: "another commit" }, trustedIssuers), false);
});
test("unknown issuers and missing or short secrets fail closed", () => {
  assert.throws(() => attestCapabilityEvidence(evidence, { issuer: "user", secret }), /issuer não permitido/);
  assert.throws(() => attestCapabilityEvidence(evidence, { issuer: "automated-test-runner", secret: "short" }), /pelo menos 32 bytes/);
  const signed = attestCapabilityEvidence(evidence, { issuer: "automated-test-runner", secret });
  assert.equal(verifyCapabilityEvidenceAttestation(signed, {}), false);
});
test("required signed fields cannot be omitted", () => {
  assert.throws(() => attestCapabilityEvidence({ kind: "automated_test" }, { issuer: "automated-test-runner", secret }), /summary é obrigatório/);
});

test("environment loader accepts only sufficiently long configured issuer secrets", () => {
  const loaded = loadTrustedCapabilityEvidenceIssuers({
    JARVIS_EVIDENCE_KEY_AUTOMATED_TEST: secret,
    JARVIS_EVIDENCE_KEY_CODE_REVIEW: "short",
    JARVIS_EVIDENCE_KEY_SOURCE_REVIEW: "",
  });
  assert.deepEqual(Object.keys(loaded), ["automated-test-runner"]);
  assert.equal(loaded["automated-test-runner"], secret);
});
