import { createUniversalTaskRequest } from "./universal-capability-execution.mjs";

const STATES = new Set(["received","understanding","researching","planning","implementing","testing","awaiting_approval","ready","executing","verifying","completed","blocked","failed"]);
const TERMINAL = new Set(["completed"]);
const TRANSITIONS = {
  received:["understanding","researching","ready","blocked","failed"],
  understanding:["researching","planning","ready","blocked","failed"],
  researching:["planning","implementing","awaiting_approval","blocked","failed"],
  planning:["implementing","awaiting_approval","ready","blocked","failed"],
  implementing:["testing","awaiting_approval","blocked","failed"],
  testing:["implementing","awaiting_approval","ready","blocked","failed"],
  awaiting_approval:["implementing","ready","blocked","failed"],
  ready:["executing","blocked","failed"],
  executing:["verifying","blocked","failed"],
  verifying:["completed","blocked","failed"],
  completed:[], blocked:["researching","planning","implementing"], failed:["researching","planning","implementing"]
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function initializeUniversalTaskStore(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Pool PostgreSQL inválido.");
  await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_universal_tasks (
    id UUID PRIMARY KEY,
    capability_id TEXT REFERENCES jarvis_capabilities(id) ON DELETE SET NULL,
    run_id UUID,
    original_request TEXT NOT NULL,
    goal TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('received','understanding','researching','planning','implementing','testing','awaiting_approval','ready','executing','verifying','completed','blocked','failed')),
    summary TEXT,
    blocker TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_jarvis_universal_tasks_capability_updated ON jarvis_universal_tasks (capability_id, updated_at DESC)");
}

export async function createUniversalTaskRecord(pool, { id, capabilityId = null, originalRequest, goal }) {
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("id inválido.");
  if (capabilityId !== null && (typeof capabilityId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(capabilityId))) throw new TypeError("capabilityId inválido.");
  const task = createUniversalTaskRequest({ id, originalRequest, goal });
  const result = await pool.query(
    "INSERT INTO jarvis_universal_tasks (id, capability_id, original_request, goal, state) VALUES ($1, $2, $3, $4, 'received') RETURNING id, capability_id, run_id, goal, state, summary, blocker, created_at, updated_at",
    [task.id, capabilityId, task.originalRequest, task.goal],
  );
  return result.rows[0];
}

export async function transitionUniversalTaskRecord(pool, { id, state, summary = null, blocker = null, runId = null }) {
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("id inválido.");
  if (!STATES.has(state)) throw new TypeError("state inválido.");
  if (runId !== null && (typeof runId !== "string" || !UUID.test(runId))) throw new TypeError("runId inválido.");
  for (const [field, value] of [["summary", summary], ["blocker", blocker]]) {
    if (value !== null && (typeof value !== "string" || value.length > 1000)) throw new TypeError(field + " inválido.");
    if (typeof value === "string" && /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|credential|authorization|password|senha|secret)\s*[:=]\s*[^\s,;]+|\bBearer\s+[a-z0-9._-]{12,}/i.test(value)) {
      throw new TypeError(field + " parece conter credenciais.");
    }
  }
  const selected = await pool.query("SELECT state FROM jarvis_universal_tasks WHERE id = $1", [id]);
  if (!selected.rowCount) return null;
  const current = selected.rows[0].state;
  if (current !== state && (TERMINAL.has(current) || !TRANSITIONS[current]?.includes(state))) throw new Error("Transição de tarefa não permitida.");
  const result = await pool.query(
    "UPDATE jarvis_universal_tasks SET state = $2, summary = COALESCE($3, summary), blocker = $4, run_id = COALESCE($5, run_id), updated_at = NOW() WHERE id = $1 AND state = $6 RETURNING id, capability_id, run_id, goal, state, summary, blocker, created_at, updated_at",
    [id, state, summary, blocker, runId, current],
  );
  if (!result.rowCount) throw new Error("Estado da tarefa mudou durante a transição; recarregue e tente novamente.");
  return result.rows[0] ?? null;
}

export async function getUniversalTaskRecord(pool, id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("id inválido.");
  const result = await pool.query("SELECT id, capability_id, run_id, goal, state, summary, blocker, created_at, updated_at FROM jarvis_universal_tasks WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}
