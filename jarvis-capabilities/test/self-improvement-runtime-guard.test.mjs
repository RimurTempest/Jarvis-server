import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntimeHealthUrl,
  verifyRuntimeRevision,
  revertMergedCommitSafely,
} from "../self-improvement-runtime-guard.mjs";

const sha = (char) => char.repeat(40);

test("resolves only HTTPS runtime health URLs", () => {
  assert.equal(resolveRuntimeHealthUrl({ JARVIS_RUNTIME_HEALTHCHECK_URL: "http://example.com/health" }), null);
  assert.equal(resolveRuntimeHealthUrl({ JARVIS_RUNTIME_HEALTHCHECK_URL: "https://example.com/health" }), "https://example.com/health");
  assert.equal(resolveRuntimeHealthUrl({ RENDER_EXTERNAL_URL: "https://jarvis.onrender.com" }), "https://jarvis.onrender.com/health");
  assert.equal(resolveRuntimeHealthUrl({}), null);
  assert.equal(resolveRuntimeHealthUrl({ RENDER_EXTERNAL_URL: "not a URL" }), null);
});

test("verifies only a healthy runtime reporting the exact merged revision", async () => {
  const responses = [
    { ok: true, status: 200, body: { status: "ok", database: "connected", aiProviders: 1, revision: sha("b") } },
    { ok: true, status: 200, body: { status: "ok", database: "connected", aiProviders: 1, revision: sha("a") } },
  ];
  const result = await verifyRuntimeRevision({
    healthUrl: "https://jarvis.example/health",
    expectedRevision: sha("a"),
    fetchImpl: async () => {
      const item = responses.shift();
      return { ok: item.ok, status: item.status, async json() { return item.body; } };
    },
    sleep: async () => {},
    maxPolls: 3,
    intervalMs: 0,
  });
  assert.deepEqual(result, { verified: true, attempts: 2, revision: sha("a") });
});

test("does not call an unhealthy or unversioned runtime verified", async () => {
  const result = await verifyRuntimeRevision({
    healthUrl: "https://jarvis.example/health",
    expectedRevision: sha("a"),
    fetchImpl: async () => ({ ok: true, status: 200, async json() {
      return { status: "ok", database: "connected", aiProviders: 1, revision: null };
    } }),
    sleep: async () => {},
    maxPolls: 2,
    intervalMs: 0,
  });
  assert.deepEqual(result, { verified: false, reason: "runtime_revision_not_healthy" });
});

function githubMock(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    const result = await handler({ url, method: options.method, body, calls });
    return {
      ok: result.ok !== false,
      status: result.status ?? 200,
      async json() { return result.payload; },
    };
  };
  return { fetchImpl, calls };
}

test("rolls back only when branch head is exactly the failed merge commit", async () => {
  const mergeSha = sha("a");
  const parentSha = sha("b");
  const parentTreeSha = sha("c");
  const revertSha = sha("d");
  const mock = githubMock(({ url, method }) => {
    if (url.endsWith("/git/ref/heads/main") && method === "GET") return { payload: { object: { sha: mergeSha } } };
    if (url.endsWith("/git/commits/" + mergeSha)) return { payload: { parents: [{ sha: parentSha }] } };
    if (url.endsWith("/git/commits/" + parentSha)) return { payload: { tree: { sha: parentTreeSha } } };
    if (url.endsWith("/git/commits") && method === "POST") return { payload: { sha: revertSha } };
    if (url.endsWith("/git/refs/heads/main") && method === "PATCH") return { payload: { object: { sha: revertSha } } };
    throw new Error("Unexpected GitHub request: " + method + " " + url);
  });
  const result = await revertMergedCommitSafely({
    token: "x".repeat(30),
    repository: "example/repo",
    baseBranch: "main",
    mergeCommitSha: mergeSha,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { rolledBack: true, revertCommitSha: revertSha, revertedCommitSha: mergeSha });
  assert.equal(mock.calls.at(-1).method, "PATCH");
  assert.equal(mock.calls.at(-1).body.force, false);
});

test("refuses rollback when the base branch has advanced", async () => {
  const mock = githubMock(() => ({ payload: { object: { sha: sha("e") } } }));
  const result = await revertMergedCommitSafely({
    token: "x".repeat(30),
    repository: "example/repo",
    baseBranch: "main",
    mergeCommitSha: sha("a"),
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { rolledBack: false, reason: "branch_advanced" });
  assert.equal(mock.calls.length, 1);
});
