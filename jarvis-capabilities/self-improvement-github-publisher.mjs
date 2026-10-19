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

function escapeMarkdown(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "&#92;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/`/g, "&#96;")
    .replace(/\*/g, "&#42;")
    .replace(/_/g, "&#95;")
    .replace(/!/g, "&#33;");
}

async function githubRequest(fetchImpl, token, path, { method = "GET", body, allowNotFound = false } = {}) {
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
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    if (allowNotFound && response.status === 404) return null;
    throw new Error(`GitHub API falhou durante ${method} ${path.split("?")[0]} (HTTP ${response.status}).`);
  }
  return payload;
}

function validSha(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function verifyExistingProposalCommit(commit, expectedTreeSha, expectedBaseSha) {
  return commit?.tree?.sha === expectedTreeSha &&
    Array.isArray(commit.parents) &&
    commit.parents[0]?.sha?.toLowerCase() === expectedBaseSha.toLowerCase();
}

/**
 * Publishes a validated proposal as a draft pull request only.
 * The token should be a fine-grained token scoped to one repository, with
 * Contents: read/write and Pull requests: read/write. It must not have merge,
 * administration, or deployment permissions. This function never merges or deploys.
 */
export async function createDraftSelfImprovementPullRequest({
  token,
  repository,
  baseBranch,
  proposal,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20) throw new TypeError("Token do GitHub ausente ou inválido.");
  if (!validateRepository(repository)) throw new TypeError("repository deve usar o formato owner/repository.");
  if (!validateBranch(baseBranch)) throw new TypeError("baseBranch inválida.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl deve ser uma função.");

  const policy = validateSelfImprovementProposal(proposal);
  if (!policy.ok) throw new Error(`Proposta recusada pela política: ${policy.errors.join(" ")}`);

  const repoPath = `/repos/${repository}`;
  const branchName = `jarvis/proposals/${safeSegment(proposal.requestId)}-${policy.proposalDigest.slice(0, 12)}`;
  const owner = repository.split("/")[0];

  const baseRef = await githubRequest(fetchImpl, token, `${repoPath}/git/ref/heads/${encodeRef(baseBranch)}`);
  const actualBaseRevision = baseRef?.object?.sha;
  if (!validSha(actualBaseRevision)) throw new Error("GitHub não retornou um SHA válido para a branch base.");
  if (actualBaseRevision.toLowerCase() !== proposal.baseRevision.toLowerCase()) {
    throw new Error("A branch base mudou desde a proposta; gere novamente contra a revisão atual.");
  }

  const baseCommit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits/${actualBaseRevision}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (!validSha(baseTreeSha)) throw new Error("GitHub não retornou uma árvore Git válida para a revisão base.");

  const treeEntries = [];
  for (const file of proposal.files) {
    const blob = await githubRequest(fetchImpl, token, `${repoPath}/git/blobs`, {
      method: "POST",
      body: { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" },
    });
    if (!validSha(blob?.sha)) throw new Error(`GitHub não retornou um blob válido para ${file.path}.`);
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest(fetchImpl, token, `${repoPath}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (!validSha(tree?.sha)) throw new Error("GitHub não retornou uma árvore válida para a proposta.");

  // If a previous request timed out after GitHub accepted it, reuse the exact
  // existing draft PR instead of creating duplicate branches or deleting one.
  const prQuery = new URLSearchParams({
    head: `${owner}:${branchName}`,
    base: baseBranch,
    state: "open",
    per_page: "10",
  }).toString();
  const existingPullRequests = await githubRequest(fetchImpl, token, `${repoPath}/pulls?${prQuery}`);
  if (Array.isArray(existingPullRequests)) {
    const existingPr = existingPullRequests.find((item) =>
      item?.state === "open" && item?.head?.ref === branchName && item?.base?.ref === baseBranch
    );
    if (existingPr) {
      if (existingPr.draft !== true || !validSha(existingPr.head?.sha)) {
        throw new Error("Já existe um pull request para esta branch que não está em estado draft.");
      }
      const existingCommit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits/${existingPr.head.sha}`);
      if (!verifyExistingProposalCommit(existingCommit, tree.sha, actualBaseRevision)) {
        throw new Error("A branch de proposta existente não corresponde ao conteúdo e à revisão base esperados.");
      }
      return {
        number: existingPr.number,
        url: existingPr.html_url,
        draft: true,
        branch: branchName,
        baseBranch,
        baseRevision: actualBaseRevision,
        commitSha: existingPr.head.sha,
        proposalDigest: policy.proposalDigest,
        requiresHumanReview: policy.requiresHumanReview,
        reusedExisting: true,
      };
    }
  }

  const existingBranch = await githubRequest(fetchImpl, token, `${repoPath}/git/ref/heads/${encodeRef(branchName)}`, { allowNotFound: true });
  let commitSha;
  if (existingBranch) {
    const existingSha = existingBranch?.object?.sha;
    if (!validSha(existingSha)) throw new Error("A branch de proposta existente tem um SHA inválido.");
    const existingCommit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits/${existingSha}`);
    if (!verifyExistingProposalCommit(existingCommit, tree.sha, actualBaseRevision)) {
      throw new Error("A branch de proposta já existe com conteúdo diferente; nenhuma referência foi sobrescrita.");
    }
    commitSha = existingSha;
  } else {
    const commit = await githubRequest(fetchImpl, token, `${repoPath}/git/commits`, {
      method: "POST",
      body: {
        message: `J.A.R.V.I.S. capability proposal ${proposal.requestId}`,
        tree: tree.sha,
        parents: [actualBaseRevision],
      },
    });
    if (!validSha(commit?.sha)) throw new Error("GitHub não retornou um commit válido para a proposta.");
    commitSha = commit.sha;
    await githubRequest(fetchImpl, token, `${repoPath}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branchName}`, sha: commitSha },
    });
  }

  const testPlan = proposal.tests.map((item) => `- ${escapeMarkdown(item)}`).join("\n");
  const protectedNotice = policy.requiresHumanReview
    ? "\n\n**Human review required:** this proposal touches a protected path or is elevated/high risk."
    : "";
  const pullRequest = await githubRequest(fetchImpl, token, `${repoPath}/pulls`, {
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

  if (!Number.isInteger(pullRequest?.number) || typeof pullRequest?.html_url !== "string" || pullRequest.draft !== true) {
    throw new Error("GitHub não retornou os metadados esperados de um pull request draft.");
  }
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    draft: true,
    branch: branchName,
    baseBranch,
    baseRevision: actualBaseRevision,
    commitSha,
    proposalDigest: policy.proposalDigest,
    requiresHumanReview: policy.requiresHumanReview,
    reusedExisting: false,
  };
}
