import test from "node:test";
import assert from "node:assert/strict";
import {
  createUniversalTaskRecord,
  getUniversalTaskRecord,
  initializeUniversalTaskStore,
  persistUniversalTaskArtifacts,
  transitionUniversalTaskRecord,
} from "../universal-task-store.mjs";

const id = "11111111-1111-4111-8111-111111111111";

function fakePool() {
  const records = new Map();
  return {
    records,
    async query(sql, params = []) {
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX") || sql.startsWith("ALTER TABLE")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO jarvis_universal_tasks")) {
        const row = { id: params[0], capability_id: params[1], run_id: null, original_request: params[2], goal: params[3], state: "received", summary: null, blocker: null, plan: null, execution: null, verification: null, created_at: new Date(), updated_at: new Date() };
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

test("initializes persistent task storage and indexes", async () => {
  const calls = [];
  await initializeUniversalTaskStore({ query: async (sql) => { calls.push(sql); return { rows: [] }; } });
  assert.equal(calls.length, 5);
  assert.match(calls[0], /jarvis_universal_tasks/);
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS plan JSONB/.test(sql)));
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS execution JSONB/.test(sql)));
  assert.ok(calls.some((sql) => /ADD COLUMN IF NOT EXISTS verification JSONB/.test(sql)));
  assert.ok(calls.some((sql) => /idx_jarvis_universal_tasks/.test(sql)));
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
  const resumed = await transitionUniversalTaskRecord(pool, { id, state: "researching", summary: "Retomada após resolver o bloqueio." });
  assert.equal(resumed.state, "researching");
  await assert.rejects(() => transitionUniversalTaskRecord(pool, { id, state: "blocked", blocker: "token=abc123" }), /credenciais/);
  await assert.rejects(() => createUniversalTaskRecord(pool, { id: "33333333-3333-4333-8333-333333333333", originalRequest: "token=abc123", goal: "Fazer uma tarefa" }), /credenciais/);
});

test("returns null for missing task records", async () => {
  const pool = fakePool();
  assert.equal(await getUniversalTaskRecord(pool, id), null);
  assert.equal(await transitionUniversalTaskRecord(pool, { id, state: "researching" }), null);
});


test("supports real worker progress, CI repair, and approval transitions without claiming task execution", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Crie uma integração", goal: "Pesquisar e preparar a integração" });
  await transitionUniversalTaskRecord(pool, { id, state: "researching", summary: "Pesquisa iniciada." });
  await transitionUniversalTaskRecord(pool, { id, state: "planning", summary: "Planejamento iniciado." });
  await transitionUniversalTaskRecord(pool, { id, state: "implementing", summary: "Implementação isolada iniciada." });
  await transitionUniversalTaskRecord(pool, { id, state: "testing", summary: "Validando a proposta." });
  const repair = await transitionUniversalTaskRecord(pool, { id, state: "implementing", summary: "Corrigindo a proposta após falha de CI." });
  assert.equal(repair.state, "implementing");
  const testing = await transitionUniversalTaskRecord(pool, { id, state: "testing", summary: "Revalidando a proposta." });
  assert.equal(testing.state, "testing");
  const awaiting = await transitionUniversalTaskRecord(pool, { id, state: "awaiting_approval", summary: "A proposta aguarda revisão; a ação original ainda não foi executada." });
  assert.equal(awaiting.state, "awaiting_approval");
  assert.match(awaiting.summary, /ação original ainda não foi executada/);
});


test("uses compare-and-swap so a stale concurrent transition cannot overwrite newer state", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Faça uma tarefa", goal: "Concluir a tarefa" });
  await transitionUniversalTaskRecord(pool, { id, state: "researching", summary: "Pesquisa iniciada." });
  const originalQuery = pool.query.bind(pool);
  let injectConcurrentChange = true;
  pool.query = async (sql, params = []) => {
    if (sql.startsWith("UPDATE jarvis_universal_tasks") && injectConcurrentChange) {
      injectConcurrentChange = false;
      pool.records.get(id).state = "planning";
    }
    return originalQuery(sql, params);
  };
  await assert.rejects(
    () => transitionUniversalTaskRecord(pool, { id, state: "implementing", summary: "Tentativa atrasada." }),
    /Estado da tarefa mudou durante a transição/,
  );
  assert.equal(pool.records.get(id).state, "planning");
});

test("persists a structured plan and execution evidence only while the expected state is current", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Abra uma tela permitida", goal: "Abrir configurações de Bluetooth" });
  await transitionUniversalTaskRecord(pool, { id, state: "planning", summary: "Plano em preparação." });
  const plan = { target: "android", riskLevel: "low", steps: [{ kind: "android.open_settings", parameters: { setting: "bluetooth" } }] };
  const execution = { status: "succeeded", summary: "O dispositivo confirmou a ação." };
  const saved = await persistUniversalTaskArtifacts(pool, { id, expectedState: "planning", plan, execution });
  assert.deepEqual(saved.plan, plan);
  assert.deepEqual(saved.execution, execution);
  assert.equal(saved.verification, null);
  const loaded = await getUniversalTaskRecord(pool, id);
  assert.deepEqual(loaded.plan, plan);
  assert.deepEqual(loaded.execution, execution);
  await transitionUniversalTaskRecord(pool, { id, state: "awaiting_approval", summary: "Aguardando aprovação." });
  await assert.rejects(
    () => persistUniversalTaskArtifacts(pool, { id, expectedState: "planning", verification: { status: "succeeded" } }),
    /Estado da tarefa mudou/,
  );
});

test("rejects empty and credential-bearing task artifacts", async () => {
  const pool = fakePool();
  await createUniversalTaskRecord(pool, { id, originalRequest: "Prepare uma tarefa", goal: "Preparar tarefa" });
  await assert.rejects(() => persistUniversalTaskArtifacts(pool, { id, expectedState: "received" }), /ao menos um artefato/);
  await assert.rejects(
    () => persistUniversalTaskArtifacts(pool, { id, expectedState: "received", execution: { status: "succeeded", access_token: "secret-value" } }),
    /credenciais/,
  );
});
