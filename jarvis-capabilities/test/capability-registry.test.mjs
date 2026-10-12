import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityRequest,
  transitionCapability,
  capabilityCanBeReused,
} from "../capability-registry.mjs";

function preparedCapability() {
  let capability = createCapabilityRequest({
    id: "generic-task-01",
    goal: "Aprender uma tarefa nova sem comando específico embutido",
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

test("validation requires a plan and passing test evidence", () => {
  const prepared = preparedCapability();
  const testing = transitionCapability(prepared, { state: "testing" });
  assert.throws(
    () => transitionCapability(testing, { state: "validated", evidence: [] }),
    /evidências de teste/
  );
  assert.throws(
    () => transitionCapability(testing, {
      state: "validated",
      evidence: [{ kind: "smoke-test", summary: "Falhou", passed: false }],
    }),
    /aprovadas/
  );
});

test("capability is reusable only after explicit passing evidence", () => {
  const testing = transitionCapability(preparedCapability(), { state: "testing" });
  const validated = transitionCapability(testing, {
    state: "validated",
    evidence: [
      { kind: "unit-test", summary: "Validação do plano concluída", passed: true },
      { kind: "integration-test", summary: "Executor respondeu corretamente", passed: true },
    ],
  });
  assert.equal(validated.state, "validated");
  assert.equal(capabilityCanBeReused(validated), true);
});

test("invalid lifecycle transitions are rejected", () => {
  const requested = createCapabilityRequest({ id: "task-2", goal: "Outra tarefa" });
  assert.throws(
    () => transitionCapability(requested, { state: "validated", executionPlan: "qualquer", evidence: [{kind:"test",summary:"ok",passed:true}] }),
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
      evidence: [{ kind: "test", summary: "Sem resultado booleano" }],
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
