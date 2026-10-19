import test from "node:test";
import assert from "node:assert/strict";
import { prepareSelfImprovementDraft } from "../self-improvement-pipeline.mjs";

function setup(overrides = {}) {
  const stages = [];
  const calls = [];
  const options = {
    capability: { id: "capability-123", goal: "Add an email capability." },
    provider: { client: { id: "mock" }, model: "test-model" },
    githubToken: "x".repeat(40),
    repository: "example/repo",
    baseBranch: "main",
    searchResearch: async () => ({
      available: true,
      results: [{ title: "Official docs", url: "https://docs.example.com/api", text: "API documentation." }],
    }),
    fetchContext: async () => ({
      repository: "example/repo",
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      contextFiles: [{ path: "server.js", content: "export const current = true;" }],
    }),
    generateProposal: async (args) => {
      calls.push({ stage: "generate", args });
      return {
        summary: "Add a safe email proposal.",
        proposal: { requestId: args.requestId, baseRevision: args.baseRevision, files: [{ path: "jarvis-capabilities/email.mjs", content: "export const email = true;" }], tests: ["email test"] },
        validation: { ok: true, proposalDigest: "b".repeat(64), requiresHumanReview: false },
      };
    },
    publishDraft: async (args) => {
      calls.push({ stage: "publish", args });
      return { number: 42, url: "https://github.com/example/repo/pull/42", draft: true };
    },
    onStage: async (stage) => stages.push(stage),
    ...overrides,
  };
  return { options, stages, calls };
}

test("runs research, context, generation and draft publishing in order", async () => {
  const { options, stages, calls } = setup();
  const result = await prepareSelfImprovementDraft(options);
  assert.deepEqual(stages, ["researching", "collecting_context", "generating", "publishing", "draft_pr_created"]);
  assert.equal(result.pullRequest.draft, true);
  assert.equal(result.baseRevision, "a".repeat(40));
  assert.equal(result.proposalDigest, "b".repeat(64));
  assert.deepEqual(calls.map((call) => call.stage), ["generate", "publish"]);
});

test("stops when web research has no usable HTTPS sources", async () => {
  const { options, stages, calls } = setup({
    searchResearch: async () => ({ available: true, results: [{ title: "HTTP only", url: "http://example.com", text: "not trusted" }] }),
  });
  await assert.rejects(prepareSelfImprovementDraft(options), /Nenhuma fonte HTTPS/i);
  assert.deepEqual(stages, ["researching"]);
  assert.equal(calls.length, 0);
});

test("does not generate or publish when repository context is invalid", async () => {
  const { options, stages, calls } = setup({ fetchContext: async () => ({ repository: "wrong/repo" }) });
  await assert.rejects(prepareSelfImprovementDraft(options), /coletor de contexto/i);
  assert.deepEqual(stages, ["researching", "collecting_context"]);
  assert.equal(calls.length, 0);
});

test("does not publish when generated proposal fails validation", async () => {
  const { options, calls } = setup({
    generateProposal: async () => ({ summary: "bad", proposal: {}, validation: { ok: false } }),
  });
  await assert.rejects(prepareSelfImprovementDraft(options), /não passou pela política/i);
  assert.equal(calls.some((call) => call.stage === "publish"), false);
});

test("rejects a publisher result that is not a draft pull request", async () => {
  const { options } = setup({ publishDraft: async () => ({ draft: false, url: "https://github.com/example/repo/pull/42" }) });
  await assert.rejects(prepareSelfImprovementDraft(options), /draft/i);
});

test("rejects invalid provider or missing GitHub credentials before research", async () => {
  const first = setup({ provider: null });
  await assert.rejects(prepareSelfImprovementDraft(first.options), /Provedor de IA/i);
  assert.deepEqual(first.stages, []);
  const second = setup({ githubToken: "" });
  await assert.rejects(prepareSelfImprovementDraft(second.options), /Token do GitHub/i);
  assert.deepEqual(second.stages, []);
});
