const DEFAULT_BASE_BRANCH = "main";
const ANDROID_TARGET_PATTERN = /\b(?:android|apk|celular|telefone|chamada|ligac[aã]o|ligar|discador|e-?mail|email|aplicativo|app|notifica[cç][aã]o|permiss[aã]o|tela|widget|bolha flutuante|instalar no telefone)\b/i;

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") &&
    !value.includes("\\") && /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Chooses the repository that actually owns the requested capability.
 * Android-facing work must never be silently proposed against the server repo.
 */
export function classifySelfImprovementTarget(goal) {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) {
    throw new TypeError("goal inválido.");
  }
  return ANDROID_TARGET_PATTERN.test(goal) ? "android" : "server";
}

export function resolveSelfImprovementTarget(goal, env = process.env) {
  const target = classifySelfImprovementTarget(goal);
  const repository = target === "android"
    ? env.JARVIS_ANDROID_REPOSITORY
    : env.JARVIS_GITHUB_REPOSITORY;
  const baseBranch = target === "android"
    ? (env.JARVIS_ANDROID_BASE_BRANCH || DEFAULT_BASE_BRANCH)
    : (env.JARVIS_GITHUB_BASE_BRANCH || DEFAULT_BASE_BRANCH);
  if (!validRepository(repository)) {
    return {
      available: false,
      target,
      repository: null,
      baseBranch: null,
      reason: target === "android"
        ? "JARVIS_ANDROID_REPOSITORY não está configurado; nenhuma proposta foi criada."
        : "JARVIS_GITHUB_REPOSITORY não está configurado; nenhuma proposta foi criada.",
    };
  }
  if (!validBranch(baseBranch)) {
    return {
      available: false,
      target,
      repository: null,
      baseBranch: null,
      reason: "A branch base configurada para o alvo é inválida; nenhuma proposta foi criada.",
    };
  }
  return { available: true, target, repository, baseBranch, reason: null };
}
