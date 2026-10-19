import { validateSelfImprovementProposal } from "./self-improvement-proposal-policy.mjs";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

function validateRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validateBranch(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("\\") &&
    /^[A-Za-z0-9._/-]+$/.test(value);
}

function encodeRef(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function safeSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "request";
}

async function githubRequest(fetchImpl, token, path, { method = "GET", body } = {}) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    // Do not include response bodies or request headers: provider errors may
    // echo user data, and authorization headers must never enter logs.
    throw new Error(`GitHub API falhou durante ${method} ${path.split("?")[0]} (HTTP ${response.status}).`);
  }
  return payload;
}

/**
 * Publishes a validated proposal as a draft pull request only.
 * The token should be a fine-grained GitHub token scoped to one repository,
 * with Contents: write and Pull requests: write. It must not have merge or
 * administration permissions. This function never merges or deploys.
 */
export async function createDraftSelfImprovementPullRequest({
  token,
  repository,
  baseBranch,
  proposal,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20) {
    throw new TypeError("Token do GitHub ausente ou inválido.");
  }
  if (!validateRepository(repository)) {
    throw new TypeError("repository deve usar o formato owner/repository.");
  }
  if (!validateBranch(baseBranch)) {
    throw new TypeError("baseBranch inválida.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl deve ser uma função.");
  }

  const policy = validateSelfImprovementProposal(proposal);
  if (!policy.ok) {
    throw new Error(`Proposta recusada pela política: ${policy.errors.join(" ")}`);
  }

  const repoPath = `/repos/${repository}`;
  const baseRef = await githubRequest(fetchImpl, token, `${repoPath}/git/ref/heads/${encodeRef(baseBranch)}`);
  const actualBaseRevision = baseRef?.object?.sha;
  if (typeof actualBaseRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(actualBaseRevision)) {
    throw new Error("GitHub não retornou um SHA válido para a branch base.");
  }
  if (actualBaseRevision.toLowerCase() !== proposal.baseRevision.toLowerCase()) {
    throw new Error("A branch base mudou desde a proposta; gere novamente contra a revisão atual.");
  }

  const baseCommit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits/${actualBaseRevision}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (typeof baseTreeSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(baseTreeSha)) {
    throw new Error("GitHub não retornou uma árvore Git válida para a revisão base.");
  }

  const treeEntries = [];
  for (const file of proposal.files) {
    const blob = await githubRequest(fetchImpl, token, `${repoPath}/git/blobs`, {
      method: "POST",
      body: { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" },
    });
    if (typeof blob?.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(blob.sha)) {
      throw new Error(`GitHub não retornou um blob válido para ${file.path}.`);
    }
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest(fetchImpl, token, `${repoPath}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (typeof tree?.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(tree.sha)) {
    throw new Error("GitHub não retornou uma árvore válida para a proposta.");
  }

  const commit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits`, {
    method: "POST",
    body: {
      message: `J.A.R.V.I.S. capability proposal ${proposal.requestId}`,
      tree: tree.sha,
      parents: [actualBaseRevision],
    },
  });
  if (typeof commit?.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(commit.sha)) {
    throw new Error("GitHub não retornou um commit válido para a proposta.");
  }

  const branchName = `jarvis/proposals/${safeSegment(proposal.requestId)}-${policy.proposalDigest.slice(0, 12)}`;
  await githubRequest(fetchImpl, token, `${repoPath}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branchName}`, sha: commit.sha },
  });

  let pullRequest;
  try {
    const testPlan = proposal.tests.map((item) => `- ${item}`).join("\n");
    const protectedNotice = policy.requiresHumanReview
      ? "\n\n**Human review required:** this proposal touches a protected path or is elevated/high risk."
      : "";
    pullRequest = await githubRequest(fetchImpl, token, `${repoPath}/pulls`, {
      method: "POST",
      body: {
        title: `J.A.R.V.I.S. capability proposal: ${proposal.requestId}`,
        head: branchName,
        base: baseBranch,
        draft: true,
        body: [
          "## Automated capability proposal",
          "",
          `- Request ID: ${proposal.requestId}`,
          `- Base revision: ${actualBaseRevision}`,
          `- Proposal SHA-256: ${policy.proposalDigest}`,
          `- Risk level: ${proposal.riskLevel || "standard"}`,
          "",
          "## Proposed validation plan",
          testPlan,
          "",
          "This pull request is intentionally draft-only. It must not be merged or deployed automatically. CI results and source review must be checked independently before packaging or installation.",
          protectedNotice,
        ].join("\n"),
      },
    });
  } catch (error) {
    // Best-effort cleanup only for the branch created by this invocation.
    try {
      await githubRequest(fetchImpl, token, `${repoPath}/git/refs/heads/${encodeRef(branchName)}`, { method: "DELETE" });
    } catch {
      // Keep the original PR-creation failure as the primary error.
    }
    throw error;
  }

  if (!Number.isInteger(pullRequest?.number) || typeof pullRequest?.html_url !== "string") {
    throw new Error("GitHub não retornou os metadados esperados do pull request.");
  }
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    draft: pullRequest.draft === true,
    branch: branchName,
    baseBranch,
    baseRevision: actualBaseRevision,
    commitSha: commit.sha,
    proposalDigest: policy.proposalDigest,
    requiresHumanReview: policy.requiresHumanReview,
  };
}
