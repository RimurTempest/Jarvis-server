import test from "node:test";
import assert from "node:assert/strict";
import { runSelfImprovementCiRepairLoop } from "../self-improvement-ci-repair.mjs";

function draft(number) {
  return {
    summary: `draft ${number}`,
    pullRequest: {
      number,
      url: `https://github.com/example/repo/pull/${number}`,
      draft: true,
      commitSha: String(number).repeat(40).slice(0, 40),
    },
  };
}

const failedValidation = {
  ready: false,
  reasons: ['"JARVIS Capability Tests" não passou: status=completed, conclusão=failure.'],
  checks: [
    { name: "JARVIS Capability Tests", status: "completed", conclusion: "failure", runUrl: "https://github.com/example/repo/actions/runs/12" },
    { name: "JARVIS Android Enrollment Tests", status: "completed", conclusion: "success" },
  ],
  extraChecks: [],
};
const passingValidation = { ready: true, reasons: [], checks: [{ name: "JARVIS Capability Tests", status: "completed", conclusion: "success" }], extraChecks: [] };

test("creates a bounded repair proposal after a completed CI failure and returns only after a passing validation", async () => {
  const prepared = [];
  const repaired = [];
  let validationCalls = 0;
  let diagnosticCalls = 0;
  const result = await runSelfImprovementCiRepairLoop({
    capability: { id: "capability-email", goal: "Add email capability safely." },
    maxRepairAttempts: 2,
    maxValidationPolls: 3,
    pollIntervalMs: 0,
    sleep: async () => {},
    prepareDraft: async (input) => {
      prepared.push(input);
      return draft(prepared.length);
    },
    validateDraft: async () => {
      validationCalls += 1;
      return validationCalls === 1 ? failedValidation : passingValidation;
    },
    diagnoseFailure: async () => { diagnosticCalls += 1; return "Untrusted CI log excerpt: expected true but received false."; },
    onRepair: async (event) => repaired.push(event),
  });
  assert.equal(result.draft.pullRequest.number, 2);
  assert.equal(result.validation.ready, true);
  assert.equal(result.repairAttempts, 1);
  assert.equal(prepared.length, 2);
  assert.match(prepared[1].validationFeedback, /expected true but received false/);
  assert.equal(diagnosticCalls, 1);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].nextAttempt, 1);
});

test("stops after the configured maximum repair attempts without activating a draft", async () => {
  let prepared = 0;
  await assert.rejects(runSelfImprovementCiRepairLoop({
    capability: { id: "capability-email", goal: "Add email capability safely." },
    maxRepairAttempts: 1,
    maxValidationPolls: 1,
    pollIntervalMs: 0,
    sleep: async () => {},
    prepareDraft: async () => draft(++prepared),
    validateDraft: async () => failedValidation,
  }), (error) => error.code === "ci_repair_exhausted");
  assert.equal(prepared, 2);
});

test("does not repair while CI is pending and fails closed on timeout", async () => {
  let prepared = 0;
  const pending = { ready: false, reasons: ["workflow pending"], checks: [{ name: "CI", status: "in_progress", conclusion: null }], extraChecks: [] };
  await assert.rejects(runSelfImprovementCiRepairLoop({
    capability: { id: "capability-email", goal: "Add email capability safely." },
    maxRepairAttempts: 2,
    maxValidationPolls: 2,
    pollIntervalMs: 0,
    sleep: async () => {},
    prepareDraft: async () => { prepared += 1; return draft(prepared); },
    validateDraft: async () => pending,
  }), (error) => error.code === "ci_validation_timeout");
  assert.equal(prepared, 1);
});

test("stops if the PR head changed instead of attempting an unsafe repair", async () => {
  const stale = { ready: false, reasons: ["O SHA atual do pull request não corresponde à revisão exata da proposta."], checks: [], extraChecks: [] };
  await assert.rejects(runSelfImprovementCiRepairLoop({
    capability: { id: "capability-email", goal: "Add email capability safely." },
    maxValidationPolls: 1,
    pollIntervalMs: 0,
    sleep: async () => {},
    prepareDraft: async () => draft(1),
    validateDraft: async () => stale,
  }), (error) => error.code === "ci_repair_stale_revision");
});
