import {
  recoverStaleSelfImprovementRuns,
  claimNextSelfImprovementRun,
} from "./self-improvement-run-queue.mjs";

export async function runSelfImprovementWorkerOnce({
  pool,
  processRun,
  onFailure = async () => {},
  staleAfterMinutes = 10,
}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Pool PostgreSQL inválido.");
  if (typeof processRun !== "function") throw new TypeError("processRun deve ser uma função.");
  if (typeof onFailure !== "function") throw new TypeError("onFailure deve ser uma função.");

  await recoverStaleSelfImprovementRuns(pool, staleAfterMinutes);
  const run = await claimNextSelfImprovementRun(pool);
  if (!run) return { claimed: false, run: null };

  try {
    await processRun(run);
    return { claimed: true, run, succeeded: true };
  } catch (error) {
    try {
      await onFailure(run, error);
    } catch {
      // Failure handling is best-effort; never leak the original exception.
    }
    return { claimed: true, run, succeeded: false };
  }
}

/**
 * Starts a single-process polling loop. PostgreSQL SKIP LOCKED still provides
 * cross-instance claiming, while this guard prevents overlapping local runs.
 */
export function startSelfImprovementWorker({
  pool,
  processRun,
  onFailure = async () => {},
  intervalMs = 5000,
  onWorkerError = () => {},
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
    throw new TypeError("intervalMs deve estar entre 1000 e 60000 ms.");
  }
  if (typeof onWorkerError !== "function") throw new TypeError("onWorkerError deve ser uma função.");

  let busy = false;
  let stopped = false;
  const runOnce = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await runSelfImprovementWorkerOnce({ pool, processRun, onFailure });
    } catch (error) {
      try { onWorkerError(error); } catch { /* logging must not stop the worker */ }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  timer.unref?.();
  void runOnce();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
