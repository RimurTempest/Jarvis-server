import { containsLikelySecret } from "./secret-scanner.mjs";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_FILES = 20;
const MAX_FILE_SIZE = 60_000;
const MAX_TOTAL_SIZE = 180_000;
const SUPPORTED_SOURCE_EXTENSIONS = /\.(?:mjs|js|json|md|kt|kts|java|xml|gradle|properties|toml|ya?ml|pro|txt)$/i;

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") &&
    !value.includes("\\") && /^[A-Za-z0-9._/-]+$/.test(value);
}

function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function isSensitivePath(path) {
  return /(^|\/)\.env(?:\.[^/]*)?$|(^|\/)\.git(\/|$)|(^|\/)node_modules(\/|$)|(^|\/)\.gradle(\/|$)|(^|\/)build(\/|$)|(^|\/)\.idea(\/|$)|(^|\/)(?:secrets?|credentials?)(\/|$)|(^|\/)(?:id_rsa|id_ed25519)(?:\.[^/]*)?$|(^|\/)(?:\.npmrc|\.pypirc|local\.properties|signing\.properties)$|\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i.test(path);
}

function supportedSourcePath(path) {
  const javascriptTest = /(^|\/)test(?:s)?\/.*\.(?:mjs|js)$/i.test(path) ||
    /\.test\.(?:mjs|js)$/i.test(path);
  return SUPPORTED_SOURCE_EXTENSIONS.test(path) &&
    !javascriptTest &&
    !/self-improvement-(?:proposal-policy|github-publisher|code-generator)/i.test(path);
}

function scorePath(path, goalWords) {
  const normalized = path.toLowerCase();
  let score = 0;
  if (normalized === "server.js") score += 1000;
  if (normalized.endsWith("/mainactivity.kt")) score += 950;
  if (normalized.endsWith("/androidmanifest.xml")) score += 900;
  if (/(^|\/)app\/(?:build\.gradle\.kts|build\.gradle)$/.test(normalized)) score += 850;
  if (/(^|\/)(?:settings\.gradle\.kts|settings\.gradle|build\.gradle\.kts|build\.gradle)$/.test(normalized)) score += 700;
  if (/(^|\/)gradle\/libs\.versions\.toml$/.test(normalized)) score += 650;
  if (/(^|\/)src\/(?:test|androidtest)\//.test(normalized) && /\.kt$/i.test(normalized)) score += 200;
  if (normalized === "package.json") score += 900;
  if (normalized === "behavior.js") score += 850;
  if (normalized === "jarvis-capabilities/readme.md") score += 800;
  if (normalized.startsWith("jarvis-capabilities/")) score += 100;
  for (const word of goalWords) {
    if (word.length >= 3 && normalized.includes(word)) score += Math.min(30, word.length * 2);
  }
  return score;
}

async function request(fetchImpl, token, path, { method = "GET", body } = {}) {
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
  if (!response.ok) throw new Error(`GitHub API falhou ao obter contexto (HTTP ${response.status}).`);
  return payload;
}

/**
 * Reads a bounded set of non-sensitive source files from one exact branch
 * revision. The returned revision is later checked again by the publisher.
 */
export async function fetchSelfImprovementRepositoryContext({
  token,
  repository,
  baseBranch,
  goal,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.trim().length < 20) throw new TypeError("Token do GitHub ausente ou inválido.");
  if (!validRepository(repository)) throw new TypeError("repository deve usar o formato owner/repository.");
  if (!validBranch(baseBranch)) throw new TypeError("baseBranch inválida.");
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) throw new TypeError("goal inválido.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl deve ser uma função.");

  const repoPath = `/repos/${repository}`;
  const ref = await request(fetchImpl, token, `${repoPath}/git/ref/heads/${encodeRef(baseBranch)}`);
  const baseRevision = ref?.object?.sha;
  if (typeof baseRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseRevision)) {
    throw new Error("GitHub não retornou um SHA válido para a branch base.");
  }

  const treeResponse = await request(fetchImpl, token, `${repoPath}/git/trees/${baseRevision}?recursive=1`);
  if (treeResponse?.truncated === true || !Array.isArray(treeResponse?.tree)) {
    throw new Error("A árvore do repositório está incompleta; contexto recusado por segurança.");
  }

  const goalWords = goal.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  const candidates = treeResponse.tree
    .filter((entry) => entry?.type === "blob" && typeof entry.path === "string" &&
      Number.isInteger(entry.size) && entry.size >= 1 && entry.size <= MAX_FILE_SIZE &&
      !isSensitivePath(entry.path) && supportedSourcePath(entry.path))
    .map((entry) => ({ path: entry.path, size: entry.size, score: scorePath(entry.path, goalWords) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= MAX_FILES) break;
    if (selectedBytes + candidate.size > MAX_TOTAL_SIZE) continue;
    selected.push(candidate);
    selectedBytes += candidate.size;
  }
  if (!selected.length) throw new Error("Nenhum arquivo de código seguro foi encontrado para contextualizar a proposta.");

  const contextFiles = [];
  for (const entry of selected) {
    const contentResponse = await request(
      fetchImpl,
      token,
      `${repoPath}/contents/${encodePath(entry.path)}?ref=${encodeURIComponent(baseRevision)}`,
    );
    if (contentResponse?.encoding !== "base64" || typeof contentResponse.content !== "string") {
      throw new Error(`GitHub não retornou conteúdo base64 válido para ${entry.path}.`);
    }
    const content = Buffer.from(contentResponse.content.replace(/\s+/g, ""), "base64").toString("utf8");
    if (!content.trim() || content.length > MAX_FILE_SIZE) {
      throw new Error(`Conteúdo inválido ou grande demais: ${entry.path}.`);
    }
    if (containsLikelySecret(content)) {
      throw new Error(`Possível segredo detectado no arquivo de contexto ${entry.path}; contexto recusado.`);
    }
    contextFiles.push({ path: entry.path, content });
  }

  return { repository, baseBranch, baseRevision: baseRevision.toLowerCase(), contextFiles };
}
