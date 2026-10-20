const TASK_STATES = Object.freeze([
  "received", "understanding", "researching", "planning", "implementing",
  "testing", "awaiting_approval", "ready", "executing", "verifying",
  "completed", "blocked", "failed",
]);
const TERMINAL_STATES = new Set(["completed", "blocked", "failed"]);
const RISK_LEVELS = new Set(["low", "moderate", "high", "critical"]);
const TARGETS = new Set(["server", "android", "external_service", "local_device", "unknown"]);
const EXECUTABLE_TARGETS = new Set(["server", "android", "external_service", "local_device"]);
const EXECUTION_STATES = new Set(["succeeded", "failed", "unverified", "needs_user_action"]);
const SECRET_PATTERN = /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|senha|secret)\s*[:=]\s*[^\s,;]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[a-z0-9._-]{12,}/i;

function requiredText(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(field + " inválido.");
  const result = value.trim();
  if (SECRET_PATTERN.test(result)) throw new TypeError(field + " parece conter credenciais; conteúdo recusado.");
  return result;
}

function isSafeEvidenceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function createUniversalTaskRequest({ id, originalRequest, goal, createdAt = new Date().toISOString() }) {
  const safeId = requiredText(id, "id", 100);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(safeId)) throw new TypeError("id contém caracteres não permitidos.");
  const original = requiredText(originalRequest, "originalRequest", 8000);
  const normalizedGoal = requiredText(goal, "goal", 4000);
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError("createdAt inválido.");
  return Object.freeze({
    id: safeId, originalRequest: original, goal: normalizedGoal, state: "received",
    target: "unknown", riskLevel: "moderate", requiresConfirmation: true,
    plan: null, research: [], execution: null, verification: null,
    createdAt: date.toISOString(), updatedAt: date.toISOString(),
  });
}

export function createUniversalTaskPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Plano inválido.");
  const target = input.target;
  const riskLevel = input.riskLevel;
  if (!TARGETS.has(target)) throw new TypeError("target inválido.");
  if (!RISK_LEVELS.has(riskLevel)) throw new TypeError("riskLevel inválido.");
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 30) throw new TypeError("steps deve conter de 1 a 30 etapas.");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length < 1 || input.acceptanceCriteria.length > 20) throw new TypeError("acceptanceCriteria deve conter de 1 a 20 critérios.");
  if (!Array.isArray(input.requiredPermissions) || input.requiredPermissions.length > 20) throw new TypeError("requiredPermissions inválido.");
  const steps = input.steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new TypeError("Etapa " + index + " inválida.");
    const kind = requiredText(step.kind, "steps[" + index + "].kind", 80);
    if (!/^[a-z][a-z0-9_.-]*$/.test(kind)) throw new TypeError("Tipo de etapa não permitido.");
    return { kind, description: requiredText(step.description, "steps[" + index + "].description", 500), reversible: step.reversible === true };
  });
  const acceptanceCriteria = input.acceptanceCriteria.map((item, index) => requiredText(item, "acceptanceCriteria[" + index + "]", 500));
  const requiredPermissions = [...new Set(input.requiredPermissions.map((item, index) => requiredText(item, "requiredPermissions[" + index + "]", 200)))];
  const riskRequiresConfirmation = riskLevel !== "low" || input.irreversible === true || requiredPermissions.length > 0;
  return Object.freeze({
    goal: requiredText(input.goal, "goal", 4000), target, riskLevel,
    requiresConfirmation: input.requiresConfirmation === true || riskRequiresConfirmation,
    irreversible: input.irreversible === true, requiredPermissions, steps, acceptanceCriteria,
    rollbackPlan: requiredText(input.rollbackPlan, "rollbackPlan", 2000),
  });
}

