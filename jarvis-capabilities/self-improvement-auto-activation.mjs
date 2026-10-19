const API_ROOT = "https://api.github.com";

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validSha(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function autoActivationPathAllowed(path) {
  if (typeof path !== "string" || !path.startsWith("jarvis-capabilities/")) return false;
  if (path.includes("..") || path.includes("\\") || path.startsWith("/")) return false;
  if (/(^|\/)(?:\.github|node_modules|secrets?|credentials?)(\/|$)/i.test(path)) return false;
  if (/(?:auth|route|registry|queue|protocol|evidence|validation|postgres|enrollment|android|update|release|install|deploy|security|self-improvement|proposal|publisher|policy)/i.test(path)) return false;
  return /\.(?:mjs|js|md|json)$/i.test(path);
}

async function request(fetchImpl, token, path, method = "GET", body) {
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
    if (!response.ok) throw new Error("GitHub API activation request failed with HTTP " + response.status + ".");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Auto-merges only a low-risk, policy-approved proposal after independent CI
 * has passed on the exact commit. Protected paths and ambiguous/stale PRs stay
 * draft-only. The caller must keep this feature disabled until deployment
 * permissions and rollback/health monitoring have been configured.
 */
export async function mergeValidatedSelfImprovementDraft({
  enabled = false,
  token,
  repository,
  pullRequestNumber,
  baseBranch,
  expectedHeadSha,
  validation,
  requiresHumanReview,
  changedPaths,
  fetchImpl = fetch,
}) {
  if (enabled !== true) return { merged: false, reason: "auto_activation_disabled" };
  if (typeof token !== "string" || token.trim().length < 20) return { merged: false, reason: "token_unavailable" };
  if (!validRepository(repository)) return { merged: false, reason: "invalid_repository" };
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) return { merged: false, reason: "invalid_pull_request" };
  if (typeof baseBranch !== "string" || !baseBranch.trim() || !validSha(expectedHeadSha)) return { merged: false, reason: "invalid_revision" };
  if (validation?.ready !== true) return { merged: false, reason: "ci_not_passed" };
  if (requiresHumanReview !== false) return { merged: false, reason: "human_review_required" };
  if (!Array.isArray(changedPaths) || changedPaths.length < 1 || changedPaths.length > 30 ||
      !changedPaths.every(autoActivationPathAllowed)) {
    return { merged: false, reason: "protected_paths" };
  }
  if (typeof fetchImpl !== "function") return { merged: false, reason: "invalid_fetch" };

  const repoPath = "/repos/" + repository;
  const pullRequest = await request(fetchImpl, token, repoPath + "/pulls/" + pullRequestNumber);
  if (pullRequest?.state !== "open" || pullRequest?.draft !== true ||
      pullRequest?.base?.ref !== baseBranch ||
      pullRequest?.head?.sha?.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    return { merged: false, reason: "stale_or_non_draft_pr" };
  }

  await request(fetchImpl, token, repoPath + "/pulls/" + pullRequestNumber + "/ready_for_review", "POST", {});
  try {
    const merged = await request(fetchImpl, token, repoPath + "/pulls/" + pullRequestNumber + "/merge", "PUT", {
      sha: expectedHeadSha,
      merge_method: "squash",
    });
    if (merged?.merged !== true || !validSha(merged?.sha)) {
      throw new Error("GitHub did not confirm the merge.");
    }
    return { merged: true, mergeCommitSha: merged.sha, pullRequestNumber };
  } catch (error) {
    try {
      await request(fetchImpl, token, repoPath + "/pulls/" + pullRequestNumber + "/convert_to_draft", "POST", {});
    } catch {
      // Preserve the original activation failure; never report a successful merge.
    }
    throw error;
  }
}
