import test from "node:test";
import assert from "node:assert/strict";
import { createCapabilityRequest, transitionCapability, capabilityCanBeReused } from "../capability-registry.mjs";
import { resolveCapabilityRunOutcome } from "../self-improvement-capability-sync.mjs";

const SHA = "a".repeat(40);
const base = () => transitionCapability(
  createCapabilityRequest({ id: "capability-sync-1", goal: "Preparar envio de e-mails" }),
  { state: "researching", research: "Pesquisa iniciada." },
);
const success = {
  runState: "draft_pr_created",
  summary: "Proposta pronta para revisão.",
  sourceCount: 3,
  sourceRevision: SHA,
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/example/repo/pull/42",
  changedPaths: ["server.js", "jarvis-capabilities/email.mjs"],
};

test("terminal successful proposal moves researching capability to prepared", () => {
  const prepared = resolveCapabilityRunOutcome(base(), success);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.sourceRevision, SHA);
  assert.deepEqual(prepared.requirements, success.changedPaths);
  assert.match(prepared.executionPlan, /pull request #42/);
  assert.equal(capabilityCanBeReused(prepared), false);
});

test("runtime health does not falsely mark a capability validated", () => {
  const prepared = resolveCapabilityRunOutcome(base(), { ...success, runState: "runtime_verified" });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.validation, null);
  assert.equal(capabilityCanBeReused(prepared), false);
});

test("failed, rolled-back, or unverified runs block the capability with a safe reason", () => {
  for (const runState of ["failed", "rolled_back", "merge_unverified", "merged"]) {
    const blocked = resolveCapabilityRunOutcome(base(), { runState, errorCode: "ci_validation_timeout" });
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.validation.reason, /ci_validation_timeout/);
  }
});

test("requested and blocked capabilities can be reconciled after a successful proposal", () => {
  const requested = createCapabilityRequest({ id: "capability-sync-2", goal: "Preparar envio de e-mails" });
  assert.equal(resolveCapabilityRunOutcome(requested, success).state, "prepared");
  const blocked = transitionCapability(requested, { state: "blocked", reason: "Falha anterior." });
  assert.equal(resolveCapabilityRunOutcome(blocked, success).state, "prepared");
});

test("a validated capability is never downgraded by a later run result", () => {
  const validated = {
    ...base(),
    state: "validated",
    validation: { status: "validated" },
  };
  assert.equal(resolveCapabilityRunOutcome(validated, { runState: "failed" }), validated);
});

test("invalid outcomes and missing source revisions fail closed", () => {
  assert.throws(() => resolveCapabilityRunOutcome(base(), { runState: "researching" }), /Estado terminal/);
  assert.throws(() => resolveCapabilityRunOutcome(base(), { ...success, sourceRevision: "not-a-sha" }), /sourceRevision/);
  assert.throws(() => resolveCapabilityRunOutcome(base(), { ...success, sourceRevision: undefined }), /sourceRevision/);
});
