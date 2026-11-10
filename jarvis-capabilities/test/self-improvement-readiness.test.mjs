import test from "node:test";
import assert from "node:assert/strict";
import { getSelfImprovementReadiness } from "../self-improvement-readiness.mjs";

const readyEnv = {
  JARVIS_SELF_IMPROVEMENT_ENABLED: "true",
  EXA_API_KEY: "exa-test-key",
  JARVIS_GITHUB_TOKEN: "x".repeat(24),
  JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
  JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-Android",
};

test("reports ready only when prerequisites and worker are ready", () => {
  const result = getSelfImprovementReadiness({
    env: readyEnv,
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 2,
    workerRunning: true,
  });
  assert.equal(result.pipelineConfigured, true);
  assert.equal(result.workerRunning, true);
  assert.equal(result.ready, true);
  assert.deepEqual(result.missingRequirements, []);
  assert.equal(result.targets.server, true);
  assert.equal(result.targets.android, true);
  assert.equal(result.targets.fullStack, false);
});

test("reports disabled feature flag as a missing requirement", () => {
  const result = getSelfImprovementReadiness({
    env: { ...readyEnv, JARVIS_SELF_IMPROVEMENT_ENABLED: "false" },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.featureEnabled, false);
  assert.ok(result.missingRequirements.includes("featureEnabled"));
});

test("does not claim ready when the worker has not started", () => {
  const result = getSelfImprovementReadiness({
    env: readyEnv,
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: false,
  });
  assert.equal(result.pipelineConfigured, true);
  assert.equal(result.ready, false);
});

test("does not expose configured secret values", () => {
  const result = getSelfImprovementReadiness({
    env: {
      ...readyEnv,
      EXA_API_KEY: "exa-secret-value",
      JARVIS_GITHUB_TOKEN: "github-secret-value-123456",
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("exa-secret-value"), false);
  assert.equal(serialized.includes("github-secret-value"), false);
});

test("does not treat malformed repository values as configured targets", () => {
  const result = getSelfImprovementReadiness({
    env: { ...readyEnv, JARVIS_GITHUB_REPOSITORY: "https://github.com/RimurTempest/Jarvis-server" },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.targets.server, false);
});

test("does not report ready when no target repository is configured", () => {
  const result = getSelfImprovementReadiness({
    env: {
      JARVIS_SELF_IMPROVEMENT_ENABLED: "true",
      EXA_API_KEY: "exa-test-key",
      JARVIS_GITHUB_TOKEN: "x".repeat(24),
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.pipelineConfigured, false);
  assert.ok(result.missingRequirements.includes("targetRepository"));
});

test("reports auto-merge only as an explicit opt-in, not as a guarantee", () => {
  const result = getSelfImprovementReadiness({
    env: {
      ...readyEnv,
      JARVIS_SELF_IMPROVEMENT_AUTO_MERGE: "true",
      JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN: "m".repeat(24),
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.activation.autoMergeOptIn, true);
  assert.match(result.activation.note, /CI/);
});


test("does not confuse auto-merge opt-in with verified Render target configuration", () => {
  const result = getSelfImprovementReadiness({
    env: {
      ...readyEnv,
      JARVIS_SELF_IMPROVEMENT_AUTO_MERGE: "true",
      JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN: "m".repeat(24),
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
    autoMergeConfigured: false,
  });
  assert.equal(result.activation.autoMergeOptIn, true);
  assert.equal(result.activation.autoMergeConfigured, false);
});


test("does not report a target as configured when its base branch is unsafe", () => {
  const result = getSelfImprovementReadiness({
    env: {
      ...readyEnv,
      JARVIS_GITHUB_BASE_BRANCH: "../main",
      JARVIS_ANDROID_BASE_BRANCH: "feature\\\\bad",
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.targets.server, true);
  assert.equal(result.targetConfiguration.server.baseBranchConfigured, false);
  assert.equal(result.targetConfiguration.server.configured, false);
  assert.equal(result.targetConfiguration.android.configured, false);
  assert.equal(result.ready, false);
  assert.ok(result.missingRequirements.includes("targetBaseBranch"));
});

test("reports target-specific branch readiness without hiding another valid target", () => {
  const result = getSelfImprovementReadiness({
    env: {
      ...readyEnv,
      JARVIS_ANDROID_BASE_BRANCH: "../main",
    },
    databaseAvailable: true,
    databaseInitialized: true,
    providerCount: 1,
    workerRunning: true,
  });
  assert.equal(result.targetConfiguration.server.configured, true);
  assert.equal(result.targetConfiguration.android.repositoryConfigured, true);
  assert.equal(result.targetConfiguration.android.configured, false);
  assert.equal(result.ready, true);
});

test("rejects Git-invalid branch names for every configured target", () => {
  const invalidBranches = [
    "feature//broken",
    "feature/./broken",
    "feature/.hidden",
    "feature/name.lock",
    "feature/NAME.LOCK",
    "feature/name.",
    "feature/@{revision}",
    "feature name",
    "feature/~name",
    "feature/[name]",
    "@",
  ];

  for (const branch of invalidBranches) {
    const result = getSelfImprovementReadiness({
      env: {
        ...readyEnv,
        JARVIS_GITHUB_BASE_BRANCH: branch,
      },
      databaseAvailable: true,
      databaseInitialized: true,
      providerCount: 1,
      workerRunning: true,
    });

    assert.equal(
      result.targetConfiguration.server.baseBranchConfigured,
      false,
      `expected invalid branch to be rejected: ${branch}`,
    );
    assert.equal(result.targetConfiguration.server.configured, false);
  }
});

test("accepts common safe Git branch names", () => {
  for (const branch of ["main", "develop", "release/2026.10", "feature/secure-update_v2"]) {
    const result = getSelfImprovementReadiness({
      env: {
        ...readyEnv,
        JARVIS_GITHUB_BASE_BRANCH: branch,
      },
      databaseAvailable: true,
      databaseInitialized: true,
      providerCount: 1,
      workerRunning: true,
    });
    assert.equal(
      result.targetConfiguration.server.baseBranchConfigured,
      true,
      `expected safe branch to be accepted: ${branch}`,
    );
  }
});
