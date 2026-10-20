const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/;

async function readGitHubEndpoint({ token, path, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(API_ROOT + path, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: controller.signal,
    });
    let payload = null;
    if (response.ok) {
      try { payload = await response.json(); } catch { payload = null; }
    }
    return { status: response.status, payload };
  } catch (error) {
    return { status: null, payload: null, failure: error?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Performs read-only checks using the server's GitHub credential.
 * Never returns the token, response bodies, headers, or provider error text.
 * This cannot prove write scopes; successful proposal publication remains the
 * only operational proof that all required write permissions are available.
 */
export async function inspectSelfImprovementGitHubAccess({
  token,
  repository,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  if (typeof token !== "string" || token.trim().length < 20) {
    return {
      checked: false,
      repositoryReadable: false,
      accountCanPush: false,
      pullRequestsReadable: false,
      workflowRunsReadable: false,
      status: "token_missing_or_invalid",
      writePermissionsVerified: false,
    };
  }
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository.trim())) {
    return {
      checked: false,
      repositoryReadable: false,
      accountCanPush: false,
      pullRequestsReadable: false,
      workflowRunsReadable: false,
      status: "repository_not_configured",
      writePermissionsVerified: false,
    };
  }
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) {
    throw new TypeError("Configuração inválida para verificação de acesso GitHub.");
  }

  const basePath = "/repos/" + repository.trim();
  const results = await Promise.all([
    readGitHubEndpoint({ token, path: basePath, fetchImpl, timeoutMs }),
    readGitHubEndpoint({ token, path: basePath + "/pulls?state=open&per_page=1", fetchImpl, timeoutMs }),
    readGitHubEndpoint({ token, path: basePath + "/actions/runs?per_page=1", fetchImpl, timeoutMs }),
  ]);
  const repoCheck = results[0];
  const pullCheck = results[1];
  const workflowCheck = results[2];

  const repositoryReadable = repoCheck.status === 200;
  const pullRequestsReadable = pullCheck.status === 200 && Array.isArray(pullCheck.payload);
  const workflowRunsReadable = workflowCheck.status === 200 && Array.isArray(workflowCheck.payload?.workflow_runs);
  const accountCanPush = repositoryReadable && repoCheck.payload?.permissions?.push === true;
  const status = results.some((item) => item.status === 401)
    ? "github_token_rejected"
    : results.some((item) => item.status === 404)
      ? "repository_or_permission_not_found"
      : results.some((item) => item.status === null)
        ? "network_or_timeout"
        : "checked";

  return {
    checked: true,
    repositoryReadable,
    accountCanPush,
    pullRequestsReadable,
    workflowRunsReadable,
    status,
    httpStatus: {
      repository: repoCheck.status ?? repoCheck.failure ?? "unknown",
      pullRequests: pullCheck.status ?? pullCheck.failure ?? "unknown",
      workflowRuns: workflowCheck.status ?? workflowCheck.failure ?? "unknown",
    },
    writePermissionsVerified: false,
    note: "Leitura e permissão de push da conta foram verificadas quando reportadas pela API. Os escopos de escrita do token e a criação de PR só são comprovados por uma publicação real de proposta.",
  };
}
