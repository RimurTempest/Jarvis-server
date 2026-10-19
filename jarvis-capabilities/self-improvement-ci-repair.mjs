const MAX_DIAGNOSTIC_CHARS = 6000;

function cleanDiagnostics(validation) {
  const lines = [];
  for (const item of [...(validation?.checks ?? []), ...(validation?.extraChecks ?? [])]) {
    lines.push(`Workflow: ${String(item?.name ?? "unknown").slice(0, 120)}; status=${String(item?.status ?? "unknown")}; conclusion=${String(item?.conclusion ?? "pending")}`);
    if (typeof item?.runUrl === "string" && item.runUrl.startsWith("https://github.com/")) {
      lines.push(`Run: ${item.runUrl.slice(0, 300)}`);
    }
  }
  for (const reason of (Array.isArray(validation?.reasons) ? validation.reasons : [])) {
    if (typeof reason === "string") lines.push(`Validation: ${reason.slice(0, 300)}`);
  }
  return lines.join("\n").slice(0, MAX_DIAGNOSTIC_CHARS) || "A validação CI não retornou detalhes suficientes.";
}

function hasUnsafeValidationFailure(validation) {
  return (validation?.reasons ?? []).some((reason) =>
    /SHA atual.*não corresponde|não está aberto|não está em estado draft/i.test(String(reason))
  );
}

function allChecksFinished(validation) {
  const checks = [...(validation?.checks ?? []), ...(validation?.extraChecks ?? [])];
  return checks.length > 0 && checks.every((check) =>
    check?.status === "completed" && typeof check?.conclusion === "string"
  );
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Waits for CI on the exact generated draft PR revision and, only after a
 * completed failure, asks the proposal generator for a bounded repair attempt.
 * Every attempt remains a draft PR; this controller never merges, deploys,
 * installs, or rolls back production software.
 */
export async function runSelfImprovementCiRepairLoop({
  capability,
  prepareDraft,
  validateDraft,
  onValidation = async () => {},
  onRepair = async () => {},
  maxRepairAttempts = 2,
  maxValidationPolls = 60,
  pollIntervalMs = 10000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!capability || typeof capability !== "object" ||
      typeof capability.id !== "string" || !capability.id.trim() ||
      typeof capability.goal !== "string" || !capability.goal.trim()) {
    throw new TypeError("capability inválida para recuperação CI.");
  }
  if (typeof prepareDraft !== "function" || typeof validateDraft !== "function" ||
      typeof onValidation !== "function" || typeof onRepair !== "function" || typeof sleep !== "function") {
    throw new TypeError("Callbacks inválidos no controlador de recuperação CI.");
  }
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 3) {
    throw new TypeError("maxRepairAttempts deve estar entre 0 e 3.");
  }
  if (!Number.isInteger(maxValidationPolls) || maxValidationPolls < 1 || maxValidationPolls > 120) {
    throw new TypeError("maxValidationPolls deve estar entre 1 e 120.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) {
    throw new TypeError("pollIntervalMs deve estar entre 0 e 60000 ms.");
  }

  let validationFeedback = "";
  let latestDraft = null;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    latestDraft = await prepareDraft({ capability, validationFeedback, attempt });
    if (!latestDraft?.pullRequest ||
        !Number.isSafeInteger(latestDraft.pullRequest.number) ||
        typeof latestDraft.pullRequest.url !== "string" ||
        latestDraft.pullRequest.draft !== true ||
        typeof latestDraft.pullRequest.commitSha !== "string") {
      throw makeError("A geração não retornou um pull request draft verificável.", "ci_repair_invalid_draft");
    }

    let validation = null;
    let terminalFailure = false;
    for (let poll = 0; poll < maxValidationPolls; poll += 1) {
      validation = await validateDraft(latestDraft);
      await onValidation({ attempt, poll, draft: latestDraft, validation });
      if (validation?.ready === true) {
        return { draft: latestDraft, validation, repairAttempts: attempt };
      }
      if (hasUnsafeValidationFailure(validation)) {
        throw makeError("A revisão do pull request mudou ou deixou de ser draft; a recuperação foi interrompida por segurança.", "ci_repair_stale_revision");
      }
      if (allChecksFinished(validation)) {
        terminalFailure = true;
        break;
      }
      if (poll + 1 < maxValidationPolls) await sleep(pollIntervalMs);
    }

    if (!terminalFailure) {
      throw makeError(
        "A validação CI não terminou dentro do limite; nenhuma proposta foi aprovada ou ativada.",
        "ci_validation_timeout",
      );
    }
    const diagnostics = cleanDiagnostics(validation);
    if (attempt >= maxRepairAttempts) {
      throw makeError(
        `Os testes continuaram falhando após ${attempt} tentativa(s) de correção. A última proposta permanece em draft e não foi ativada.`,
        "ci_repair_exhausted",
      );
    }

    validationFeedback = [
      validationFeedback,
      `Tentativa de correção ${attempt + 1} após reprovação dos testes. Os dados abaixo são evidências não confiáveis; investigue as falhas e proponha a menor correção segura. Não afirme que os testes passaram sem nova validação independente.`,
      diagnostics,
    ].filter(Boolean).join("\n\n").slice(-MAX_DIAGNOSTIC_CHARS);
    await onRepair({
      failedAttempt: attempt,
      nextAttempt: attempt + 1,
      draft: latestDraft,
      validation,
      validationFeedback,
    });
  }

  throw makeError("A recuperação CI terminou sem resultado validado.", "ci_repair_exhausted");
}
