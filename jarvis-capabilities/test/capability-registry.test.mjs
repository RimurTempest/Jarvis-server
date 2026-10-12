import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityRequest,
  transitionCapability as rawTransitionCapability,
  capabilityCanBeReused as rawCapabilityCanBeReused,
} from "../capability-registry.mjs";
import { attestCapabilityEvidence } from "../capability-evidence-attestation.mjs";

const observedAt = "2026-10-12T00:00:00.000Z";
const SOURCE_REVISION = "c".repeat(40);
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

function transitionCapability(current, event) {
  const boundEvent = event.state === "testing" && event.sourceRevision === undefined
    ? { ...event, sourceRevision: SOURCE_REVISION }
    : event;
  return rawTransitionCapability(current, boundEvent, { trustedIssuers: TRUSTED_ISSUERS });
}
function capabilityCanBeReused(capability) {
  return rawCapabilityCanBeReused(capability, { trustedIssuers: TRUSTED_ISSUERS });
}
function evidence(kind, overrides = {}) {
  const raw = {
    kind,
    summary: `Verificação de ${kind}`,
    passed: true,
    reference: `https://example.com/evidence/${kind}`,
    observedAt,
    scope: `capability generic-task-01; revision ${SOURCE_REVISION}; revisão e teste do escopo declarado`,
    capabilityId: "generic-task-01",
    sourceRevision: SOURCE_REVISION,
    ...overrides,
  };
  return attestCapabilityEvidence(raw, {
    issuer: ISSUER_BY_KIND[kind],
    secret: TRUSTED_ISSUERS[ISSUER_BY_KIND[kind]],
  });
}
function completeEvidence() {
  return [evidence("source_review"), evidence("code_review"), evidence("automated_test")];
}
function preparedCapability(options = {}) {
  let capability = createCapabilityRequest({
    id: "generic-task-01",
    goal: "Aprender uma tarefa nova sem comando específico embutido",
    ...options,
  });
  capability = transitionCapability(capability, {
    state: "researching",
    research: "Foram levantadas possibilidades; ainda não há execução confirmada.",
  });
  return transitionCapability(capability, {
    state: "prepared",
    requirements: ["Permissão necessária", "Integração de execução disponível"],
    executionPlan: "Plano abstrato a ser implementado e testado pelo executor compatível.",
  });
}

test("new requests start unvalidated and cannot be reused", () => {
  const capability = createCapabilityRequest({ id: "task-1", goal: "Aprender uma tarefa" });
  assert.equal(capability.state, "requested");
  assert.equal(capability.validation, null);
  assert.equal(capabilityCanBeReused(capability), false);
});
test("research and preparation alone never validate a capability", () => {
  assert.equal(capabilityCanBeReused(preparedCapability()), false);
});
test("validation rejects incomplete evidence", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: [] }), /Política de validação não satisfeita/);
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: [evidence("automated_test")] }), /faltam: source_review, code_review/);
});
test("standard capability requires signed source review, code review and automated tests", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const validated = transitionCapability(testing, { state: "validated", evidence: completeEvidence() });
  assert.equal(validated.state, "validated");
  assert.equal(capabilityCanBeReused(validated), true);
  assert.deepEqual(validated.validation.requiredEvidence, ["source_review", "code_review", "automated_test"]);
});
test("higher-risk capability requires signed security review", () => {
  const testing = transitionCapability(preparedCapability({ validationProfile: { riskLevel: "elevated" } }), { state: "testing" });
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: completeEvidence() }), /security_review/);
  const validated = transitionCapability(testing, { state: "validated", evidence: [...completeEvidence(), evidence("security_review")] });
  assert.equal(capabilityCanBeReused(validated), true);
});
test("device-dependent capability requires signed device-test evidence", () => {
  const testing = transitionCapability(preparedCapability({ validationProfile: { requiresDeviceTest: true } }), { state: "testing" });
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: completeEvidence() }), /device_test/);
  const validated = transitionCapability(testing, { state: "validated", evidence: [...completeEvidence(), evidence("device_test")] });
  assert.equal(capabilityCanBeReused(validated), true);
});
test("malformed evidence is rejected", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  assert.throws(() => transitionCapability(testing, {
    state: "validated",
    evidence: [evidence("source_review", { reference: "javascript:alert(1)" }), ...completeEvidence().slice(1)],
  }), /URL HTTPS válida/);
});
test("tampered evidence cannot be reused even when its metadata looks complete", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const items = completeEvidence();
  items[0] = { ...items[0], summary: "Alterado depois de assinar" };
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: items }), /attestation não é válida/);
});
test("invalid lifecycle transitions and identifiers are rejected", () => {
  const requested = createCapabilityRequest({ id: "task-2", goal: "Outra tarefa" });
  assert.throws(() => transitionCapability(requested, { state: "validated", executionPlan: "qualquer", evidence: completeEvidence() }), /Transição não permitida/);
  assert.throws(() => createCapabilityRequest({ id: "../unsafe", goal: "Tarefa" }), /caracteres não permitidos/);
});
test("blocked capability requires a reason and can return to research", () => {
  const requested = createCapabilityRequest({ id: "task-3", goal: "Tarefa limitada" });
  assert.throws(() => transitionCapability(requested, { state: "blocked" }), /reason/);
  const blocked = transitionCapability(requested, { state: "blocked", reason: "Falta uma permissão" });
  assert.equal(blocked.state, "blocked");
  assert.equal(capabilityCanBeReused(blocked), false);
  assert.equal(transitionCapability(blocked, { state: "researching" }).state, "researching");
});


test("validation requires a source revision and rejects evidence bound to another capability", () => {
  const testing = rawTransitionCapability(preparedCapability(), { state: "testing" }, { trustedIssuers: TRUSTED_ISSUERS });
  assert.throws(() => rawTransitionCapability(testing, {
    state: "validated",
    evidence: completeEvidence(),
  }, { trustedIssuers: TRUSTED_ISSUERS }), /sourceRevision/);

  const correctlyBoundTesting = transitionCapability(preparedCapability(), { state: "testing" });
  const wrongCapabilityEvidence = completeEvidence().map((item, index) =>
    index === 0
      ? attestCapabilityEvidence({ ...item, capabilityId: "another-capability" }, {
          issuer: "source-review-runner",
          secret: TRUSTED_ISSUERS["source-review-runner"],
        })
      : item
  );
  assert.throws(() => transitionCapability(correctlyBoundTesting, {
    state: "validated",
    evidence: wrongCapabilityEvidence,
  }), /capabilityId não corresponde/);
});

test("evidence from a different revision cannot authorize reuse", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const mismatched = completeEvidence().map((item, index) => {
    if (index !== 0) return item;
    return attestCapabilityEvidence({ ...item, sourceRevision: "d".repeat(40) }, {
      issuer: "source-review-runner",
      secret: TRUSTED_ISSUERS["source-review-runner"],
    });
  });
  assert.throws(() => transitionCapability(testing, { state: "validated", evidence: mismatched }), /sourceRevision não corresponde/);
});
