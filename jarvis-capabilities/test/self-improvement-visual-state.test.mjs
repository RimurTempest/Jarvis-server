import test from "node:test";
import assert from "node:assert/strict";
import { getSelfImprovementVisualState } from "../self-improvement-visual-state.mjs";

test("keeps the logo white while the update is still being prepared", () => {
  for (const state of ["queued", "researching", "collecting_context", "generating", "publishing", "merged"]) {
    const result = getSelfImprovementVisualState(state);
    assert.equal(result.visualState, "white", state);
    assert.equal(result.shouldNotifyUser, false, state);
  }
});

test("turns green only when the update was sent or runtime activation was verified", () => {
  for (const state of ["draft_pr_created", "runtime_verified"]) {
    const result = getSelfImprovementVisualState(state);
    assert.equal(result.visualState, "green", state);
    assert.equal(result.shouldNotifyUser, true, state);
    assert.match(result.message, /autoatualiza/i);
  }
});

test("turns red for a failure, a confirmed rollback, or an unverified recovery", () => {
  for (const state of ["failed", "rolled_back", "merge_unverified"]) {
    const result = getSelfImprovementVisualState(state);
    assert.equal(result.visualState, "red", state);
    assert.equal(result.shouldNotifyUser, true, state);
  }
});

test("unknown states fail visibly instead of falsely showing progress or success", () => {
  const result = getSelfImprovementVisualState("unexpected_state");
  assert.equal(result.visualState, "red");
  assert.equal(result.shouldNotifyUser, true);
  assert.match(result.message, /não reconhece/i);
});

test("does not treat missing states as successful updates", () => {
  assert.equal(getSelfImprovementVisualState(null).visualState, "red");
});
