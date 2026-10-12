import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityRequest,
  transitionCapability,
  capabilityCanBeReused,
} from "../capability-registry.mjs";

const observedAt = "2026-10-12T00:00:00.000Z";

function evidence(kind, overrides = {}) {
  return {
    kind,
    summary: `Verificação de ${kind}`,
    passed: true,
    reference: `https://example.com/evidence/${kind}`,
    observedAt,
    scope: "capability generic-task-01; revisão e teste do escopo declarado",
    ...overrides,
  };
}

function completeEvidence() {
  return [
    evidence("source_review"),
    evidence("code_review"),
    evidence("automated_test"),
  ];
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
  capability = transitionCapability(capability, {
    state: "prepared",
    requirements: ["Permissão necessária", "Integração de execução disponível"],
    executionPlan: "Plano abstrato a ser implementado e testado pelo executor compatível.",
  });
  return capability;
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

test("validation rejects incomplete evidence, even when arbitrary tests say passed", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  assert.throws(
    () => transitionCapability(testing, { state: "validated", evidence: [] }),
    /Política de validação não satisfeita/
  );
  assert.throws(
    () => transitionCapability(testing, {
      state: "validated",
      evidence: [evidence("automated_test")],
    }),
    /faltam: source_review, code_review/
  );
});

test("standard capability requires source review, code review and automated tests", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const validated = transitionCapability(testing, {
    state: "validated",
    evidence: completeEvidence(),
  });
  assert.equal(validated.state, "validated");
  assert.equal(capabilityCanBeReused(validated), true);
  assert.deepEqual(validated.validation.requiredEvidence, [
    "source_review", "code_review", "automated_test",
  ]);
});

test("higher-risk capability requires security review", () => {
  const testing = transitionCapability(preparedCapability({
    validationProfile: { riskLevel: "elevated" },
  }), { state: "testing" });
  assert.throws(
    () => transitionCapability(testing, { state: "validated", evidence: completeEvidence() }),
    /security_review/
  );
  const validated = transitionCapability(testing, {
    state: "validated",
    evidence: [...completeEvidence(), evidence("security_review")],
  });
  assert.equal(capabilityCanBeReused(validated), true);
});

test("device-dependent capability requires explicit device-test evidence", () => {
  const testing = transitionCapability(preparedCapability({
    validationProfile: { requiresDeviceTest: true },
  }), { state: "testing" });
  assert.throws(
    () => transitionCapability(testing, { state: "validated", evidence: completeEvidence() }),
    /device_test/
  );
  const validated = transitionCapability(testing, {
    state: "validated",
    evidence: [...completeEvidence(), evidence("device_test")],
  });
  assert.equal(capabilityCanBeReused(validated), true);
});

test("evidence without a valid HTTPS reference, timestamp or scope is rejected", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const malformed = completeEvidence();
  malformed[0] = evidence("source_review", {
    reference: "javascript:alert(1)",
    observedAt: "yesterday",
    scope: "declared test scope",
  });
  assert.throws(
    () => transitionCapability(testing, { state: "validated", evidence: malformed }),
    /reference deve ser uma URL HTTPS válida/
  );
});

test("invalid lifecycle transitions are rejected", () => {
  const requested = createCapabilityRequest({ id: "task-2", goal: "Outra tarefa" });
  assert.throws(
    () => transitionCapability(requested, {
      state: "validated",
      executionPlan: "qualquer",
      evidence: completeEvidence(),
    }),
    /Transição não permitida/
  );
});

test("invalid identifiers and malformed evidence are rejected", () => {
  assert.throws(
    () => createCapabilityRequest({ id: "../unsafe", goal: "Tarefa" }),
    /caracteres não permitidos/
  );
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  assert.throws(
    () => transitionCapability(testing, {
      state: "validated",
      evidence: [evidence("source_review", { passed: "yes" })],
    }),
    /passed deve ser booleano/
  );
});

test("blocked capability requires a reason and can return to research", () => {
  const requested = createCapabilityRequest({ id: "task-3", goal: "Tarefa limitada" });
  assert.throws(
    () => transitionCapability(requested, { state: "blocked" }),
    /reason/
  );
  const blocked = transitionCapability(requested, { state: "blocked", reason: "Falta uma permissão" });
  assert.equal(blocked.state, "blocked");
  assert.equal(capabilityCanBeReused(blocked), false);
  assert.equal(transitionCapability(blocked, { state: "researching" }).state, "researching");
});
