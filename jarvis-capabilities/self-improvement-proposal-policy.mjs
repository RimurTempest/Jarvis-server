import { createHash } from "node:crypto";

const MAX_FILES = 30;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 500_000;
const MAX_TESTS = 50;
const VALID_RISK_LEVELS = new Set(["standard", "elevated", "high"]);
const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const LIKELY_SECRET = /(?:\bsk-[A-Za-z0-9_-]{24,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b)/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRequestId(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
}

function validRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) return false;
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  if (!/^[A-Za-z0-9._/@+-]+$/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isForbiddenPath(path) {
  const lower = path.toLowerCase();
  return /(^|\/)\.env(?:\.[^/]*)?$/.test(lower) ||
    /(^|\/)\.git(\/|$)/.test(lower) ||
    /(^|\/)node_modules(\/|$)/.test(lower) ||
    /(^|\/)(?:secrets?|credentials?)(\/|$)/.test(lower) ||
    /(^|\/)(?:id_rsa|id_ed25519)(?:\.[^/]*)?$/.test(lower) ||
    /(^|\/)(?:\.npmrc|\.pypirc)$/.test(lower) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i.test(lower);
}

function requiresElevatedReview(path) {
  const lower = path.toLowerCase();
  return !lower.startsWith("jarvis-capabilities/") ||
    lower === "server.js" ||
    lower === "behavior.js" ||
    lower === "package.json" ||
    lower === "package-lock.json" ||
    lower.startsWith(".github/") ||
    /(?:auth|route|registry|queue|protocol|evidence|validation|postgres|enrollment|android|update|release|install|deploy|security)/i.test(lower);
}

/**
 * Validates a proposed change before any future automation writes it to a
 * repository. This is a policy gate, not a code executor or a proof of safety.
 * It deliberately never merges, deploys, or installs a proposal.
 */
export function validateSelfImprovementProposal(input) {
  const errors = [];
  const protectedPaths = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["proposal deve ser um objeto."], requiresHumanReview: true, protectedPaths: [], proposalDigest: null };
  }

  const { requestId, baseRevision, files, tests, riskLevel = "standard" } = input;
  if (!validRequestId(requestId)) errors.push("requestId inválido.");
  if (typeof baseRevision !== "string" || !FULL_REVISION.test(baseRevision)) {
    errors.push("baseRevision deve ser um SHA completo de 40 ou 64 caracteres hexadecimais.");
  }
  if (!VALID_RISK_LEVELS.has(riskLevel)) errors.push("riskLevel deve ser standard, elevated ou high.");
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    errors.push(`files deve conter entre 1 e ${MAX_FILES} arquivos.`);
  }
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > MAX_TESTS) {
    errors.push(`tests deve conter entre 1 e ${MAX_TESTS} verificações propostas.`);
  }

  const seen = new Set();
  let totalBytes = 0;
  const normalizedFiles = [];

  if (Array.isArray(files) && files.length <= MAX_FILES) {
    files.forEach((file, index) => {
      if (!isRecord(file)) {
        errors.push(`files[${index}] deve ser um objeto.`);
        return;
      }
      const { path, content } = file;
      if (!validRelativePath(path)) {
        errors.push(`files[${index}].path não é um caminho relativo permitido.`);
        return;
      }
      if (seen.has(path)) {
        errors.push(`Caminho duplicado: ${path}.`);
        return;
      }
      seen.add(path);
      if (isForbiddenPath(path)) errors.push(`Caminho sensível proibido: ${path}.`);
      if (typeof content !== "string") {
        errors.push(`files[${index}].content deve ser texto.`);
        return;
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_FILE_BYTES) errors.push(`Arquivo excede o limite de ${MAX_FILE_BYTES} bytes: ${path}.`);
      totalBytes += bytes;
      if (PRIVATE_KEY_MARKER.test(content) || LIKELY_SECRET.test(content)) {
        errors.push(`Possível segredo detectado no conteúdo de ${path}.`);
      }
      if (requiresElevatedReview(path)) protectedPaths.push(path);
      normalizedFiles.push({ path, content });
    });
  }

  if (totalBytes > MAX_TOTAL_BYTES) errors.push(`Proposta excede o limite total de ${MAX_TOTAL_BYTES} bytes.`);

  if (Array.isArray(tests) && tests.length <= MAX_TESTS) {
    tests.forEach((test, index) => {
      if (typeof test !== "string" || !test.trim() || test.length > 500 || /[\r\n]/.test(test)) {
        errors.push(`tests[${index}] deve ser uma descrição de teste de uma única linha.`);
      }
    });
  }

  const requiresHumanReview = riskLevel !== "standard" || protectedPaths.length > 0;
  const ok = errors.length === 0;
  let proposalDigest = null;
  if (ok) {
    const canonical = JSON.stringify({
      requestId,
      baseRevision: baseRevision.toLowerCase(),
      riskLevel,
      files: normalizedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)),
      tests: tests.map((test) => test.trim()),
    });
    proposalDigest = createHash("sha256").update(canonical, "utf8").digest("hex");
  }

  return {
    ok,
    errors,
    requiresHumanReview,
    protectedPaths: [...new Set(protectedPaths)].sort(),
    proposalDigest,
    fileCount: normalizedFiles.length,
    totalBytes,
  };
}
