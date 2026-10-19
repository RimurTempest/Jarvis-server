import { inflateRawSync } from "node:zlib";

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

function extractZipText(buffer, maxTotalChars = 12000) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 12 * 1024 * 1024) return "";
  let eocd = -1;
  const lowerBound = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= lowerBound; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return "";
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const output = [];
  let total = 0;
  for (let index = 0; index < Math.min(entries, 100) && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.(?:txt|log)$/i.test(name) || uncompressedSize > 1_000_000 ||
        localOffset + 30 > buffer.length || total >= maxTotalChars) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) continue;
    try {
      const packed = buffer.subarray(dataStart, dataEnd);
      const raw = method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: 1_000_000 }) : null;
      if (!raw) continue;
      let text = raw.toString("utf8").replace(/\u001b\[[0-9;]*m/g, "");
      text = text.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[GITHUB_TOKEN_REDACTED]")
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[API_KEY_REDACTED]")
        .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
      text = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
      const piece = `--- ${name.slice(0, 160)} ---\n${text}`;
      const clipped = piece.slice(0, maxTotalChars - total);
      output.push(clipped);
      total += clipped.length;
    } catch {
      // Malformed or unsupported log entries are skipped, never executed.
    }
  }
  return output.join("\n").slice(0, maxTotalChars);
}

/**
 * Fetches a small, redacted text excerpt from failed GitHub Actions jobs.
 * ZIP entries are read in memory only; log contents are untrusted diagnostic
 * data and are never executed.
 */
export async function fetchSelfImprovementCiFailureDiagnostics({
  token,
  repository,
  validation,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20) throw new TypeError("Token do GitHub ausente ou inválido.");
  if (!validRepository(repository)) throw new TypeError("repository deve usar o formato owner/repository.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl deve ser uma função.");
  const failedRuns = [...(validation?.checks ?? []), ...(validation?.extraChecks ?? [])]
    .filter((check) => Number.isSafeInteger(check?.runId) && check.status === "completed" &&
      typeof check.conclusion === "string" && !["success", "skipped"].includes(check.conclusion))
    .slice(0, 5);
  const parts = [];
  for (const run of failedRuns) {
    parts.push(`Workflow ${String(run.name).slice(0, 120)}: ${String(run.conclusion).slice(0, 40)}; ${String(run.runUrl ?? "").slice(0, 300)}`);
    try {
      const jobsResponse = await fetchImpl(`${API_ROOT}/repos/${repository}/actions/runs/${run.runId}/jobs?per_page=100`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
      if (!jobsResponse.ok) continue;
      const jobsPayload = await jobsResponse.json();
      const failedJobs = (jobsPayload?.jobs ?? []).filter((job) => job?.conclusion === "failure").slice(0, 3);
      for (const job of failedJobs) {
        const failedSteps = (job.steps ?? []).filter((step) => step?.conclusion === "failure")
          .map((step) => String(step.name ?? "unknown").slice(0, 120)).slice(0, 5);
        parts.push(`Failed job: ${String(job.name ?? "unknown").slice(0, 160)}; failed steps: ${failedSteps.join(", ") || "not reported"}`);
        if (!Number.isSafeInteger(job.id)) continue;
        try {
          const logResponse = await fetchImpl(`${API_ROOT}/repos/${repository}/actions/jobs/${job.id}/logs`, {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": API_VERSION,
            },
          });
          if (!logResponse.ok || typeof logResponse.arrayBuffer !== "function") continue;
          const bytes = Buffer.from(await logResponse.arrayBuffer());
          const excerpt = extractZipText(bytes, 5000);
          if (excerpt) parts.push(`Untrusted CI log excerpt:\n${excerpt}`);
        } catch {
          // CI job names and step conclusions remain useful when log retrieval is unavailable.
        }
      }
    } catch {
      // Diagnostics remain bounded and the caller can still use workflow-level status.
    }
  }
  return (parts.join("\n\n") || "O GitHub Actions confirmou uma falha, mas não disponibilizou logs utilizáveis.")
    .slice(0, 6000);
}
