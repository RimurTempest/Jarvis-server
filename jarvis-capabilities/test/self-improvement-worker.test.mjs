import test from "node:test";
import assert from "node:assert/strict";
import { runSelfImprovementWorkerOnce } from "../self-improvement-worker.mjs";

function fakePool({ run = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE jarvis_self_improvement_runs") && sql.includes("claimed_at <")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH next_run AS")) return { rowCount: run ? 1 : 0, rows: run ? [run] : [] };
      throw new Error("Unexpected query");
    },
  };
}

test("claims one queued job and delegates it to the processor", async () => {
  const run = { id: "11111111-1111-4111-8111-111111111111", capability_id: "capability-1", state: "researching" };
  const pool = fakePool({ run });
  const processed = [];
  const result = await runSelfImprovementWorkerOnce({ pool, processRun: async (claimed) => processed.push(claimed) });
  assert.equal(result.claimed, true);
  assert.equal(result.succeeded, true);
  assert.deepEqual(processed, [run]);
  assert.equal(pool.calls.length, 2);
});

test("handles an empty queue without invoking the processor", async () => {
  const pool = fakePool();
  let processed = false;
  const result = await runSelfImprovementWorkerOnce({ pool, processRun: async () => { processed = true; } });
  assert.equal(result.claimed, false);
  assert.equal(processed, false);
});

test("routes processing failures to the failure handler without throwing", async () => {
  const run = { id: "11111111-1111-4111-8111-111111111111", state: "researching" };
  const pool = fakePool({ run });
  let failedRun = null;
  const result = await runSelfImprovementWorkerOnce({
    pool,
    processRun: async () => { throw new Error("private provider detail"); },
    onFailure: async (claimed, error) => { failedRun = { claimed, message: error.message }; },
  });
  assert.equal(result.succeeded, false);
  assert.equal(failedRun.claimed, run);
  assert.equal(failedRun.message, "private provider detail");
});

test("validates worker dependencies", async () => {
  await assert.rejects(runSelfImprovementWorkerOnce({ pool: null, processRun: async () => {} }), /Pool PostgreSQL/i);
  await assert.rejects(runSelfImprovementWorkerOnce({ pool: { query: async () => ({ rows: [] }) } }), /processRun/i);
});
