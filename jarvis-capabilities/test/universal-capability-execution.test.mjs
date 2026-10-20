import test from "node:test";
import assert from "node:assert/strict";
import { canExecuteUniversalTask, createUniversalTaskPlan, createUniversalTaskRequest, executeUniversalTask } from "../universal-capability-execution.mjs";

function task() { return createUniversalTaskRequest({ id: "task-123", originalRequest: "Envie o relatório", goal: "Enviar o relatório por um canal autorizado" }); }
function plan(overrides = {}) {
  return createUniversalTaskPlan({ goal: "Enviar o relatório", target: "external_service", riskLevel: "moderate", requiredPermissions: ["email.send"], steps: [{ kind: "email.send", description: "Enviar o e-mail", reversible: false }], acceptanceCriteria: ["O provedor confirma o envio"], rollbackPlan: "Não repetir automaticamente se o resultado ficar ambíguo", ...overrides });
}

test("records natural-language request without claiming it has been learned or executed", () => {
  const created = task();
  assert.equal(created.state, "received");
  assert.equal(created.execution, null);
  assert.equal(created.verification, null);
});

test("requires explicit confirmation and permission for actions that need them", () => {
  const registry = new Map([["email.send", { target: "external_service", execute: async () => ({}), verify: async () => ({}) }]]);
  assert.equal(canExecuteUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry }).reason, "explicit_confirmation_required");
  assert.equal(canExecuteUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry, authorization: { confirmed: true } }).reason, "required_permission_missing");
  assert.equal(canExecuteUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry, authorization: { confirmed: true, grantedPermissions: ["email.send"] } }).allowed, true);
});

test("refuses to execute when no trusted adapter exists", async () => {
  const result = await executeUniversalTask({ task: task(), plan: plan(), adapterRegistry: new Map(), authorization: { confirmed: true, grantedPermissions: ["email.send"] } });
  assert.equal(result.status, "needs_user_action");
  assert.equal(result.reason, "executor_unavailable");
});

test("does not claim success without HTTPS evidence and independent verification", async () => {
  const registry = new Map([["email.send", { target: "external_service", execute: async () => ({ status: "succeeded", summary: "Enviado" }), verify: async () => ({ status: "succeeded", summary: "Verificado", evidence: "https://provider.example/message/1" }) }]]);
  const result = await executeUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry, authorization: { confirmed: true, grantedPermissions: ["email.send"] } });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "executor_error");
});

test("rejects malformed, non-HTTPS, and credential-bearing evidence URLs", async () => {
  for (const evidence of ["https://", "http://provider.example/message/1", "https://user:password@provider.example/message/1", "not-a-url"]) {
    const registry = new Map([["email.send", {
    target: "external_service",
      execute: async () => ({ status: "succeeded", summary: "Concluído", evidence }),
      verify: async () => ({ status: "succeeded", summary: "Verificado", evidence: "https://provider.example/message/1" }),
    }]]);
    const result = await executeUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry, authorization: { confirmed: true, grantedPermissions: ["email.send"] } });
    assert.equal(result.status, "failed", evidence);
    assert.equal(result.reason, "executor_error", evidence);
  }
});

test("refuses an adapter registered for a different target", () => {
  const registry = new Map([["email.send", {
    target: "server",
    execute: async () => ({ status: "succeeded", summary: "Concluído", evidence: "https://provider.example/message/1" }),
    verify: async () => ({ status: "succeeded", summary: "Verificado", evidence: "https://provider.example/message/1" }),
  }]]);
  assert.equal(canExecuteUniversalTask({
    task: task(),
    plan: plan(),
    adapterRegistry: registry,
    authorization: { confirmed: true, grantedPermissions: ["email.send"] },
  }).reason, "executor_target_mismatch");
});

test("refuses to execute a plan whose target remains unknown", async () => {
  const unresolved = plan({ target: "unknown", requiredPermissions: [], requiresConfirmation: false });
  const registry = new Map([["email.send", {
    target: "external_service",
    execute: async () => ({ status: "succeeded", summary: "Concluído", evidence: "https://provider.example/message/1" }),
    verify: async () => ({ status: "succeeded", summary: "Verificado", evidence: "https://provider.example/message/1" }),
  }]]);
  const result = await executeUniversalTask({ task: task(), plan: unresolved, adapterRegistry: registry, authorization: { confirmed: true } });
  assert.equal(result.status, "needs_user_action");
  assert.equal(result.reason, "target_not_resolved");
});

test("executes only allowlisted adapter and independently verifies its result", async () => {
  const registry = new Map([["email.send", {
    target: "external_service",
    execute: async () => ({ status: "succeeded", summary: "Provedor aceitou o envio", evidence: "https://provider.example/message/1" }),
    verify: async () => ({ status: "succeeded", summary: "Mensagem localizada no provedor", evidence: "https://provider.example/message/1" }),
  }]]);
  const result = await executeUniversalTask({ task: task(), plan: plan(), adapterRegistry: registry, authorization: { confirmed: true, grantedPermissions: ["email.send"] } });
  assert.equal(result.status, "succeeded");
  assert.equal(result.completedSteps[0].verification.status, "succeeded");
});

test("high-risk tasks require a security review", () => {
  const highRisk = plan({ riskLevel: "high", requiredPermissions: [], requiresConfirmation: false });
  const registry = new Map([["email.send", { target: "external_service", execute: async () => ({}), verify: async () => ({}) }]]);
  assert.equal(canExecuteUniversalTask({ task: task(), plan: highRisk, adapterRegistry: registry, authorization: { confirmed: true } }).reason, "security_review_required");
});

test("rejects invalid task plans and secret-bearing goals", () => {
  assert.throws(() => createUniversalTaskRequest({ id: "task-1", originalRequest: "password=abcd1234567890", goal: "do thing" }), /credenciais/);
  assert.throws(() => createUniversalTaskRequest({ id: "task-2", originalRequest: "token=abc123", goal: "do thing" }), /credenciais/);
  assert.throws(() => createUniversalTaskRequest({ id: "task-3", originalRequest: "Bearer abcdefghijklmnop", goal: "do thing" }), /credenciais/);
  assert.throws(() => createUniversalTaskPlan({ goal: "x", target: "unsupported_target", riskLevel: "low", requiredPermissions: [], steps: [], acceptanceCriteria: [], rollbackPlan: "none" }));
});
