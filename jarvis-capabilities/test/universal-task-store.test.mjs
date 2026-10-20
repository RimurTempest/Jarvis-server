import test from "node:test";
import assert from "node:assert/strict";
import {
  createUniversalTaskRecord,
  getUniversalTaskRecord,
  initializeUniversalTaskStore,
  transitionUniversalTaskRecord,
} from "../universal-task-store.mjs";

const id = "11111111-1111-4111-8111-111111111111";

function fakePool() {
  const records = new Map();
  return {
    records,
    async query(sql, params = []) {
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO jarvis_universal_tasks")) {
        const row = { id: params[0], capability_id: params[1], run_id: null, original_request: params[2], goal: params[3], state: "received", summary: null, blocker: null, created_at: new Date(), updated_at: new Date() };
        records.set(row.id, row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (sql.startsWith("SELECT state FROM jarvis_universal_tasks")) {
        const row = records.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ state: row.state }] : [] };
      }
      if (sql.startsWith("SELECT id, capability_id, run_id, goal, state")) {
        const row = records.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ ...row, original_request: undefined }] : [] };
      }
      if (sql.startsWith("UPDATE jarvis_universal_tasks")) {
        const row = records.get(params[0]);
        if (!row) return { rowCount: 0, rows: [] };
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

test("initializes persistent task storage and indexes", async () => {
  const calls = [];
  await initializeUniversalTaskStore({ query: async (sql) => { calls.push(sql); return { rows: [] }; } });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /jarvis_universal_tasks/);
  assert.match(calls[1], /idx_jarvis_universal_tasks/);
});

test("records a natural-language request without claiming it ran", async () => {
  const pool = fakePool();
  const created = await createUniversalTaskRecord(pool, { id, capabilityId: "capability-1", originalRequest: "Prepare um relatório", goal: "Preparar o relatório solicitado" });
  assert.equal(created.state, "received");
  assert.equal(created.run_id, null);
  assert.equal(created.summary, null);
});

test("moves a queued task to researching and attaches the run identifier", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Pesquise como integrar o serviço", goal: "Integrar o serviço" });
  const updated = await transitionUniversalTaskRecord(pool, { id, state: "researching", summary: "Solicitação enfileirada; ainda não executada.", runId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(updated.state, "researching");
  assert.equal(updated.run_id, "22222222-2222-4222-8222-222222222222");
});

test("blocks invalid transitions and secret-bearing requests", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Fazer uma tarefa", goal: "Fazer uma tarefa" });
  await transitionUniversalTaskRecord(pool, { id, state: "blocked", blocker: "Nenhum executor disponível." });
  await assert.rejects(() => transitionUniversalTaskRecord(pool, { id, state: "completed" }), /Transição/);
  await assert.rejects(() => createUniversalTaskRecord(pool, { id: "33333333-3333-4333-8333-333333333333", originalRequest: "token=abc123", goal: "Fazer uma tarefa" }), /credenciais/);
});

test("returns null for missing task records", async () => {
  const pool = fakePool();
  assert.equal(await getUniversalTaskRecord(pool, id), null);
  assert.equal(await transitionUniversalTaskRecord(pool, { id, state: "researching" }), null);
});
