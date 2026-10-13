const UPDATE_TYPES = new Set(["capability", "bugfix", "security", "performance", "interface"]);
const APPROVAL_STATES = new Set(["pending", "approved", "rejected"]);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Validates the display-safe release information before it can be shown for approval.
 * This does not prove the APK is safe, verify its signature, or install anything.
 */
export function validateUpdateProposal(proposal) {
  const errors = [];
  const add = (message) => errors.push(message);

  if (!isPlainObject(proposal)) {
    return { ok: false, errors: ["A proposta de atualização precisa ser um objeto."], approvalAllowed: false };
  }

  const id = cleanText(proposal.id, 100);
  const currentVersion = cleanText(proposal.currentVersion, 40);
  const targetVersion = cleanText(proposal.targetVersion, 40);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) add("ID da atualização ausente ou inválido.");
  if (!VERSION_RE.test(currentVersion)) add("Versão atual inválida.");
  if (!VERSION_RE.test(targetVersion)) add("Versão nova inválida.");
  if (currentVersion && targetVersion && currentVersion === targetVersion) add("A versão nova deve ser diferente da versão atual.");

  if (typeof proposal.releaseNotes !== "string" || !cleanText(proposal.releaseNotes, 2000)) {
    add("Resumo da atualização ausente.");
  } else if (proposal.releaseNotes.length > 2000) {
    add("Resumo da atualização excede 2000 caracteres.");
  }

  if (!Array.isArray(proposal.changes) || proposal.changes.length < 1 || proposal.changes.length > 50) {
    add("A lista de alterações precisa conter de 1 a 50 itens.");
  } else {
    const seen = new Set();
    for (const change of proposal.changes) {
      if (!isPlainObject(change)) {
        add("Existe uma alteração em formato inválido.");
        continue;
      }
      const changeId = cleanText(change.id, 100);
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(changeId)) add("Uma alteração não tem ID válido.");
      if (seen.has(changeId)) add(`ID de alteração duplicado: ${changeId}.`);
      seen.add(changeId);
      if (!UPDATE_TYPES.has(change.type)) add(`Tipo de alteração inválido: ${changeId || "(sem ID)"}.`);
      if (!cleanText(change.title, 120)) add(`Título ausente: ${changeId || "(sem ID)"}.`);
      if (!cleanText(change.description, 600)) add(`Descrição ausente: ${changeId || "(sem ID)"}.`);
      if (change.requiresPermission !== undefined && typeof change.requiresPermission !== "boolean") {
        add(`requiresPermission precisa ser booleano: ${changeId || "(sem ID)"}.`);
      }
      if (change.requiresPermission === true && !cleanText(change.permissionReason, 300)) {
        add(`Explique a permissão necessária: ${changeId || "(sem ID)"}.`);
      }
    }
  }

  if (!isHttpsUrl(proposal.packageUrl)) add("O pacote deve usar uma URL HTTPS válida.");
  if (typeof proposal.packageSha256 !== "string" || !SHA256_RE.test(proposal.packageSha256)) {
    add("Hash SHA-256 do pacote ausente ou inválido.");
  }
  if (proposal.approvalState !== undefined && !APPROVAL_STATES.has(proposal.approvalState)) {
    add("Estado de aprovação inválido.");
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    updateId: id || null,
    currentVersion: currentVersion || null,
    targetVersion: targetVersion || null,
    approvalAllowed: ok && (proposal.approvalState ?? "pending") === "pending",
  };
}

/** Only an explicit owner decision can authorize progression to installation. */
export function decideUpdateApproval(proposal, decision, actor = "owner") {
  const validation = validateUpdateProposal(proposal);
  if (!validation.ok) {
    return { ok: false, approvalState: "pending", installAuthorized: false, errors: validation.errors };
  }
  if (actor !== "owner") {
    return { ok: false, approvalState: "pending", installAuthorized: false, errors: ["Somente o responsável pode decidir sobre a atualização."] };
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, approvalState: "pending", installAuthorized: false, errors: ["A decisão precisa ser approved ou rejected."] };
  }
  return {
    ok: true,
    updateId: validation.updateId,
    approvalState: decision,
    installAuthorized: decision === "approved",
    note: decision === "approved"
      ? "A aprovação do responsável foi registrada; verificações de assinatura, integridade, compatibilidade e instalação ainda são obrigatórias."
      : "Atualização recusada; a versão atual deve ser mantida.",
  };
}
