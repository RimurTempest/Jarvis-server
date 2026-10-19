import test from "node:test";
import assert from "node:assert/strict";
import { activateValidatedSelfImprovementDraft } from "../self-improvement-auto-activation.mjs";

const base = {
  enabled: true,
  token: "x".repeat(30),
  repository: "example/repo",
  pullRequestNumber: 12,
  baseBranch: "main",
  expectedHeadSha: "a".repeat(40),
  validation: { ready: true },
  requiresHumanReview: false,
  changedPaths: ["jarvis-capabilities/email-delivery.mjs", "jarvis-capabilities/test/email-delivery.test.mjs"],
};

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      async json() { return next.payload; },
    };
  };
  return { fetchImpl, calls };
}

test("does not activate when disabled, CI failed, or human review is required", async () => {
  assert.deepEqual(await activateValidatedSelfImprovementDraft({ ...base, enabled: false }), {
    activated: false, reason: "auto_activation_disabled",
  });
  assert.deepEqual(await activateValidatedSelfImprovementDraft({ ...base, validation: { ready: false } }), {
    activated: false, reason: "ci_not_passed",
  });
  assert.deepEqual(await activateValidatedSelfImprovementDraft({ ...base, requiresHumanReview: true }), {
    activated: false, reason: "human_review_required",
  });
});

test("keeps protected paths draft-only", async () => {
  const result = await activateValidatedSelfImprovementDraft({
    ...base,
    changedPaths: ["server.js"],
  });
  assert.deepEqual(result, { activated: false, reason: "protected_paths" });
  const policyPath = await activateValidatedSelfImprovementDraft({
    ...base,
    changedPaths: ["jarvis-capabilities/self-improvement-pipeline.mjs"],
  });
  assert.deepEqual(policyPath, { activated: false, reason: "protected_paths" });
});

test("refuses a stale or non-draft PR before any merge call", async () => {
  const mock = mockFetch([{
    payload: { state: "open", draft: true, base: { ref: "main" }, head: { sha: "b".repeat(40) } },
  }]);
  const result = await activateValidatedSelfImprovementDraft({ ...base, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { activated: false, reason: "stale_or_non_draft_pr" });
  assert.equal(mock.calls.length, 1);
});

test("marks a safe exact-SHA draft ready and merges only after validation", async () => {
  const mock = mockFetch([
    { payload: { state: "open", draft: true, base: { ref: "main" }, head: { sha: "a".repeat(40) } } },
    { payload: { ok: true } },
    { payload: { merged: true, sha: "c".repeat(40) } },
  ]);
  const result = await activateValidatedSelfImprovementDraft({ ...base, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { activated: true, mergeCommitSha: "c".repeat(40), pullRequestNumber: 12 });
  assert.equal(mock.calls[1].url.endsWith("/ready_for_review"), true);
  assert.equal(mock.calls[2].url.endsWith("/merge"), true);
  assert.equal(mock.calls[2].body.sha, "a".repeat(40));
});

test("reverts the PR to draft when the merge attempt fails", async () => {
  const mock = mockFetch([
    { payload: { state: "open", draft: true, base: { ref: "main" }, head: { sha: "a".repeat(40) } } },
    { payload: { ok: true } },
    { ok: false, status: 409, payload: { message: "merge conflict" } },
    { payload: { ok: true } },
  ]);
  await assert.rejects(
    activateValidatedSelfImprovementDraft({ ...base, fetchImpl: mock.fetchImpl }),
    /HTTP 409/,
  );
  assert.equal(mock.calls[3].url.endsWith("/convert_to_draft"), true);
});
