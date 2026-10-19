import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  initializeSelfImprovementRunQueue,
  enqueueSelfImprovementRun,
  claimNextSelfImprovementRun,
  recoverStaleSelfImprovementRuns,
  updateSelfImprovementRun,
  listSelfImprovementRuns,
} from "../self-improvement-run-queue.mjs";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;

test("self-improvement queue persists jobs, enforces one active job, and claims each job once", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const capabilityId = "test-capability-self-improvement";
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_capabilities (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL DEFAULT 'integration test capability',
      state TEXT NOT NULL DEFAULT 'researching' CHECK (state IN ('requested', 'researching', 'prepared', 'testing', 'validated', 'blocked')),
      record JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(
      "INSERT INTO jarvis_capabilities (id, goal, state, record) VALUES ($1, $2, 'researching', '{}'::jsonb) ON CONFLICT (id) DO NOTHING",
      [capabilityId, "integration test capability"],
    );
    await initializeSelfImprovementRunQueue(pool);
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]);

    const first = await enqueueSelfImprovementRun(pool, {
      id: firstId, capabilityId, repository: "example/repo", baseBranch: "main", target: "android",
    });
    assert.equal(first.state, "queued");
    assert.equal(first.target, "android");
    await assert.rejects(
      enqueueSelfImprovementRun(pool, { id: secondId, capabilityId, repository: "example/repo", baseBranch: "main" }),
      (error) => error.code === "SELF_IMPROVEMENT_ALREADY_ACTIVE",
    );

    const claimed = await claimNextSelfImprovementRun(pool);
    assert.equal(claimed.id, firstId);
    assert.equal(claimed.state, "researching");
    assert.equal(await claimNextSelfImprovementRun(pool), null);

    await updateSelfImprovementRun(pool, firstId, "collecting_context");
    await updateSelfImprovementRun(pool, firstId, "generating");
    await updateSelfImprovementRun(pool, firstId, "publishing");
    const completed = await updateSelfImprovementRun(pool, firstId, "draft_pr_created", {
      baseRevision: "a".repeat(40),
      headRevision: "c".repeat(40),
      proposalDigest: "b".repeat(64),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/repo/pull/42",
      proposalSummary: "Example capability proposal",
    });
    assert.equal(completed.state, "draft_pr_created");
    assert.equal(completed.pull_request_number, 42);
    assert.equal((await listSelfImprovementRuns(pool, capabilityId)).length, 1);
  } finally {
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]).catch(() => {});
    await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
    await pool.end();
  }
});

test("stale merged jobs become unverified instead of being merged a second time", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const capabilityId = "test-capability-stale-merge";
  const runId = "33333333-3333-4333-8333-333333333333";
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS jarvis_capabilities (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL DEFAULT 'integration test capability',
      state TEXT NOT NULL DEFAULT 'researching' CHECK (state IN ('requested', 'researching', 'prepared', 'testing', 'validated', 'blocked')),
      record JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(
      "INSERT INTO jarvis_capabilities (id, goal, state, record) VALUES ($1, $2, 'researching', '{}'::jsonb) ON CONFLICT (id) DO NOTHING",
      [capabilityId, "stale merge test"],
    );
    await initializeSelfImprovementRunQueue(pool);
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]);
    await enqueueSelfImprovementRun(pool, {
      id: runId, capabilityId, repository: "example/repo", baseBranch: "main", target: "server",
    });
    await claimNextSelfImprovementRun(pool);
    await updateSelfImprovementRun(pool, runId, "collecting_context");
    await updateSelfImprovementRun(pool, runId, "generating");
    await updateSelfImprovementRun(pool, runId, "publishing");
    await updateSelfImprovementRun(pool, runId, "merged", {
      baseRevision: "a".repeat(40),
      headRevision: "c".repeat(40),
      proposalDigest: "b".repeat(64),
      pullRequestNumber: 43,
      pullRequestUrl: "https://github.com/example/repo/pull/43",
      proposalSummary: "Stale merge test",
    });
    await pool.query("UPDATE jarvis_self_improvement_runs SET updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [runId]);
    assert.equal(await recoverStaleSelfImprovementRuns(pool, 10), 1);
    const state = await pool.query("SELECT state, error_code FROM jarvis_self_improvement_runs WHERE id = $1", [runId]);
    assert.equal(state.rows[0].state, "merge_unverified");
    assert.equal(state.rows[0].error_code, "runtime_verification_interrupted");
  } finally {
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]).catch(() => {});
    await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
    await pool.end();
  }
});

test("queue validation rejects malformed identifiers and unsafe branches", async () => {
  const fakePool = { async query() { throw new Error("Should not query"); } };
  await assert.rejects(initializeSelfImprovementRunQueue({}), /Pool PostgreSQL/i);
  await assert.rejects(enqueueSelfImprovementRun(fakePool, {
    id: "not-a-uuid", capabilityId: "capability-1", repository: "example/repo", baseBranch: "main",
  }), /UUID/i);
  await assert.rejects(enqueueSelfImprovementRun(fakePool, {
    id: "11111111-1111-4111-8111-111111111111", capabilityId: "capability-1", repository: "example/repo", baseBranch: "../main",
  }), /baseBranch/i);
  await assert.rejects(enqueueSelfImprovementRun(fakePool, {
    id: "11111111-1111-4111-8111-111111111111", capabilityId: "capability-1", repository: "example/repo", baseBranch: "main", target: "unknown",
  }), /target inválido/i);
});

test("recovery window rejects invalid durations", async () => {
  await assert.rejects(recoverStaleSelfImprovementRuns({ query: async () => ({ rowCount: 0 }) }, 0), /staleAfterMinutes/i);
});

test("final state requires exact PR metadata and errors require safe codes", async () => {
  const fakePool = {
    calls: 0,
    async query(sql, params) {
      if (sql.startsWith("SELECT state")) return { rowCount: 1, rows: [{ state: "publishing" }] };
      this.calls++;
      return { rowCount: 1, rows: [{ state: params[1] }] };
    },
  };
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "draft_pr_created", {}), /exige PR/i);
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "failed", {}), /código de erro/i);
  const merged = await updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "merged", {
    baseRevision: "a".repeat(40),
    headRevision: "c".repeat(40),
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/repo/pull/42",
    proposalSummary: "Example capability proposal",
  });
  assert.equal(merged.state, "merged");
});
