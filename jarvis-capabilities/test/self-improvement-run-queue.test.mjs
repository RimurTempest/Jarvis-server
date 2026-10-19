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
      mergeCommitSha: "d".repeat(40),
    });
    await pool.query("UPDATE jarvis_self_improvement_runs SET updated_at = NOW() - INTERVAL '21 minutes' WHERE id = $1", [runId]);
    assert.equal(await recoverStaleSelfImprovementRuns(pool, 10), 1);
    const state = await pool.query("SELECT state, error_code, merge_commit_sha FROM jarvis_self_improvement_runs WHERE id = $1", [runId]);
    assert.equal(state.rows[0].state, "merge_unverified");
    assert.equal(state.rows[0].error_code, "runtime_verification_interrupted");
    assert.equal(state.rows[0].merge_commit_sha, "d".repeat(40));
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
    currentState: "publishing",
    lastParams: null,
    async query(sql, params) {
      if (sql.startsWith("SELECT state")) return { rowCount: 1, rows: [{ state: this.currentState }] };
      this.calls++;
      this.lastParams = params;
      this.currentState = params[1];
      return { rowCount: 1, rows: [{ state: params[1] }] };
    },
  };
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "draft_pr_created", {}), /exige PR/i);
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "failed", {}), /código de erro/i);
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "merged", {
    baseRevision: "a".repeat(40),
    headRevision: "c".repeat(40),
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/repo/pull/42",
    proposalSummary: "Example capability proposal",
    mergeCommitSha: "not-a-sha",
  }), /mergeCommitSha/i);
  await assert.rejects(updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "merged", {
    baseRevision: "a".repeat(40),
    headRevision: "c".repeat(40),
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/repo/pull/42",
    proposalSummary: "Example capability proposal",
    rollbackRevision: "not-a-sha",
  }), /rollbackRevision/i);
  const metadata = {
    baseRevision: "a".repeat(40),
    headRevision: "c".repeat(40),
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/repo/pull/42",
    proposalSummary: "Example capability proposal",
    mergeCommitSha: "d".repeat(40),
  };
  const merged = await updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "merged", metadata);
  assert.equal(merged.state, "merged");
  const verified = await updateSelfImprovementRun(fakePool, "11111111-1111-4111-8111-111111111111", "runtime_verified", {
    ...metadata,
    runtimeRevision: "d".repeat(40),
  });
  assert.equal(verified.state, "runtime_verified");
  assert.equal(fakePool.lastParams[4], "d".repeat(40));
  assert.equal(fakePool.lastParams[5], "d".repeat(40));
});


test("persists verified runtime and rollback revisions for exact Android status matching", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const capabilityId = "test-capability-runtime-revisions";
  const verifiedRunId = "44444444-4444-4444-8444-444444444444";
  const rolledBackRunId = "55555555-5555-4555-8555-555555555555";
  const baseMetadata = {
    baseRevision: "a".repeat(40),
    headRevision: "c".repeat(40),
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 44,
    pullRequestUrl: "https://github.com/example/repo/pull/44",
    proposalSummary: "Runtime revision metadata integration test",
  };
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
      [capabilityId, "runtime revision integration test"],
    );
    await initializeSelfImprovementRunQueue(pool);
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]);

    await enqueueSelfImprovementRun(pool, {
      id: verifiedRunId, capabilityId, repository: "example/repo", baseBranch: "main", target: "server",
    });
    await claimNextSelfImprovementRun(pool);
    await updateSelfImprovementRun(pool, verifiedRunId, "collecting_context");
    await updateSelfImprovementRun(pool, verifiedRunId, "generating");
    await updateSelfImprovementRun(pool, verifiedRunId, "publishing");
    await updateSelfImprovementRun(pool, verifiedRunId, "merged", {
      ...baseMetadata,
      mergeCommitSha: "d".repeat(40),
    });
    await updateSelfImprovementRun(pool, verifiedRunId, "runtime_verified", {
      ...baseMetadata,
      mergeCommitSha: "d".repeat(40),
      runtimeRevision: "d".repeat(40),
    });

    await enqueueSelfImprovementRun(pool, {
      id: rolledBackRunId, capabilityId, repository: "example/repo", baseBranch: "main", target: "server",
    });
    await claimNextSelfImprovementRun(pool);
    await updateSelfImprovementRun(pool, rolledBackRunId, "collecting_context");
    await updateSelfImprovementRun(pool, rolledBackRunId, "generating");
    await updateSelfImprovementRun(pool, rolledBackRunId, "publishing");
    await updateSelfImprovementRun(pool, rolledBackRunId, "merged", {
      ...baseMetadata,
      pullRequestNumber: 45,
      pullRequestUrl: "https://github.com/example/repo/pull/45",
      mergeCommitSha: "e".repeat(40),
    });
    await updateSelfImprovementRun(pool, rolledBackRunId, "rolled_back", {
      ...baseMetadata,
      pullRequestNumber: 45,
      pullRequestUrl: "https://github.com/example/repo/pull/45",
      mergeCommitSha: "e".repeat(40),
      runtimeRevision: "f".repeat(40),
      rollbackRevision: "f".repeat(40),
    });

    const rows = await pool.query(
      "SELECT id, state, runtime_revision, merge_commit_sha, rollback_revision FROM jarvis_self_improvement_runs WHERE capability_id = $1 ORDER BY id",
      [capabilityId],
    );
    const verified = rows.rows.find((row) => row.id === verifiedRunId);
    const rolledBack = rows.rows.find((row) => row.id === rolledBackRunId);
    assert.equal(verified.state, "runtime_verified");
    assert.equal(verified.runtime_revision, "d".repeat(40));
    assert.equal(verified.merge_commit_sha, "d".repeat(40));
    assert.equal(rolledBack.state, "rolled_back");
    assert.equal(rolledBack.merge_commit_sha, "e".repeat(40));
    assert.equal(rolledBack.runtime_revision, "f".repeat(40));
    assert.equal(rolledBack.rollback_revision, "f".repeat(40));
  } finally {
    await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE capability_id = $1", [capabilityId]).catch(() => {});
    await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
    await pool.end();
  }
});
