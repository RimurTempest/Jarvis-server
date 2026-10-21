import {
  canExecuteUniversalTask,
  createUniversalTaskPlan,
  executeUniversalTask,
} from "./universal-capability-execution.mjs";
import { persistUniversalTaskArtifacts, transitionUniversalTaskRecord } from "./universal-task-store.mjs";

const APPROVAL_REASONS = new Set([
  "explicit_confirmation_required",
  "required_permission_missing",
  "security_review_required",
]);

function verificationSummary(result) {
  const steps = Array.isArray(result?.completedSteps) ? result.completedSteps : [];
  return {
    status: result?.status === "succeeded" ? "succeeded" : "unverified",
    summary: result?.status === "succeeded"
      ? "Cada etapa concluída possui verificação independente."
      : "A execução não foi confirmada integralmente.",
    steps: steps.map((step) => ({
      kind: step.step,
      status: step.verification?.status ?? "unverified",
      evidence: step.verification?.evidence ?? null,
    })),
  };
}

/**
 * Coordinates the durable task state machine with the allowlisted universal executor.
 * This function does not discover or register adapters: callers must provide the
 * registry and trusted authorization state explicitly.
 */
export async function runPersistedUniversalTask({
  pool,
  task,
  plan: planInput,
  adapterRegistry,
  authorization = {},
  context = {},
  execute = executeUniversalTask,
}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Pool PostgreSQL inválido.");
  if (!task || typeof task.id !== "string" || !["planning", "awaiting_approval"].includes(task.state)) {
    throw new TypeError("A tarefa deve estar em planning ou awaiting_approval.");
  }
  const plan = createUniversalTaskPlan(planInput);
  let state = task.state;

  await persistUniversalTaskArtifacts(pool, {
    id: task.id,
    expectedState: state,
    plan,
  });

  const permission = canExecuteUniversalTask({ task, plan, adapterRegistry, authorization });
  if (!permission.allowed) {
    if (APPROVAL_REASONS.has(permission.reason)) {
      if (state !== "awaiting_approval") {
        await transitionUniversalTaskRecord(pool, {
          id: task.id,
          state: "awaiting_approval",
          summary: "O plano foi salvo; a execução aguarda autorização explícita.",
          blocker: permission.reason,
        });
      }
      return { status: "needs_user_action", reason: permission.reason, taskId: task.id };
    }

    const blocked = await transitionUniversalTaskRecord(pool, {
      id: task.id,
      state: "blocked",
      summary: "O plano foi salvo, mas não há executor autorizado compatível.",
      blocker: permission.reason,
    });
    if (blocked) {
      await persistUniversalTaskArtifacts(pool, {
        id: task.id,
        expectedState: "blocked",
        execution: { status: "needs_user_action", reason: permission.reason },
      });
    }
    return { status: "needs_user_action", reason: permission.reason, taskId: task.id };
  }

  if (state !== "ready") {
    await transitionUniversalTaskRecord(pool, {
      id: task.id,
      state: "ready",
      summary: "Plano validado; pré-condições de execução satisfeitas.",
      blocker: null,
    });
  }
  await transitionUniversalTaskRecord(pool, {
    id: task.id,
    state: "executing",
    summary: "Executor autorizado iniciado.",
    blocker: null,
  });

  let result;
  try {
    result = await execute({
      task: { ...task, state: "executing" },
      plan,
      adapterRegistry,
      authorization,
      context,
    });
  } catch {
    await transitionUniversalTaskRecord(pool, {
      id: task.id,
      state: "failed",
      summary: "O executor falhou; nenhum sucesso foi declarado.",
      blocker: "executor_error",
    });
    await persistUniversalTaskArtifacts(pool, {
      id: task.id,
      expectedState: "failed",
      execution: { status: "failed", reason: "executor_error" },
      verification: { status: "unverified", summary: "Não há evidência de conclusão." },
    });
    return { status: "failed", reason: "executor_error", taskId: task.id };
  }

  if (result?.status === "succeeded") {
    const verification = verificationSummary(result);
    await transitionUniversalTaskRecord(pool, {
      id: task.id,
      state: "verifying",
      summary: "Execução finalizada; persistindo evidências antes de concluir.",
      blocker: null,
    });
    await persistUniversalTaskArtifacts(pool, {
      id: task.id,
      expectedState: "verifying",
      execution: {
        status: "succeeded",
        summary: result.summary,
        completedSteps: result.completedSteps,
      },
      verification,
    });
    await transitionUniversalTaskRecord(pool, {
      id: task.id,
      state: "completed",
      summary: "Todas as etapas foram executadas e verificadas.",
      blocker: null,
    });
    return { status: "succeeded", taskId: task.id, summary: "Tarefa concluída e verificada." };
  }

  const failedState = result?.status === "unverified" ? "blocked" : "failed";
  await transitionUniversalTaskRecord(pool, {
    id: task.id,
    state: failedState,
    summary: result?.status === "unverified"
      ? "A execução não pôde ser verificada; tarefa bloqueada."
      : "A execução não foi concluída; tarefa marcada como falha.",
    blocker: result?.reason ?? "execution_not_succeeded",
  });
  await persistUniversalTaskArtifacts(pool, {
    id: task.id,
    expectedState: failedState,
    execution: {
      status: result?.status === "unverified" ? "unverified" : "failed",
      reason: result?.reason ?? "execution_not_succeeded",
      completedSteps: Array.isArray(result?.completedSteps) ? result.completedSteps : [],
    },
    verification: verificationSummary(result),
  });
  return {
    status: result?.status === "unverified" ? "unverified" : "failed",
    reason: result?.reason ?? "execution_not_succeeded",
    taskId: task.id,
  };
}
