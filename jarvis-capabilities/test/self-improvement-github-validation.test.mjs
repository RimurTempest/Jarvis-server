import test from "node:test";
import assert from "node:assert/strict";
import { inspectDraftPullRequestValidation, REQUIRED_SELF_IMPROVEMENT_WORKFLOWS } from "../self-improvement-github-validation.mjs";

const sha = "a".repeat(40);
const workflows = REQUIRED_SELF_IMPROVEMENT_WORKFLOWS;

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function fakeFetch({ headSha = sha, missing = [], failure = null, pending = null, draft = true, extraRun = null } = {}) {
  const calls = [];
  const pullRequest = { number: 42, state: "open", draft, html_url: "https://github.com/example/repo/pull/42", head: { sha: headSha } };
  const runs = workflows.filter((name) => !missing.includes(name)).map((name, index) => ({
    id: index + 1,
    name,
    status: pending === name ? "in_progress" : "completed",
    conclusion: failure === name ? "failure" : pending === name ? null : "success",
    head_sha: sha,
    event: "pull_request",
    created_at: new Date(2026, 0, index + 1).toISOString(),
    html_url: `https://github.com/example/repo/actions/runs/${index + 1}`,
    pull_requests: [{ number: 42 }],
  }));
  if (extraRun) runs.push({ ...extraRun, head_sha: sha, event: "pull_request", pull_requests: [{ number: 42 }] });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/pulls/42")) return response(200, pullRequest);
    if (url.includes("/actions/runs?")) return response(200, { total_count: runs.length, workflow_runs: runs });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchImpl, calls };
}

function input(overrides = {}) {
  const { fetchImpl } = fakeFetch();
  return {
    token: "x".repeat(40),
    repository: "example/repo",
    pullRequestNumber: 42,
    expectedHeadSha: sha,
    fetchImpl,
    ...overrides,
  };
}

test("accepts only when every required workflow passed on the exact open draft PR head", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await inspectDraftPullRequestValidation(input({ fetchImpl }));
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.map((check) => check.name), workflows);
  assert.equal(calls.length, 2);
});

test("fails closed when a required workflow is missing", async () => {
  const { fetchImpl } = fakeFetch({ missing: ["JARVIS Update Safety Tests"] });
  const result = await inspectDraftPullRequestValidation(input({ fetchImpl }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /Falta uma execução/i);
});

test("fails closed on failed or still-running checks", async () => {
  const failed = await inspectDraftPullRequestValidation(input({ fetchImpl: fakeFetch({ failure: workflows[0] }).fetchImpl }));
  assert.equal(failed.ready, false);
  const pending = await inspectDraftPullRequestValidation(input({ fetchImpl: fakeFetch({ pending: workflows[1] }).fetchImpl }));
  assert.equal(pending.ready, false);
});

test("does not inspect actions when the PR head changed", async () => {
  const { fetchImpl, calls } = fakeFetch({ headSha: "b".repeat(40) });
  const result = await inspectDraftPullRequestValidation(input({ fetchImpl }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /SHA atual/i);
  assert.equal(calls.length, 1);
});

test("requires the PR to remain a draft", async () => {
  const { fetchImpl } = fakeFetch({ draft: false });
  const result = await inspectDraftPullRequestValidation(input({ fetchImpl }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /estado draft/i);
});

test("validates input before network access", async () => {
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(inspectDraftPullRequestValidation(input({ token: "short", fetchImpl })), /Token do GitHub/i);
  await assert.rejects(inspectDraftPullRequestValidation(input({ expectedHeadSha: "main", fetchImpl })), /SHA completo/i);
  assert.equal(calls.length, 0);
});

test("fails closed when an additional workflow failed on the same PR revision", async () => {
  const { fetchImpl } = fakeFetch({
    extraRun: {
      id: 99,
      name: "Extra Security Scan",
      status: "completed",
      conclusion: "failure",
      created_at: new Date(2026, 0, 10).toISOString(),
      html_url: "https://github.com/example/repo/actions/runs/99",
    },
  });
  const result = await inspectDraftPullRequestValidation(input({ fetchImpl }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /workflow adicional/i);
});
