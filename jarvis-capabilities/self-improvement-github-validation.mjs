const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
export const REQUIRED_SELF_IMPROVEMENT_WORKFLOWS = Object.freeze([
  "JARVIS Capability Tests",
  "JARVIS Android Enrollment Tests",
  "JARVIS Update Safety Tests",
]);

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validSha(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

async function githubRequest(fetchImpl, token, path) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(`GitHub API falhou ao verificar a validação (HTTP ${response.status}).`);
  return payload;
}

/**
 * Checks only independent GitHub Actions results for the exact proposal commit.
 * A green result means backend PR checks are green; it does not authorize merge,
 * production deployment, APK packaging, or Android installation.
 */
export async function inspectDraftPullRequestValidation({
  token,
  repository,
  pullRequestNumber,
  expectedHeadSha,
  requiredWorkflows = REQUIRED_SELF_IMPROVEMENT_WORKFLOWS,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20) throw new TypeError("Token do GitHub ausente ou inválido.");
  if (!validRepository(repository)) throw new TypeError("repository deve usar o formato owner/repository.");
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new TypeError("pullRequestNumber inválido.");
  if (!validSha(expectedHeadSha)) throw new TypeError("expectedHeadSha deve ser um SHA completo.");
  if (!Array.isArray(requiredWorkflows) || requiredWorkflows.length < 1 ||
      requiredWorkflows.some((name) => typeof name !== "string" || !name.trim() || name.length > 120)) {
    throw new TypeError("requiredWorkflows inválido.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl deve ser uma função.");

  const pr = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullRequestNumber}`);
  const reasons = [];
  if (pr?.state !== "open") reasons.push("O pull request não está aberto.");
  if (pr?.draft !== true) reasons.push("O pull request não está em estado draft.");
  const actualHeadSha = pr?.head?.sha;
  if (!validSha(actualHeadSha) || actualHeadSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    reasons.push("O SHA atual do pull request não corresponde à revisão exata da proposta.");
    return {
      ready: false,
      reasons,
      pullRequest: {
        number: pullRequestNumber,
        url: typeof pr?.html_url === "string" ? pr.html_url : null,
        state: pr?.state ?? "unknown",
        draft: pr?.draft === true,
        headSha: validSha(actualHeadSha) ? actualHeadSha : null,
      },
      checks: [],
    };
  }

  const query = new URLSearchParams({ head_sha: expectedHeadSha, per_page: "100" }).toString();
  const actions = await githubRequest(fetchImpl, token, `/repos/${repository}/actions/runs?${query}`);
  if (!Array.isArray(actions?.workflow_runs) || actions.workflow_runs.length < 1) {
    reasons.push("Nenhuma execução de GitHub Actions foi encontrada para a revisão.");
  }

  if (Number.isInteger(actions?.total_count) && actions.total_count > (actions.workflow_runs || []).length) {
    reasons.push("A lista de execuções do GitHub está incompleta; validação recusada.");
  }

  const relevantRuns = (actions?.workflow_runs || []).filter((run) =>
    run?.head_sha?.toLowerCase() === expectedHeadSha.toLowerCase() &&
    run?.event === "pull_request" &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.some((item) => item?.number === pullRequestNumber)
  );

  const checks = requiredWorkflows.map((name) => {
    const matches = relevantRuns.filter((run) => run.name === name)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const latest = matches[0];
    if (!latest) {
      reasons.push(`Falta uma execução de "${name}" para esta revisão.`);
      return { name, status: "missing", conclusion: null, runUrl: null, runId: null };
    }
    const status = typeof latest.status === "string" ? latest.status : "unknown";
    const conclusion = typeof latest.conclusion === "string" ? latest.conclusion : null;
    if (status !== "completed" || conclusion !== "success") {
      reasons.push(`"${name}" não passou: status=${status}, conclusão=${conclusion || "pendente"}.`);
    }
    return {
      name,
      status,
      conclusion,
      runUrl: typeof latest.html_url === "string" ? latest.html_url : null,
      runId: Number.isSafeInteger(latest.id) ? latest.id : null,
      headSha: latest.head_sha,
    };
  });

  const requiredNames = new Set(requiredWorkflows);
  const extraNames = [...new Set(relevantRuns.map((run) => run.name).filter((name) => typeof name === "string" && !requiredNames.has(name)))];
  const extraChecks = [];
  for (const name of extraNames) {
    const latest = relevantRuns.filter((run) => run.name === name)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    const extra = {
      name,
      status: typeof latest?.status === "string" ? latest.status : "missing",
      conclusion: typeof latest?.conclusion === "string" ? latest.conclusion : null,
      runUrl: typeof latest?.html_url === "string" ? latest.html_url : null,
      runId: Number.isSafeInteger(latest?.id) ? latest.id : null,
    };
    extraChecks.push(extra);
    if (!latest || latest.status !== "completed" || !["success", "skipped"].includes(latest.conclusion)) {
      reasons.push(`O workflow adicional "${name}" não terminou com sucesso.`);
    }
  }

  return {
    ready: reasons.length === 0 && checks.length === requiredWorkflows.length,
    reasons,
    checks,
    extraChecks,
    pullRequest: {
      number: pullRequestNumber,
      url: typeof pr?.html_url === "string" ? pr.html_url : null,
      state: pr.state,
      draft: pr.draft === true,
      headSha: actualHeadSha,
    },
    checks,
  };
}
