import { timingSafeEqual } from "node:crypto";

/**
 * First-party skills catalog, read-only by construction.
 * No arbitrary shell, browser execution, financial actions or Android mutation.
 * Routing returns suggestions ONLY; the server does not invoke a capability.
 */
const definitions = Object.freeze([
  {
    id: "server.health",
    title: "Diagnóstico do servidor",
    platform: "server",
    explanation: "Consulta o funcionamento geral e a disponibilidade dos serviços.",
    triggers: ["diagnostico servidor", "status do servidor", "servidor online"],
  },
  {
    id: "assistant.chat",
    title: "Conversa com IA",
    platform: "server",
    explanation: "Conversa com o JARVIS usando um provedor já configurado e autorizado.",
    triggers: ["conversar com jarvis", "conversar com ia", "pergunta para ia"],
  },
  {
    id: "research.web",
    title: "Pesquisa atualizada",
    platform: "server",
    explanation: "Pesquisa informações públicas, se houver pesquisador gratuito configurado.",
    triggers: ["pesquisar na internet", "pesquisa na web", "pesquisar noticias"],
  },
  {
    id: "memory.persistent",
    title: "Memória persistente",
    platform: "server",
    explanation: "Consulta ou registra preferências somente mediante solicitação explícita.",
    triggers: ["minha memoria", "ver minhas memorias", "memoria persistente"],
  },
  {
    id: "phone.battery",
    title: "Bateria do celular",
    platform: "android",
    explanation: "Informa o nível da bateria diretamente no dispositivo.",
    triggers: ["nivel da bateria", "bateria do celular"],
  },
  {
    id: "phone.network",
    title: "Rede do celular",
    platform: "android",
    explanation: "Consulta conexão Wi-Fi ou dados móveis no Android.",
    triggers: ["status da rede", "minha conexao"],
  },
  {
    id: "phone.android",
    title: "Informações do Android",
    platform: "android",
    explanation: "Informa a versão do sistema do aparelho.",
    triggers: ["versao do android", "informacoes do aparelho"],
  },
]);

function normalize(raw) {
  return String(raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function buildSkillsCatalog(options = {}) {
  const chatReady = options.chatReady === true;
  const researchReady = options.researchReady === true && chatReady;
  const memoryReady = options.memoryReady === true;
  const capabilities = definitions.map(({ id, title, platform, explanation }) => {
    const available = platform === "android" || id === "server.health" ||
      (id === "assistant.chat" && chatReady) ||
      (id === "research.web" && researchReady) ||
      (id === "memory.persistent" && memoryReady);
    return {
      id,
      title,
      platform,
      explanation,
      available: Boolean(available),
      implemented: true,
      executed: false,
    };
  });
  return {
    schemaVersion: 1,
    service: "JARVIS",
    mode: "catalog-only",
    autoExecution: false,
    capabilities,
  };
}

export function resolveSkillSuggestion(rawUtterance, catalog) {
  if (typeof rawUtterance !== "string" ||
      !rawUtterance.trim() || rawUtterance.length > 500) {
    throw new TypeError("Fala inválida ou muito longa.");
  }
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.capabilities)) {
    throw new TypeError("Catálogo inválido.");
  }
  const normalized = normalize(rawUtterance);
  if (["habilidades", "listar habilidades", "quais habilidades voce tem"].includes(normalized)) {
    return {
      decision: "catalog",
      skillId: null,
      executed: false,
      requiresOwnerConfirmation: false,
    };
  }
  const found = definitions.find((skill) => skill.triggers.includes(normalized));
  if (!found) {
    return {
      decision: "none",
      skillId: null,
      executed: false,
      requiresOwnerConfirmation: false,
    };
  }
  const registered = catalog.capabilities.find((skill) => skill.id === found.id);
  return {
    decision: registered?.available ? "suggest" : "unavailable",
    skillId: found.id,
    executed: false,
    requiresOwnerConfirmation: true,
  };
}

/** Dedicated, least-privilege catalog token; never accept a master chat key. */
export function validSkillsToken(header, configuredSecret) {
  if (typeof configuredSecret !== "string" || configuredSecret.length < 32 ||
      typeof header !== "string") return false;
  const match = /^Bearer\s+([^\s]{32,512})$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(configuredSecret, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
