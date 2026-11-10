import test from "node:test";
import assert from "node:assert/strict";
import { createDraftSelfImprovementPullRequest } from "../self-improvement-github-publisher.mjs";
import { validateSelfImprovementProposal } from "../self-improvement-proposal-policy.mjs";

const revision = "a".repeat(40);
const treeSha = "b".repeat(40);
const commitSha = "c".repeat(40);
const blobSha = "d".repeat(40);

function proposal(overrides = {}) {
  return {
    requestId: "capability-123",
    baseRevision: revision,
    riskLevel: "standard",
    files: [{ path: "jarvis-capabilities/new-capability.mjs", content: "export const ok = true;\n" }],
    tests: ["node --test jarvis-capabilities/test/new-capability.test.mjs"],
    ...overrides,
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function fakeFetch({ mismatch = false, failPullRequest = false, existingPr = false, existingBranch = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/git/ref/heads/main")) {
      return response(200, { object: { sha: mismatch ? "f".repeat(40) : revision } });
    }
    if (url.endsWith(`/git/commits/${revision}`)) return response(200, { tree: { sha: treeSha } });
    if (url.endsWith(`/git/commits/${commitSha}`)) return response(200, { tree: { sha: treeSha }, parents: [{ sha: revision }] });
    if (url.endsWith("/git/blobs")) return response(201, { sha: blobSha });
    if (url.endsWith("/git/trees")) return response(201, { sha: treeSha });
    if (url.endsWith("/git/commits")) return response(201, { sha: commitSha });
    if (url.includes("/pulls?")) {
      if (!existingPr) return response(200, []);
      const digest = validateSelfImprovementProposal(proposal()).proposalDigest;
      return response(200, [{ number: 42, state: "open", draft: true, html_url: "https://github.com/example/repo/pull/42", head: { ref: `jarvis/proposals/capability-123-${digest.slice(0, 12)}`, sha: commitSha }, base: { ref: "main" } }]);
    }
    if (url.includes("/git/ref/heads/jarvis/proposals/")) {
      if (existingBranch) return response(200, { object: { sha: commitSha } });
      return response(404, {});
    }
    if (url.endsWith("/git/refs")) return response(201, { ref: "refs/heads/jarvis/proposals/capability-123-abc" });
    if (url.endsWith("/pulls")) {
      if (failPullRequest) return response(403, { message: "permission denied" });
      return response(201, { number: 42, html_url: "https://github.com/example/repo/pull/42", draft: true });
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
  };
  return { fetchImpl, calls };
}

test("publishes a valid proposal as a draft PR without merging", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await createDraftSelfImprovementPullRequest({
    token: "x".repeat(40),
    repository: "example/repo",
    baseBranch: "main",
    proposal: proposal(),
    fetchImpl,
  });
  assert.equal(result.number, 42);
  assert.equal(result.draft, true);
  assert.equal(result.baseRevision, revision);
  assert.equal(calls.some((call) => call.url.endsWith("/merges")), false);
  const pullRequestCall = calls.find((call) => call.url.endsWith("/pulls"));
  assert.equal(pullRequestCall.options.body.includes('"draft":true'), true);
  assert.equal(pullRequestCall.options.headers.Authorization, "Bearer " + "x".repeat(40));
});

test("rejects stale proposals before writing any blobs", async () => {
  const { fetchImpl, calls } = fakeFetch({ mismatch: true });
  await assert.rejects(
    createDraftSelfImprovementPullRequest({
      token: "x".repeat(40),
      repository: "example/repo",
      baseBranch: "main",
      proposal: proposal(),
      fetchImpl,
    }),
    /branch base mudou/i,
  );
  assert.equal(calls.some((call) => call.url.endsWith("/git/blobs")), false);
});

test("rejects unsafe proposals before calling GitHub", async () => {
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(
    createDraftSelfImprovementPullRequest({
      token: "x".repeat(40),
      repository: "example/repo",
      baseBranch: "main",
      proposal: proposal({ files: [{ path: "../.env", content: "secret" }] }),
      fetchImpl,
    }),
    /Proposta recusada pela política/i,
  );
  assert.equal(calls.length, 0);
});

test("does not expose GitHub error response bodies", async () => {
  const { fetchImpl } = fakeFetch({ failPullRequest: true });
  await assert.rejects(
    createDraftSelfImprovementPullRequest({
      token: "x".repeat(40),
      repository: "example/repo",
      baseBranch: "main",
      proposal: proposal(),
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /permission denied/);
      return true;
    },
  );
});

test("validates repository, branch, and token before network access", async () => {
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(createDraftSelfImprovementPullRequest({
    token: "short", repository: "example/repo", baseBranch: "main", proposal: proposal(), fetchImpl,
  }), /Token do GitHub/);
  await assert.rejects(createDraftSelfImprovementPullRequest({
    token: "x".repeat(40), repository: "https://example.com", baseBranch: "main", proposal: proposal(), fetchImpl,
  }), /repository/);
  await assert.rejects(createDraftSelfImprovementPullRequest({
    token: "x".repeat(40), repository: "example/repo", baseBranch: "../main", proposal: proposal(), fetchImpl,
  }), /baseBranch/);
  assert.equal(calls.length, 0);
});

test("escapes untrusted Markdown in test descriptions before publishing", async () => {
  const { fetchImpl, calls } = fakeFetch();
  await createDraftSelfImprovementPullRequest({
    token: "x".repeat(40),
    repository: "example/repo",
    baseBranch: "main",
    proposal: proposal({ tests: ["[click](https://evil.example)"] }),
    fetchImpl,
  });
  const pullRequestCall = calls.find((call) => call.url.endsWith("/pulls"));
  const body = JSON.parse(pullRequestCall.options.body).body;
  assert.match(body, /&#91;click&#93;/);
  assert.doesNotMatch(body, /\[click\]\(https:\/\/evil\.example\)/);
});

test("reuses an existing matching draft PR after an ambiguous retry", async () => {
  const { fetchImpl, calls } = fakeFetch({ existingPr: true });
  const result = await createDraftSelfImprovementPullRequest({
    token: "x".repeat(40),
    repository: "example/repo",
    baseBranch: "main",
    proposal: proposal(),
    fetchImpl,
  });
  assert.equal(result.reusedExisting, true);
  assert.equal(result.number, 42);
  assert.equal(result.commitSha, commitSha);
  assert.equal(calls.some((call) => call.url.endsWith("/git/refs")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/pulls")), false);
});
