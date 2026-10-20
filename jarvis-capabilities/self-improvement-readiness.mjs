const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
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

  const hasConfiguredTarget = Object.values(targets).some(Boolean);
  if (!hasConfiguredTarget) missingRequirements.push("targetRepository");

  const pipelineConfigured = missingRequirements.length === 0;
  return {
    pipelineConfigured,
    workerRunning: workerRunning === true,
    ready: pipelineConfigured && hasConfiguredTarget && workerRunning === true,
    checks,
    missingRequirements,
    targets,
    activation: {
      autoMergeOptIn: env.JARVIS_SELF_IMPROVEMENT_AUTO_MERGE === "true" &&
        typeof env.JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN === "string" &&
        env.JARVIS_SELF_IMPROVEMENT_MERGE_TOKEN.trim().length >= 20,
      note: "Auto-merge readiness also depends on target, branch, CI, and runtime-health checks for each run.",
      githubTokenPermissionsVerified: false,
      noteOnCredentials: "Presence and format are checked; actual GitHub permissions and token validity are not tested by this diagnostic.",
    },
  };
}
