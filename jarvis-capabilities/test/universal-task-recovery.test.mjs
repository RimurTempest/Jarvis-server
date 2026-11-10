import test from "node:test";
import assert from "node:assert/strict";
import { resolveUniversalTaskRecovery } from "../universal-task-recovery.mjs";

test("recovers completed preparation into approval without claiming action execution", () => {
  for (const runState of ["draft_pr_created", "runtime_verified"]) {
    const result = resolveUniversalTaskRecovery(runState, "testing");
    assert.equal(result.state, "awaiting_approval");
    assert.match(result.summary, /tarefa original ainda não foi executada/);
    assert.equal(result.blocker, null);
  }
});

test("blocks tasks after failed, rolled back, or unverified runs", () => {
  for (const runState of ["failed", "rolled_back", "merge_unverified"]) {
    const result = resolveUniversalTaskRecovery(runState, "implementing");
    assert.equal(result.state, "blocked");
    assert.match(result.summary, /tarefa original não foi executada/);
    assert.ok(result.blocker);
  }
});

test("does not interrupt active or still-verifying runs", () => {
  for (const runState of ["queued", "researching", "collecting_context", "generating", "publishing", "merged"]) {
    assert.equal(resolveUniversalTaskRecovery(runState, "researching"), null);
  }
});

test("does not rewrite tasks that are already terminal or awaiting approval", () => {
  assert.equal(resolveUniversalTaskRecovery("failed", "blocked"), null);
  assert.equal(resolveUniversalTaskRecovery("draft_pr_created", "awaiting_approval"), null);
  assert.equal(resolveUniversalTaskRecovery("runtime_verified", "completed"), null);
});
