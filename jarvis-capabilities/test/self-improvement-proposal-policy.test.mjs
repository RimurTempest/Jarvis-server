import test from "node:test";
import assert from "node:assert/strict";
import { validateSelfImprovementProposal } from "../self-improvement-proposal-policy.mjs";

const revision = "a".repeat(40);

function proposal(overrides = {}) {
  return {
    requestId: "capability-123",
    baseRevision: revision,
    riskLevel: "standard",
    files: [
      {
        path: "jarvis-capabilities/example-feature.mjs",
        content: "export function exampleFeature() { return true; }\n",
      },
      {
        path: "jarvis-capabilities/test/example-feature.test.mjs",
        content: "import test from \"node:test\";\ntest(\"example\", () => {});\n",
      },
    ],
    tests: ["node --test jarvis-capabilities/test/example-feature.test.mjs"],
    ...overrides,
  };
}

test("accepts a bounded proposal and computes a deterministic digest", () => {
  const input = proposal();
  const first = validateSelfImprovementProposal(input);
  const second = validateSelfImprovementProposal(input);
  assert.equal(first.ok, true);
  assert.equal(first.requiresHumanReview, false);
  assert.match(first.proposalDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.proposalDigest, second.proposalDigest);
});

test("digest is independent of file ordering", () => {
  const input = proposal();
  const reversed = { ...input, files: input.files.slice().reverse() };
  assert.equal(
    validateSelfImprovementProposal(input).proposalDigest,
    validateSelfImprovementProposal(reversed).proposalDigest,
  );
});

test("requires human review for server and workflow changes", () => {
  const result = validateSelfImprovementProposal(proposal({
    files: [{ path: "server.js", content: "const app = true;\n" }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.requiresHumanReview, true);
  assert.deepEqual(result.protectedPaths, ["server.js"]);
});

test("requires human review for elevated risk", () => {
  const result = validateSelfImprovementProposal(proposal({ riskLevel: "elevated" }));
  assert.equal(result.ok, true);
  assert.equal(result.requiresHumanReview, true);
});

test("rejects path traversal and absolute paths", () => {
  for (const path of ["../server.js", "/tmp/file.mjs", "jarvis-capabilities/../../x", "a\\b"]) {
    const result = validateSelfImprovementProposal(proposal({
      files: [{ path, content: "safe" }],
    }));
    assert.equal(result.ok, false, path);
    assert.equal(result.proposalDigest, null);
  }
});

test("rejects secret-bearing paths", () => {
  for (const path of [".env", ".env.production", "certs/private.pem", "secrets/token.txt", ".git/config"]) {
    const result = validateSelfImprovementProposal(proposal({
      files: [{ path, content: "safe" }],
    }));
    assert.equal(result.ok, false, path);
  }
});

test("rejects likely credentials in generated file content", () => {
  const result = validateSelfImprovementProposal(proposal({
    files: [{ path: "jarvis-capabilities/example.mjs", content: "const token = \"ghp_123456789012345678901234567890\";" }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /segredo detectado/i);
});

test("rejects duplicate file paths", () => {
  const input = proposal();
  const result = validateSelfImprovementProposal({
    ...input,
    files: [input.files[0], input.files[0]],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /duplicado/i);
});

test("rejects missing test plan and invalid source revision", () => {
  assert.equal(validateSelfImprovementProposal(proposal({ tests: [] })).ok, false);
  assert.equal(validateSelfImprovementProposal(proposal({ baseRevision: "main" })).ok, false);
});

test("rejects oversized proposals", () => {
  const result = validateSelfImprovementProposal(proposal({
    files: [{ path: "jarvis-capabilities/large.mjs", content: "x".repeat(100_001) }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /excede o limite/i);
});

test("never marks malformed input as safe for automatic handling", () => {
  const result = validateSelfImprovementProposal(null);
  assert.equal(result.ok, false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.proposalDigest, null);
});