export function canExecuteUniversalTask({ task, plan, adapterRegistry, authorization = {} }) {
  if (!task || task.state === "completed" || TERMINAL_STATES.has(task.state)) return { allowed: false, reason: "task_not_executable" };
  if (!plan || !TARGETS.has(plan.target)) return { allowed: false, reason: "plan_missing_or_invalid" };
  if (!EXECUTABLE_TARGETS.has(plan.target)) return { allowed: false, reason: "target_not_resolved" };
  if (!adapterRegistry || typeof adapterRegistry.get !== "function") return { allowed: false, reason: "executor_registry_missing" };
  const availableKinds = new Set(plan.steps.map((step) => step.kind));
  for (const kind of availableKinds) {
    const adapter = adapterRegistry.get(kind);
    if (!adapter || typeof adapter.execute !== "function" || typeof adapter.verify !== "function") {
      return { allowed: false, reason: "executor_unavailable", missingExecutor: kind };
    }
  }
  if (plan.requiresConfirmation && authorization.confirmed !== true) return { allowed: false, reason: "explicit_confirmation_required" };
  if (plan.requiredPermissions.some((permission) => !Array.isArray(authorization.grantedPermissions) || !authorization.grantedPermissions.includes(permission))) {
    return { allowed: false, reason: "required_permission_missing" };
  }
  if ((plan.riskLevel === "high" || plan.riskLevel === "critical") && authorization.securityReviewPassed !== true) {
    return { allowed: false, reason: "security_review_required" };
  }
  return { allowed: true, reason: "ready" };
}

function validateExecutionResult(result, stage) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError(stage + " deve retornar um objeto estruturado.");
  if (!EXECUTION_STATES.has(result.status)) throw new TypeError(stage + ".status inválido.");
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 1000) throw new TypeError(stage + ".summary inválido.");
  if (result.status === "succeeded" && !isSafeEvidenceUrl(result.evidence)) {
    throw new Error(stage + " não pode declarar sucesso sem uma URL HTTPS válida e sem credenciais embutidas.");
  }
  return { status: result.status, summary: result.summary.trim(), evidence: result.status === "succeeded" ? result.evidence : null };
}

/**
 * Executes only named, pre-registered adapters. Research, plans, generated code,
 * and model-written summaries are never treated as proof that an action happened.
 * The caller must persist each result and supply trusted authorization state.
 */
export async function executeUniversalTask({ task, plan, adapterRegistry, authorization = {}, context = {} }) {
  const permission = canExecuteUniversalTask({ task, plan, adapterRegistry, authorization });
  if (!permission.allowed) return { status: "needs_user_action", reason: permission.reason, taskId: task?.id ?? null };
  const results = [];
  for (const step of plan.steps) {
    const adapter = adapterRegistry.get(step.kind);
    let execution;
    try {
      execution = validateExecutionResult(await adapter.execute({ task, plan, step, context }), "executor");
    } catch {
      return { status: "failed", reason: "executor_error", summary: "A etapa não foi concluída com segurança.", completedSteps: results, failedStep: step.kind };
    }
    results.push({ step: step.kind, ...execution });
    if (execution.status !== "succeeded") {
      return { status: execution.status, reason: "step_not_succeeded", summary: execution.summary, completedSteps: results, failedStep: step.kind };
    }
    let verification;
    try {
      verification = validateExecutionResult(await adapter.verify({ task, plan, step, execution, context }), "verifier");
    } catch {
      return { status: "unverified", reason: "verification_failed", summary: "A execução pode ter ocorrido, mas não foi possível verificar o resultado.", completedSteps: results, failedStep: step.kind };
    }
    if (verification.status !== "succeeded") {
      return { status: "unverified", reason: "verification_not_succeeded", summary: verification.summary, completedSteps: results, failedStep: step.kind };
    }
    results[results.length - 1].verification = verification;
  }
  return { status: "succeeded", reason: "all_steps_verified", taskId: task.id, summary: "Todas as etapas foram executadas e verificadas.", completedSteps: results };
}

export const UNIVERSAL_TASK_STATES = TASK_STATES;
export const UNIVERSAL_TASK_TERMINAL_STATES = Object.freeze([...TERMINAL_STATES]);
