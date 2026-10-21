import test from "node:test";
import assert from "node:assert/strict";
import { inspectSelfImprovementGitHubAccess } from "../self-improvement-github-access.mjs";

const token = "github-test-token-12345678901234567890";
const repository = "RimurTempest/Jarvis-server";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("reports read access, repository push role, pull requests, and workflow visibility without secrets", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/repos/" + repository)) {
      return jsonResponse(200, { permissions: { push: true } });
    }
    if (url.includes("/pulls?")) return jsonResponse(200, []);
    if (url.includes("/actions/runs?")) return jsonResponse(200, { workflow_runs: [] });
    throw new Error("unexpected endpoint");
  };

  const result = await inspectSelfImprovementGitHubAccess({ token, repository, fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.repositoryReadable, true);
  assert.equal(result.accountCanPush, true);
  assert.equal(result.pullRequestsReadable, true);
  assert.equal(result.workflowRunsReadable, true);
  assert.equal(result.writePermissionsVerified, false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("reports rejected credentials without exposing provider response details", async () => {
  const fetchImpl = async () => jsonResponse(401, { message: "sensitive provider details" });
  const result = await inspectSelfImprovementGitHubAccess({ token, repository, fetchImpl });
  assert.equal(result.status, "github_token_rejected");
  assert.equal(result.repositoryReadable, false);
  assert.equal(JSON.stringify(result).includes("sensitive provider details"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("reports repository or permission failures without claiming readiness", async () => {
  const fetchImpl = async () => jsonResponse(404, { message: "Not Found" });
  const result = await inspectSelfImprovementGitHubAccess({ token, repository, fetchImpl });
  assert.equal(result.status, "repository_or_permission_not_found");
  assert.equal(result.repositoryReadable, false);
  assert.equal(result.pullRequestsReadable, false);
  assert.equal(result.workflowRunsReadable, false);
});

test("does not make network calls when the token or repository is invalid", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(200, {}); };
  const missingToken = await inspectSelfImprovementGitHubAccess({ token: "", repository, fetchImpl });
  const badRepository = await inspectSelfImprovementGitHubAccess({ token, repository: "https://github.com/" + repository, fetchImpl });
  assert.equal(missingToken.status, "token_missing_or_invalid");
  assert.equal(badRepository.status, "repository_not_configured");
  assert.equal(calls, 0);
});
