import { randomUUID } from "node:crypto";
import { enqueueAndroidAction } from "./postgres-action-queue.mjs";

const ACTIONS = Object.freeze({
  "android.open_app": (parameters) => ({ type: "open_app", packageName: parameters.packageName }),
  "android.open_url": (parameters) => ({ type: "open_url", url: parameters.url }),
  "android.dial_number": (parameters) => ({ type: "dial_number", phoneNumber: parameters.phoneNumber }),
  "android.open_settings": (parameters) => ({ type: "open_settings", setting: parameters.setting }),
  "android.copy_text": (parameters) => ({ type: "copy_text", text: parameters.text }),
});

function safePublicBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAction(pool, id, { timeoutMs = 100_000, pollMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT state, result, requires_user_confirmation FROM jarvis_action_queue WHERE id = $1",
      [id],
    );
    if (!result.rowCount) return { state: "missing", result: null, requiresUserConfirmation: false };
    const row = result.rows[0];
    if (["completed", "failed", "expired"].includes(row.state)) {
      return {
        state: row.state,
        result: row.result,
        requiresUserConfirmation: row.requires_user_confirmation === true,
      };
    }
    await delay(pollMs);
  }
  return { state: "timeout", result: null, requiresUserConfirmation: false };
}

/**
 * Only maps named, protocol-validated Android actions to the existing device queue.
 * No shell, arbitrary intent, generated code, or dynamic action name is accepted.
 */
export function createAndroidUniversalAdapterRegistry({ pool, publicBaseUrl, enqueueAction = enqueueAndroidAction, waitAction = waitForAction }) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Pool PostgreSQL inválido.");
  const baseUrl = safePublicBaseUrl(publicBaseUrl);
  if (!baseUrl) throw new TypeError("Uma URL pública HTTPS é necessária para registrar evidências.");
  const registry = new Map();

  for (const [kind, buildAction] of Object.entries(ACTIONS)) {
    registry.set(kind, {
      target: "android",
      execute: async ({ task, step, context = {} }) => {
        if (!step.parameters || typeof step.parameters !== "object" || Array.isArray(step.parameters)) {
          return { status: "failed", summary: "A etapa Android não possui parâmetros estruturados." };
        }
        const actionId = randomUUID();
        const capabilityId = task.capability_id || task.capabilityId || task.id;
        const queued = await enqueueAction(pool, {
          id: actionId,
          capabilityId,
          action: buildAction(step.parameters),
        });
        if (!context.androidActionIds || typeof context.androidActionIds.set !== "function") {
          context.androidActionIds = new Map();
        }
        context.androidActionIds.set(step, queued.id);
        const outcome = await waitAction(pool, queued.id);
        if (outcome.state !== "completed" || outcome.result?.ok !== true ||
            (outcome.requiresUserConfirmation && outcome.result?.userConfirmed !== true)) {
          return {
            status: "failed",
            summary: outcome.state === "timeout"
              ? "O dispositivo não confirmou a ação dentro do prazo."
              : "O dispositivo não confirmou a conclusão da ação.",
          };
        }
        return {
          status: "succeeded",
          summary: typeof outcome.result.message === "string" && outcome.result.message.trim()
            ? outcome.result.message.trim().slice(0, 1000)
            : "O dispositivo confirmou a conclusão da ação.",
          evidence: new URL("/api/tasks/" + encodeURIComponent(task.id), baseUrl).toString(),
        };
      },
      verify: async ({ task, step, context = {} }) => {
        const actionId = context.androidActionIds?.get?.(step);
        if (typeof actionId !== "string") {
          return { status: "unverified", summary: "Não foi possível localizar a ação entregue ao dispositivo." };
        }
        const result = await pool.query(
          "SELECT state, result, requires_user_confirmation FROM jarvis_action_queue WHERE id = $1",
          [actionId],
        );
        const row = result.rows[0];
        if (!row || row.state !== "completed" || row.result?.ok !== true ||
            (row.requires_user_confirmation && row.result?.userConfirmed !== true)) {
          return { status: "unverified", summary: "O resultado persistido do dispositivo não confirma a ação." };
        }
        return {
          status: "succeeded",
          summary: "Resultado conferido na fila persistente de ações Android.",
          evidence: new URL("/api/tasks/" + encodeURIComponent(task.id), baseUrl).toString(),
        };
      },
    });
  }
  return registry;
}
