"use strict";

const { taskId } = require("./dev-workspace.cjs");

function createPhase11Api({
  baseUrl = process.env.JARVIS_EVOLUTION_BASE_URL,
  token = process.env.JARVIS_EVOLUTION_RUNNER_TOKEN,
  fetchImpl = globalThis.fetch,
  allowLocalHttp = false
} = {}) {
  let origin;
  try { origin = new URL(baseUrl); }
  catch { throw new Error("URL do servidor de evolução inválida."); }
  if (origin.protocol !== "https:" &&
      !(allowLocalHttp && origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
    throw new Error("A API exige HTTPS; HTTP é permitido somente em localhost durante testes.");
  }
  if (origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== "/") {
    throw new Error("Configure apenas a origem do servidor, sem caminho ou credenciais.");
  }
  if (typeof token !== "string" || token.length < 32 ||
      typeof fetchImpl !== "function") {
    throw new Error("Credencial exclusiva do worker ou transporte HTTPS indisponível.");
  }
  async function send(suffix, body = {}) {
    const destination = new URL(`/api/evolution/runner/${suffix}`, origin);
    const response = await fetchImpl(destination.href, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response || response.status < 200 || response.status >= 300) {
      const status = Number(response?.status);
      throw new Error(`Operação rejeitada pelo servidor de evolução (HTTP ${status || 0}).`);
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType && !/application\/json/i.test(contentType)) {
      throw new Error("Resposta do servidor não é JSON.");
    }
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Resposta inválida do servidor.");
    }
    return result;
  }
  function verifyPermissions(result) {
    if (!result.permissions || result.permissions.publish !== false ||
        result.permissions.install !== false ||
        result.permissions.deploy !== false) {
      throw new Error("Servidor não comprovou as restrições do executor.");
    }
  }
  async function claim() {
    const result = await send("claim");
    verifyPermissions(result);
    const item = result.task;
    if (item === null) return null;
    if (!item || typeof item !== "object" ||
        taskId(item.id) !== item.id ||
        typeof item.request !== "string" || !item.request.trim() ||
        item.request.length > 4000 ||
        typeof item.leaseToken !== "string" ||
        !/^[A-Za-z0-9_-]{40,100}$/.test(item.leaseToken) ||
        !Number.isInteger(item.attempt) || item.attempt < 1 || item.attempt > 3) {
      throw new Error("Servidor apresentou uma tarefa inválida.");
    }
    return {
      id: item.id, request: item.request, leaseToken: item.leaseToken,
      attempt: item.attempt
    };
  }
  async function renew(id, leaseToken) {
    const result = await send(`requests/${taskId(id)}/renew`, { leaseToken });
    verifyPermissions(result);
    if (result.lease?.id !== taskId(id)) throw new Error("Renovação incompatível.");
    return result.lease;
  }
  async function report(id, leaseToken, outcome) {
    const result = await send(`requests/${taskId(id)}/report`, {leaseToken, outcome});
    if (result.task?.id !== taskId(id) ||
        result.learned !== false || result.installed !== false ||
        result.published !== false) {
      throw new Error("Resposta de relatório incompatível com a política de segurança.");
    }
    return result;
  }
  return { claim, renew, report };
}
module.exports = { createPhase11Api };
