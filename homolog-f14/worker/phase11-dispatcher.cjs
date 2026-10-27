"use strict";

const { runEvolution } = require("./evolution-worker.cjs");
const { taskId } = require("./dev-workspace.cjs");

function safeSummary(value) {
  if (typeof value !== "string") return "Desenvolvimento local concluído; exige revisão humana.";
  const cleaned = value.replace(/[\x00-\x1f]/g, " ").trim();
  return cleaned.slice(0, 750) || "Execução encerrada; exige revisão humana.";
}
function reportOutcome(id, result) {
  if (!result || result.taskId !== id || result.applied !== true ||
      result.localTestsValidated !== true ||
      result.isolatedTests?.executed !== true ||
      result.isolatedTests?.passed !== true ||
      !/^[a-f0-9]{40}$/.test(result.localCommitSha || "") ||
      result.branch !== `work/evolution/${id}` ||
      result.remoteTouched !== false || result.installed !== false ||
      result.capabilityLearned !== false || result.readyForRelease !== false) {
    throw new Error("Resultado não comprova testes isolados e commit na branch esperada.");
  }
  return {
    status: "needs_review",
    summary: safeSummary(result.summary),
    testsExecuted: true, testsPassed: true,
    commitSha: result.localCommitSha, branch: result.branch
  };
}

/**
 * Trânsito Fase 11 → Fase 10. O servidor autentica autorização antes do claim;
 * a API antiga context/advance é emulada APENAS dentro do processo worker.
 * Não cria tarefas, nem aprova publicação/instalação.
 */
async function processAuthorizedOnce({
  api, provider, repositories, worktreesDir,
  execute = runEvolution,
  heartbeatMs = 60_000,
  renewTimeoutMs = 20_000,
  onReportError
}) {
  if (!api || typeof api.claim !== "function" || typeof api.renew !== "function" ||
      typeof api.report !== "function") {
    throw new Error("Ponte de fila autenticada indisponível.");
  }
  if (!provider || typeof provider.research !== "function" ||
      typeof provider.generate !== "function") {
    throw new Error("Provedor de pesquisa e desenvolvimento indisponível.");
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs > 300_000) {
    throw new Error("Intervalo de renovação inválido.");
  }
  if (!Number.isInteger(renewTimeoutMs) || renewTimeoutMs < 10 || renewTimeoutMs > 60_000) {
    throw new Error("Prazo de renovação inválido.");
  }
  const claimed = await api.claim();
  if (!claimed) return { status: "empty", claimed: false };
  const id = taskId(claimed.id);
  if (id !== claimed.id || typeof claimed.request !== "string" ||
      !claimed.request.trim() || claimed.request.length > 4000 ||
      typeof claimed.leaseToken !== "string" ||
      !/^[A-Za-z0-9_-]{40,100}$/.test(claimed.leaseToken)) {
    throw new Error("Solicitação reivindicada tem dados inválidos.");
  }
  let leaseFailure = null;
  const leaseController = new AbortController();
  let renewing = false;
  let renewTimer = null;
  const assertLease = () => {
    if (leaseFailure) throw new Error("Autorização de execução perdida; revisão manual necessária.");
  };
  const virtualApi = {
    context: async requestedId => {
      if (requestedId !== id) throw new Error("Acesso a outra tarefa recusado.");
      assertLease();
      return { task: { id, state: "requested", request_text: claimed.request } };
    },
    advance: async (requestedId, state) => {
      if (requestedId !== id ||
          !["researching", "planned", "blocked"].includes(state)) {
        throw new Error("Transição de execução não autorizada.");
      }
      assertLease();
      return { acknowledgedLocally: true, state };
    }
  };
  // O worker não deve imprimir texto livre do pedido ou tokens nos logs.
  const refresh = async () => {
    if (renewing || leaseFailure) return;
    renewing = true;
    let renewTimeout;
    try {
      await Promise.race([
        Promise.resolve().then(() => api.renew(id, claimed.leaseToken)),
        new Promise((_, reject) => {
          renewTimeout = setTimeout(() => reject(new Error("Renovação excedeu o prazo.")), renewTimeoutMs);
        })
      ]);
    } catch {
      leaseFailure = new Error("Renovação de lease recusada.");
      leaseController.abort();
    } finally {
      clearTimeout(renewTimeout);
      renewing = false;
    }
  };
  let outcome;
  let errorDuringExecution = null;
  try {
    // Revalidar no servidor ANTES de iniciar qualquer operação potencialmente custosa.
    await refresh();
    assertLease();
    renewTimer = setInterval(() => { void refresh(); }, heartbeatMs);
    const result = await execute({
      evolutionId: id, api: virtualApi, provider, repositories,
      worktreesDir, apply: true, assertLease, signal: leaseController.signal
    });
    assertLease();
    outcome = reportOutcome(id, result);
  } catch (error) {
    errorDuringExecution = error;
    outcome = {
      status: "blocked",
      summary: "Executor não concluiu uma implementação validada. Revisão necessária.",
      testsExecuted: false, testsPassed: false
    };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    // Uma renovação em trânsito precisa terminar antes do relatório.
    while (renewing) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assertLease();
  // O trabalho pode ter terminado entre dois heartbeats. Renovar novamente
  // antes do relatório impede aceitar localmente uma reserva já revogada.
  await refresh();
  assertLease();
  try {
    const response = await api.report(id, claimed.leaseToken, outcome);
    return {
      taskId: id, claimed: true, status: outcome.status,
      installed: false, learned: false, published: false,
      reportAccepted: response?.task?.id === id,
      ...(errorDuringExecution ? { localExecutionFailed: true } : {})
    };
  } catch (error) {
    if (typeof onReportError === "function") onReportError(error);
    throw new Error("Servidor não confirmou o relatório: revisão manual obrigatória.");
  }
}
module.exports = { processAuthorizedOnce, reportOutcome, safeSummary };
