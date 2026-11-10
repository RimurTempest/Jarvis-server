import test from "node:test";
import assert from "node:assert/strict";
import { createUniversalTaskRecord, getUniversalTaskRecord, initializeUniversalTaskStore, transitionUniversalTaskRecord } from "../universal-task-store.mjs";
import { runPersistedUniversalTask } from "../universal-task-orchestrator.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const evidence = "https://example.com/verification";

function fakePool() {
  const records = new Map();
  return {
    records,
    async query(sql, params = []) {
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX") || sql.startsWith("ALTER TABLE")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO jarvis_universal_tasks")) {
        const row = {
          id: params[0], capability_id: params[1], run_id: null,
          original_request: params[2], goal: params[3], state: "received",
          summary: null, blocker: null, plan: null, execution: null, verification: null,
          created_at: new Date(), updated_at: new Date(),
        };
        records.set(row.id, row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (sql.startsWith("SELECT state FROM jarvis_universal_tasks")) {
        const row = records.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ state: row.state }] : [] };
      }
      if (sql.startsWith("SELECT id, capability_id, run_id, goal, state")) {
        const row = records.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
      }
      if (sql.startsWith("UPDATE jarvis_universal_tasks") && sql.includes("SET plan = COALESCE")) {
        const row = records.get(params[0]);
        if (!row || row.state !== params[4]) return { rowCount: 0, rows: [] };
        if (params[1] !== null) row.plan = JSON.parse(params[1]);
        if (params[2] !== null) row.execution = JSON.parse(params[2]);
        if (params[3] !== null) row.verification = JSON.parse(params[3]);
        row.updated_at = new Date();
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (sql.startsWith("UPDATE jarvis_universal_tasks")) {
        const row = records.get(params[0]);
        if (!row || row.state !== params[5]) return { rowCount: 0, rows: [] };
        row.state = params[1];
        row.summary = params[2] ?? row.summary;
        row.blocker = params[3];
        row.run_id = params[4] ?? row.run_id;
        row.updated_at = new Date();
        return { rowCount: 1, rows: [{ ...row }] };
      }
      throw new Error("SQL inesperado no teste: " + sql);
    },
  };
}

async function makeTask(pool) {
  await initializeUniversalTaskStore(pool);
  await createUniversalTaskRecord(pool, { id, originalRequest: "Execute a tarefa autorizada", goal: "Executar uma tarefa autorizada" });
  await transitionUniversalTaskRecord(pool, { id, state: "researching", summary: "Pesquisa concluída." });
  await transitionUniversalTaskRecord(pool, { id, state: "planning", summary: "Plano em preparação." });
  return getUniversalTaskRecord(pool, id);
}

function makePlan(overrides = {}) {
  return {
    goal: "Executar uma etapa controlada",
    target: "server",
    riskLevel: "low",
    requiresConfirmation: false,
    irreversible: false,
    requiredPermissions: [],
    steps: [{ kind: "server.echo", description: "Executar a etapa controlada", reversible: true }],
    acceptanceCriteria: ["A etapa retorna evidência verificável."],
    rollbackPlan: "Nenhuma alteração persistente foi realizada.",
    ...overrides,
  };
}

function makeRegistry() {
  return new Map([["server.echo", {
    target: "server",
    execute: async () => ({ status: "succeeded", summary: "Etapa executada.", evidence }),
    verify: async () => ({ status: "succeeded", summary: "Resultado confirmado.", evidence }),
  }]]);
}

test("blocks a plan without a registered executor and persists the reason", async () => {
  const pool = fakePool();
  const task = await makeTask(pool);
  const result = await runPersistedUniversalTask({ pool, task, plan: makePlan(), adapterRegistry: new Map() });
  const saved = await getUniversalTaskRecord(pool, id);
  assert.equal(result.status, "needs_user_action");
  assert.equal(saved.state, "blocked");
  assert.equal(saved.plan.steps[0].kind, "server.echo");
  assert.equal(saved.execution.reason, "executor_unavailable");
});

test("waits for explicit approval before invoking an executor", async () => {
  const pool = fakePool();
  const task = await makeTask(pool);
  let invoked = false;
  const result = await runPersistedUniversalTask({
    pool, task, plan: makePlan({ requiresConfirmation: true }), adapterRegistry: makeRegistry(),
    execute: async () => { invoked = true; return { status: "succeeded" }; },
  });
  const saved = await getUniversalTaskRecord(pool, id);
  assert.equal(result.status, "needs_user_action");
  assert.equal(saved.state, "awaiting_approval");
  assert.equal(saved.execution, null);
  assert.equal(invoked, false);
});

test("persists execution and verification evidence before marking a task completed", async () => {
  const pool = fakePool();
  const task = await makeTask(pool);
  const result = await runPersistedUniversalTask({
    pool, task, plan: makePlan(), adapterRegistry: makeRegistry(),
  });
  const saved = await getUniversalTaskRecord(pool, id);
  assert.equal(result.status, "succeeded");
  assert.equal(saved.state, "completed");
  assert.equal(saved.execution.status, "succeeded");
  assert.equal(saved.execution.completedSteps[0].verification.status, "succeeded");
  assert.equal(saved.verification.status, "succeeded");
  assert.equal(saved.verification.steps[0].evidence, evidence);
});

test("never marks a task completed when verification is unconfirmed", async () => {
  const pool = fakePool();
  const task = await makeTask(pool);
  const result = await runPersistedUniversalTask({
    pool, task, plan: makePlan(), adapterRegistry: makeRegistry(),
    execute: async () => ({
      status: "unverified",
      reason: "verification_not_succeeded",
      completedSteps: [{ step: "server.echo", status: "succeeded" }],
    }),
  });
  const saved = await getUniversalTaskRecord(pool, id);
  assert.equal(result.status, "unverified");
  assert.equal(saved.state, "blocked");
  assert.equal(saved.verification.status, "unverified");
});
