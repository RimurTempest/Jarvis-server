"use strict";
const cp = require("node:child_process");

/**
 * A process primitive for supervised workers. Cancellation only stops the local
 * process group: containers owned by a daemon REQUIRE an independent cleanup
 * callback and verification. This module does not enable any worker or Docker.
 */
function runCancellable(command, args, {
  cwd, env, signal, timeoutMs = 120_000, maxOutputBytes = 100_000,
  killGraceMs = 250, cleanupOnCancel
} = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args) ||
      args.some(x => typeof x !== "string") ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_000_000 ||
      !Number.isInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 10_000 ||
      (cleanupOnCancel !== undefined && typeof cleanupOnCancel !== "function")) {
    throw new TypeError("Configuração do subprocesso inválida.");
  }
  if (signal?.aborted) return Promise.resolve({status:null, signal:null, stdout:"", stderr:"", cancelled:true, reason:"cancelled"});
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { reject(error); return; }
    let reason = null, processError = null, stdout = [], stderr = [], outputBytes = 0;
    let timeout, escalation;
    function killGroup(sig) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (e) { if (e.code !== "ESRCH") processError ||= e; }
    }
    function stop(why) {
      if (reason) return;
      reason = why;
      killGroup("SIGTERM");
      escalation = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    }
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, {once:true});
    if (signal?.aborted) onAbort();
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    function collect(list, chunk) {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { stop("output_limit"); return; }
      list.push(chunk);
    }
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("error", error => { processError ||= error; });
    child.on("close", async (status, childSignal) => {
      clearTimeout(timeout);
      if (reason) killGroup("SIGKILL");
      clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      if (reason && cleanupOnCancel) {
        let cleanupTimer;
        try {
          await Promise.race([
            Promise.resolve().then(() => cleanupOnCancel()),
            new Promise((_, rejectCleanup) => { cleanupTimer = setTimeout(() => rejectCleanup(new Error("Limpeza excedeu o prazo.")), 10_000); })
          ]);
        } catch { reject(new Error("Limpeza do subprocesso não comprovada.")); return; }
        finally { clearTimeout(cleanupTimer); }
      }
      if (processError && !reason) { reject(processError); return; }
      if (processError && reason) { reject(new Error("Cancelamento do subprocesso não comprovado.")); return; }
      resolve({status, signal:childSignal, stdout:Buffer.concat(stdout).toString("utf8"),
        stderr:Buffer.concat(stderr).toString("utf8"), cancelled:!!reason, reason});
    });
  });
}
module.exports = { runCancellable };
