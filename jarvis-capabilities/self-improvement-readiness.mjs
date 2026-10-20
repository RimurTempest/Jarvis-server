const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidBranch(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("\\\\") &&
    BRANCH_PATTERN.test(value);
}

/**
 * Reports only boolean readiness checks and missing setting names.
 * Never returns secret values or provider configuration contents.
 */
export function getSelfImprovementReadiness({
  env = {},
  databaseAvailable = false,
  databaseInitialized = false,
  providerCount = 0,
  workerRunning = false,
  autoMergeConfigured = false,
} = {}) {
  const checks = {
    featureEnabled: env.JARVIS_SELF_IMPROVEMENT_ENABLED === "true",
    databaseAvailable: databaseAvailable === true,
    databaseInitialized: databaseInitialized === true,
    aiProviderAvailable: Number.isInteger(providerCount) && providerCount > 0,
    webResearchConfigured: hasText(env.EXA_API_KEY),
    githubPublisherConfigured: typeof env.JARVIS_GITHUB_TOKEN === "string" &&
      env.JARVIS_GITHUB_TOKEN.trim().length >= 20,
  };

  const missingRequirements = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  const targets = {
    server: hasText(env.JARVIS_GITHUB_REPOSITORY) &&
      REPOSITORY_PATTERN.test(env.JARVIS_GITHUB_REPOSITORY.trim()),
    android: hasText(env.JARVIS_ANDROID_REPOSITORY) &&
      REPOSITORY_PATTERN.test(env.JARVIS_ANDROID_REPOSITORY.trim()),
    fullStack: hasText(env.JARVIS_FULL_STACK_REPOSITORY) &&
      REPOSITORY_PATTERN.test(env.JARVIS_FULL_STACK_REPOSITORY.trim()),
  };

  const targetConfiguration = {
    server: {
      repositoryConfigured: targets.server,
      baseBranchConfigured: isValidBranch(env.JARVIS_GITHUB_BASE_BRANCH || "main"),
    },
    android: {
      repositoryConfigured: targets.android,
      baseBranchConfigured: isValidBranch(env.JARVIS_ANDROID_BASE_BRANCH || "main"),
    },
    fullStack: {
      repositoryConfigured: targets.fullStack,
      baseBranchConfigured: isValidBranch(env.JARVIS_FULL_STACK_BASE_BRANCH || "main"),
    },
  };
  for (const target of Object.values(targetConfiguration)) {
    target.configured = target.repositoryConfigured && target.baseBranchConfigured;
  }

  const hasAnyRepository = Object.values(targets).some(Boolean);
  const hasConfiguredTarget = Object.values(targetConfiguration).some((target) => target.configured);
  if (!hasAnyRepository) missingRequirements.push("targetRepository");
  else if (!hasConfiguredTarget) missingRequirements.push("targetBaseBranch");

  const pipelineConfigured = missingRequirements.length === 0;
  return {
    pipelineConfigured,
    workerRunning: workerRunning === true,
    ready: pipelineConfigured && hasConfiguredTarget && workerRunning === true,
    checks,
    missingRequirements,
    targets,
    targetConfiguration,
    activation: {
      autoMergeOptIn: env.JARVIS_SELF_IMPROVEMENT_AUTO_MERGE === "true" &&
        typeof env.JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN === "string" &&
        env.JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN.trim().length >= 20,
      autoMergeConfigured: autoMergeConfigured === true,
      note: "Auto-merge readiness also depends on target, branch, CI, and runtime-health checks for each run.",
      githubTokenPermissionsVerified: false,
      noteOnCredentials: "Presence and format are checked; actual GitHub permissions and token validity are not tested by this diagnostic.",
    },
  };
}
