const RECOVERABLE_TASK_STATES = new Set(["researching", "planning", "implementing", "testing"]);

const AWAITING_APPROVAL = new Set(["draft_pr_created", "runtime_verified"]);
const BLOCKED = new Set(["failed", "rolled_back", "merge_unverified"]);

/**
 * Resolves task state after a restart interrupted the final task/run sync.
 * A code proposal or healthy deployment is not proof that the original user
 * action was executed, so successful preparation still requires approval.
 */
export function resolveUniversalTaskRecovery(runState, taskState) {
  if (!RECOVERABLE_TASK_STATES.has(taskState)) return null;

  if (AWAITING_APPROVAL.has(runState)) {
    return {
      state: "awaiting_approval",
      summary: runState === "draft_pr_created"
        ? "A proposta foi criada e aguarda revisão; a tarefa original ainda não foi executada."
        : "A revisão foi verificada em runtime, mas a tarefa original ainda não foi executada.",
      blocker: null,
    };
  }

  if (BLOCKED.has(runState)) {
    const descriptions = {
      failed: "A preparação da capacidade falhou; nenhuma execução da tarefa original foi confirmada.",
      rolled_back: "A alteração foi revertida após a verificação; a tarefa original não foi executada.",
      merge_unverified: "Não foi possível confirmar a alteração ou a recuperação; a tarefa original não foi executada.",
    };
    return {
      state: "blocked",
      summary: descriptions[runState],
      blocker: runState === "failed"
        ? "Pipeline de autoaperfeiçoamento terminou com falha."
        : runState === "rolled_back"
          ? "A alteração foi revertida e requer nova revisão."
          : "Estado de runtime não confirmado; revisão humana necessária.",
    };
  }

  // Active stages and "merged" (runtime verification may still be in progress)
  // must not be converted to terminal task states during startup.
  return null;
}
