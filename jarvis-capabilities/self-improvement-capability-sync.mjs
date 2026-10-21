import { transitionCapability } from "./capability-registry.mjs";

const SUCCESS_STATES = new Set(["draft_pr_created", "runtime_verified"]);
const BLOCKED_STATES = new Set(["failed", "merged", "rolled_back", "merge_unverified"]);

function safeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value)
    ? value
    : "pipeline_failed";
}

/**
 * Reconciles a capability's lifecycle with the terminal result of its
 * self-improvement run. A proposal or healthy runtime is never treated as
 * validated: reuse still requires independently attested capability evidence.
 */
export function resolveCapabilityRunOutcome(current, outcome = {}) {
  if (!current || typeof current !== "object" || !current.id) {
    throw new TypeError("Registro de capacidade inválido.");
  }
  const runState = outcome.runState;
  if (!SUCCESS_STATES.has(runState) && !BLOCKED_STATES.has(runState)) {
    throw new TypeError("Estado terminal de execução inválido.");
  }

  if (current.state === "validated") return current;

  if (BLOCKED_STATES.has(runState)) {
    if (current.state === "blocked") return current;
    return transitionCapability(current, {
      state: "blocked",
      reason: `A execução de autoaperfeiçoamento terminou sem confirmação de capacidade ativa (${safeErrorCode(outcome.errorCode)}).`,
    });
  }

  // A prepared record is already in the correct non-reusable state. Do not
  // downgrade it or fabricate evidence merely because another proposal ran.
  if (current.state === "prepared") return current;

  let researching = current;
  if (researching.state === "requested" || researching.state === "blocked") {
    researching = transitionCapability(researching, { state: "researching" });
  }

  const sourceRevision = outcome.sourceRevision;
  const changedPaths = Array.isArray(outcome.changedPaths)
    ? outcome.changedPaths.filter((path) => typeof path === "string" && path.trim()).slice(0, 50).map((path) => path.slice(0, 500))
    : [];
  const pullRequestNumber = Number.isSafeInteger(outcome.pullRequestNumber) && outcome.pullRequestNumber > 0
    ? outcome.pullRequestNumber
    : null;
  let pullRequestUrl = null;
  if (typeof outcome.pullRequestUrl === "string") {
    try {
      const url = new URL(outcome.pullRequestUrl);
      if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password) {
        pullRequestUrl = url.toString().slice(0, 2048);
      }
    } catch {}
  }
  const summary = typeof outcome.summary === "string" && outcome.summary.trim()
    ? outcome.summary.trim().slice(0, 1800)
    : "Proposta de implementação preparada e aguardando revisão.";
  const sourceCount = Number.isSafeInteger(outcome.sourceCount) && outcome.sourceCount >= 0
    ? outcome.sourceCount
    : 0;

  return transitionCapability(researching, {
    state: "prepared",
    research: `Pesquisa concluída com ${sourceCount} fonte(s). ${summary}`,
    requirements: changedPaths,
    executionPlan: `Proposta preparada${pullRequestNumber ? ` no pull request #${pullRequestNumber}` : ""}${pullRequestUrl ? ` (${pullRequestUrl})` : ""}. Requer revisão e autorização antes de ativar a alteração. ${summary}`,
    sourceRevision,
  });
}
