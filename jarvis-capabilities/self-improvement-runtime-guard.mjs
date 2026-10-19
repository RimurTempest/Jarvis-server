const API_ROOT = "https://api.github.com";

function validSha(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") &&
    !value.includes("\\") && /^[A-Za-z0-9._/-]+$/.test(value);
}

function encodedBranch(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function safeHealthUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveRuntimeHealthUrl(env = process.env) {
  try {
    const configured = typeof env.JARVIS_RUNTIME_HEALTHCHECK_URL === "string" && env.JARVIS_RUNTIME_HEALTHCHECK_URL.trim()
      ? env.JARVIS_RUNTIME_HEALTHCHECK_URL.trim()
      : typeof env.RENDER_EXTERNAL_URL === "string" && env.RENDER_EXTERNAL_URL.trim()
        ? new URL("/health", env.RENDER_EXTERNAL_URL.trim()).toString()
        : "";
    return safeHealthUrl(configured);
  } catch {
    return null;
  }
}

export async function verifyRuntimeRevision({
  healthUrl,
  expectedRevision,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls = 36,
  intervalMs = 10000,
}) {
  const url = safeHealthUrl(healthUrl);
  if (!url || !validSha(expectedRevision)) return { verified: false, reason: "invalid_health_target" };
  if (typeof fetchImpl !== "function" || typeof sleep !== "function" ||
      !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 60 ||
      !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) {
    throw new TypeError("Configuração inválida para verificação de runtime.");
  }

  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
      let health = null;
      try { health = await response.json(); } catch { health = null; }
      if (response.ok && health?.status === "ok" &&
          health?.database === "connected" &&
          Number(health?.aiProviders) > 0 &&
          typeof health?.revision === "string" &&
          health.revision.toLowerCase() === expectedRevision.toLowerCase()) {
        return { verified: true, attempts: attempt, revision: health.revision };
      }
    } catch {
      // During a deployment the health endpoint may temporarily be unreachable.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxPolls) await sleep(intervalMs);
  }
  return { verified: false, reason: "runtime_revision_not_healthy" };
}

async function githubRequest(fetchImpl, token, path, method = "GET", body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    const response = await fetchImpl(API_ROOT + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error("GitHub rollback request failed with HTTP " + response.status + ".");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reverts only when the target branch still points at the exact merge commit.
 * The revert commit restores the first parent's tree but keeps the merge in
 * history. It never force-pushes or overwrites a newer branch revision.
 */
export async function revertMergedCommitSafely({
  token,
  repository,
  baseBranch,
  mergeCommitSha,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20 ||
      !validRepository(repository) || !validBranch(baseBranch) || !validSha(mergeCommitSha) ||
      typeof fetchImpl !== "function") {
    return { rolledBack: false, reason: "invalid_rollback_configuration" };
  }

  const repoPath = "/repos/" + repository;
  const refPath = repoPath + "/git/ref/heads/" + encodedBranch(baseBranch);
  const ref = await githubRequest(fetchImpl, token, refPath);
  if (ref?.object?.sha?.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    return { rolledBack: false, reason: "branch_advanced" };
  }

  const mergeCommit = await githubRequest(fetchImpl, token, repoPath + "/git/commits/" + mergeCommitSha);
  const parentSha = mergeCommit?.parents?.[0]?.sha;
  if (!validSha(parentSha)) return { rolledBack: false, reason: "merge_parent_unavailable" };
  const parentCommit = await githubRequest(fetchImpl, token, repoPath + "/git/commits/" + parentSha);
  const parentTreeSha = parentCommit?.tree?.sha;
  if (!validSha(parentTreeSha)) return { rolledBack: false, reason: "parent_tree_unavailable" };

  const revertCommit = await githubRequest(fetchImpl, token, repoPath + "/git/commits", "POST", {
    message: "Revert J.A.R.V.I.S. auto-merge after runtime health check failure",
    tree: parentTreeSha,
    parents: [mergeCommitSha],
  });
  if (!validSha(revertCommit?.sha)) throw new Error("GitHub did not return a valid rollback commit.");

  const latestRef = await githubRequest(fetchImpl, token, refPath);
  if (latestRef?.object?.sha?.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    return { rolledBack: false, reason: "branch_advanced", revertCommitSha: revertCommit.sha };
  }
  await githubRequest(fetchImpl, token, refPath, "PATCH", { sha: revertCommit.sha, force: false });
  return { rolledBack: true, revertCommitSha: revertCommit.sha, revertedCommitSha: mergeCommitSha };
}
