const DEFAULT_BASE_BRANCH = "main";
const ANDROID_TARGET_PATTERN = /(?:\bandroid\b|\bapk\b|\bcelular(?:es)?\b|\btelefone(?:s)?\b|\bchamad(?:a|as|o|os)\b|\bliga(?:c(?:ao|oes)|ç(?:ão|ões)|r)\b|\bdiscador\b|\baplicativos?\b|\bapps?\b|\bnotifica(?:ção|ções|c[aã]o|c[aã]oes)\b|\bpermiss(?:ão|ões|ao|oes)\b|\btelas?\b|\bwidgets?\b|\bbolha flutuante\b|\binstalar no telefone\b|\bwhatsapp\b|\bcontatos?\b|\bc[aâ]mera\b|\bfotos?\b|\bsms\b)/i;
const SERVER_TARGET_PATTERN = /\b(?:server|backend|back-end|servidor|api|endpoint|webhook|banco de dados|database|infraestrutura|rota de servidor)\b/i;

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
  const android = ANDROID_TARGET_PATTERN.test(goal);
  const server = SERVER_TARGET_PATTERN.test(goal);
  if (android && server) return "full_stack";
  if (android) return "android";
  if (server) return "server";
  // Ação de e-mail, por si só, não é uma capacidade Android: o envio exige
  // integração de backend, salvo quando o usuário menciona explicitamente o app/celular.
  return "server";
}

export function resolveSelfImprovementTarget(goal, env = process.env) {
  const target = classifySelfImprovementTarget(goal);
  const repository = target === "android"
    ? env.JARVIS_ANDROID_REPOSITORY
    : target === "full_stack"
      ? env.JARVIS_FULL_STACK_REPOSITORY
      : env.JARVIS_GITHUB_REPOSITORY;
  const baseBranch = target === "android"
    ? (env.JARVIS_ANDROID_BASE_BRANCH || DEFAULT_BASE_BRANCH)
    : target === "full_stack"
      ? (env.JARVIS_FULL_STACK_BASE_BRANCH || DEFAULT_BASE_BRANCH)
      : (env.JARVIS_GITHUB_BASE_BRANCH || DEFAULT_BASE_BRANCH);
  if (!validRepository(repository)) {
    return {
      available: false,
      target,
      repository: null,
      baseBranch: null,
      reason: target === "android"
        ? "JARVIS_ANDROID_REPOSITORY não está configurado; nenhuma proposta foi criada."
        : target === "full_stack"
          ? "JARVIS_FULL_STACK_REPOSITORY não está configurado; nenhuma proposta foi criada."
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

/**
 * Android repositories use their own build/test workflow names. An empty or
 * malformed override is rejected rather than falling back to server checks.
 */
export function requiredWorkflowsForTarget(target, env = process.env) {
  let raw;
  if (target === "full_stack") {
    raw = env.JARVIS_FULL_STACK_REQUIRED_WORKFLOWS ||
      "JARVIS Capability Tests,JARVIS Android Build and Tests";
  } else if (target === "android") {
    raw = env.JARVIS_ANDROID_REQUIRED_WORKFLOWS || "JARVIS Android Build and Tests";
  } else if (target === "server") {
    return null;
  } else {
    throw new TypeError("target inválido para seleção de workflows.");
  }
  if (typeof raw !== "string" || raw.length > 1000) {
    throw new TypeError("Configuração de workflows obrigatórios inválida.");
  }
  const names = raw.split(",").map((name) => name.trim());
  if (names.length < 1 || names.length > 10 ||
      names.some((name) => !name || name.length > 120) ||
      new Set(names).size !== names.length) {
    throw new TypeError("A configuração de workflows deve listar de 1 a 10 nomes únicos.");
  }
  return names;
}
