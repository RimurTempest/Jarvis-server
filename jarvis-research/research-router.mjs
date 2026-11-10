/**
 * The JARVIS research team. Every source has an explicit job:
 * Agency Brasil RSS: recently published Brazilian public-interest news;
 * GDELT: international news coverage, not fact verification;
 * Tavily: broad current web questions (free plan independently attested);
 * Exa: specialist documents (optional and disabled by default).
 *
 * Search pages are untrusted evidence, never executable instructions.
 * No arbitrary URL fetches. Hardcoded HTTPS provider endpoints only.
 */
const MAX_RESULTS = 5;
const BRAZIL_RSS = "https://agenciabrasil.ebc.com.br/feed/ultimasnoticias/feed.xml";
const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";
const TAVILY_SEARCH = "https://api.tavily.com/search";
const EXA_SEARCH = "https://api.exa.ai/search";
const TIMEOUT_MS = 8500;
const BUDGET_BYTES = 450_000;
const RECENT_RSS_DAYS = 7;

const normalize = (raw) =>
  String(raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const safeText = (value, max = 200) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const safeUrl = (url) => {
  try {
    const parsed = new URL(String(url));
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username &&
      !parsed.password ? parsed.toString() : null;
  } catch { return null; }
};
const limitSources = (arr, researcher) =>
  arr.map((a) => ({
    title: safeText(a.title || a.name || "Fonte sem título", 220),
    url: safeUrl(a.url),
    publishedDate: safeText(a.publishedDate || a.pubDate || a.seendate || "", 64),
    text: safeText(a.text || a.summary || a.description || "", 440),
    researcher,
  })).filter((x) => x.url);

const aborting = async (url, options = {}, fetchImpl = fetch) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  t.unref?.();
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: ctrl.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("status_" + response.status);
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > BUDGET_BYTES) throw new Error("response_too_large");
    // JSON/XML is capped during streaming; no unbounded readText/json.
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > BUDGET_BYTES) throw new Error("response_too_large");
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0, result = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > BUDGET_BYTES) throw new Error("response_too_large");
        result += decoder.decode(value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    return result + decoder.decode();
  } finally { clearTimeout(t); }
};

export function researchRouterPolicy(env = {}) {
  const tavilyEnabled = env.JARVIS_SEARCH_TAVILY_ENABLED === "true" &&
    env.JARVIS_SEARCH_TAVILY_FREE_ATTESTED === "true" &&
    typeof env.TAVILY_API_KEY === "string" && env.TAVILY_API_KEY.length >= 12;
  const exaEnabled = env.JARVIS_SEARCH_EXA_ENABLED === "true" &&
    env.JARVIS_SEARCH_EXA_FREE_ATTESTED === "true" &&
    typeof env.EXA_API_KEY === "string" && env.EXA_API_KEY.length >= 12;
  return {
    version: 1, mode: "research-by-specialty",
    researchers: [
      { id: "agencia-brasil", role: "noticias_brasil", configured: true, enabled: true, requiresKey: false },
      { id: "gdelt", role: "noticias_internacionais", configured: true, enabled: true, requiresKey: false },
      { id: "tavily", role: "pesquisa_web_geral", configured: Boolean(env.TAVILY_API_KEY), enabled: tavilyEnabled, requiresKey: true },
      { id: "exa", role: "documentos_especializados", configured: Boolean(env.EXA_API_KEY), enabled: exaEnabled, requiresKey: true },
    ],
    noPaidFallback: true,
    noAutomaticTools: true,
  };
}

export function validateResearchQuery(raw) {
  if (typeof raw !== "string" || raw.trim().length < 3 ||
      raw.length > 180 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new TypeError("Consulta inválida: use de 3 a 180 caracteres sem controles.");
  }
  return raw.trim();
}

export function classifyResearchQuery(raw) {
  const query = safeText(raw, 180);
  if (query.length < 3) return "invalid";
  const q = normalize(query);
  const news = /\b(noticia|noticias|hoje|agora|ultima|ultimas|aconteceu|acontecimentos|recente|recentes|reportagem|guerra|eleicao)\b/.test(q);
  const brazil = /\b(brasil|brasileir\w*|recife|pernambuco|bahia|rio de janeiro|sao paulo|stf|congresso|brasilia|senado|camara|lula|bolsonaro)\b/.test(q);
  const global = /\b(internacional|mundo|europa|estados unidos|eua|usa|china|ucrania|russia|argentina|uruguai|miami|geopolitic\w*)\b/.test(q);
  const technical = /\b(documentacao|artigo cientifico|estudo|paper|manual|bibliografia|especificacao|pesquisa academica|normas tecnicas)\b/.test(q);
  if (technical) return "specialist";
  if (news && brazil && global) return "mixed-news";
  if (news && brazil) return "brazil-news";
  if (news || global) return "global-news";
  if (brazil && /\b(governo|politica|economia|saude publica)\b/.test(q)) return "brazil-news";
  return "general";
}

const decodeXml = (value) => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10FFFF)));
const xmlField = (block, key) => decodeXml(
  new RegExp("<" + key + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + key + ">", "i")
    .exec(block)?.[1] || ""
).replace(/<[^>]*>/g, " ");

function relevantRss(xml, rawQuery, nowMs = Date.now()) {
  const stop = new Set(["noticia","noticias","hoje","agora","brasil","brasileiro","brasileira","sobre","minhas","quero","qual","quais","do","da","de","dos","das","na","no","um","uma","para","mais","os","as"]);
  const terms = [...new Set(normalize(rawQuery).split(/[^a-z0-9]+/).filter(
    (x) => x.length >= 4 && !stop.has(x)
  ))].slice(0, 8);
  if (!terms.length) return [];
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 55);
  return items.map((m) => {
    const block = m[1];
    const title = safeText(xmlField(block, "title"), 220);
    const link = safeUrl(xmlField(block, "link").trim());
    const pubDate = safeText(xmlField(block, "pubDate"), 64);
    const published = Date.parse(pubDate);
    if (!link || !title || !Number.isFinite(published) ||
        nowMs - published > RECENT_RSS_DAYS * 86400000 || published > nowMs + 600000) return null;
    const description = safeText(xmlField(block, "description"), 400);
    const content = normalize(title + " " + description);
    const score = terms.filter((t) => content.includes(t)).length;
    if (!score) return null;
    return { title, url: link, publishedDate: new Date(published).toISOString(), text: description, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3);
}

async function fetchAgencyBrazil(query, fetchImpl) {
  const xml = await aborting(BRAZIL_RSS, { method: "GET" }, fetchImpl);
  return limitSources(relevantRss(xml, query), "agencia-brasil");
}
async function fetchGdelt(query, fetchImpl) {
  const q = new URLSearchParams({
    query: query.slice(0, 130), mode: "artlist", format: "json", maxrecords: "6",
    timespan: "3d", sort: "datedesc",
  });
  const raw = await aborting(GDELT_DOC + "?" + q, { method: "GET" }, fetchImpl);
  const json = JSON.parse(raw);
  const articles = Array.isArray(json.articles) ? json.articles : [];
  return limitSources(articles.slice(0, 8).map((a) => ({
    title: a.title, url: a.url, publishedDate: a.seendate,
    description: a.domain ? "Cobertura: " + safeText(a.domain) : "",
  })), "gdelt");
}
async function fetchTavily(query, env, fetchImpl) {
  const raw = await aborting(TAVILY_SEARCH, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.TAVILY_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: query.slice(0, 180), search_depth: "basic", max_results: 3,
      include_answer: false, include_raw_content: false,
    }),
  }, fetchImpl);
  const json = JSON.parse(raw);
  return limitSources(Array.isArray(json.results) ? json.results : [], "tavily");
}
async function fetchExa(query, env, fetchImpl) {
  const raw = await aborting(EXA_SEARCH, {
    method: "POST",
    headers: {
      "x-api-key": env.EXA_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: query.slice(0, 180), type: "auto", numResults: 3,
      contents: { text: { maxCharacters: 350 } },
    }),
  }, fetchImpl);
  const json = JSON.parse(raw);
  return limitSources(Array.isArray(json.results) ? json.results : [], "exa");
}

export async function researchBySpecialty(query, options = {}) {
  const kind = classifyResearchQuery(query);
  if (kind === "invalid") return {
    attempted: false, available: false, results: [], reason: "Consulta muito curta.",
    researchers: [],
  };
  const env = options.env || {};
  const fetchImpl = options.fetchImpl || fetch;
  const policy = researchRouterPolicy(env);
  const enabled = new Map(policy.researchers.map((r) => [r.id, r.enabled]));
  const jobs = [];
  const add = (id, action) => { if (enabled.get(id)) jobs.push({ id, action }); };

  if (["brazil-news", "mixed-news"].includes(kind)) add("agencia-brasil", () => fetchAgencyBrazil(query, fetchImpl));
  if (["brazil-news", "mixed-news", "global-news"].includes(kind)) add("gdelt", () => fetchGdelt(query, fetchImpl));
  if (kind === "specialist") {
    add("exa", () => fetchExa(query, env, fetchImpl));
    add("tavily", () => fetchTavily(query, env, fetchImpl));
  }
  if (kind === "general") {
    add("tavily", () => fetchTavily(query, env, fetchImpl));
    add("exa", () => fetchExa(query, env, fetchImpl));
  }
  // World news benefits from general web corroboration when permitted,
  // never by silently substituting a billed provider.
  if (kind === "global-news") add("tavily", () => fetchTavily(query, env, fetchImpl));

  const reports = await Promise.all(jobs.map(async ({ id, action }) => {
    try { return { id, ok: true, results: await action() }; }
    catch (err) { return { id, ok: false, results: [], error: safeText(err?.name || "unavailable", 32) }; }
  }));
  const unique = new Set();
  const results = [];
  // News from official Agency Brasil first when applicable, then global coverage;
  // specialists and generic search stay with their own matching researchers.
  for (const report of reports) {
    for (const item of report.results) {
      const canonical = item.url?.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (!canonical || unique.has(canonical)) continue;
      unique.add(canonical);
      results.push(item);
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length >= MAX_RESULTS) break;
  }
  return {
    attempted: jobs.length > 0, available: results.length > 0, results,
    reason: results.length ? null : (jobs.length ? "Nenhuma fonte atual confiável foi recuperada." :
      "Nenhum pesquisador autorizado para esta categoria; Tavily e Exa permanecem desativados."),
    researchers: reports.map((r) => ({ id: r.id, ok: r.ok, resultCount: r.results.length })),
    category: kind,
  };
}


const DAILY_RESEARCH_LIMIT = 6;
let researchTableReady = null;

/** Every explicit lookup has a durable per-device quota, even if only public feeds are used. */
export async function reserveResearchDailyQuota(pool, deviceId) {
  if (!pool?.query || typeof deviceId !== "string" ||
      !/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(deviceId)) {
    throw new TypeError("Pesquisa não autorizada para este dispositivo.");
  }
  if (!researchTableReady) {
    researchTableReady = pool.query(`CREATE TABLE IF NOT EXISTS jarvis_research_daily (
      device_id TEXT NOT NULL, day_utc DATE NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, day_utc)
    )`).catch((e) => { researchTableReady = null; throw e; });
  }
  await researchTableReady;
  const result = await pool.query(
    `INSERT INTO jarvis_research_daily (device_id, day_utc, request_count)
     VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (device_id, day_utc)
     DO UPDATE SET request_count = jarvis_research_daily.request_count + 1
       WHERE jarvis_research_daily.request_count < $2
     RETURNING request_count`,
    [deviceId, DAILY_RESEARCH_LIMIT]
  );
  return {
    accepted: result.rowCount === 1,
    used: result.rowCount === 1 ? Number(result.rows[0].request_count) : DAILY_RESEARCH_LIMIT,
    limit: DAILY_RESEARCH_LIMIT,
  };
}

/** Names/presence only, never any value. Only a paired device may request it. */
export function configuredJarvisEnvInventory(env = {}) {
  const relevant = /^(JARVIS_|GROQ_|EXA_|TAVILY_|OPENAI_|HUGGING|HF_|NVIDIA_|ZAI_|OPENROUTER_|CLOUDFLARE_|CF_|GEMINI_|GOOGLE_|DATABASE_URL$)/;
  const configured = Object.keys(env).filter((k) => relevant.test(k)).sort();
  const essential = [
    "DATABASE_URL", "EXA_API_KEY", "TAVILY_API_KEY", "GROQ_API_KEY",
    "JARVIS_FREE_CHAT_ENABLED", "JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN",
    "JARVIS_FREE_CHAT_APPROVED_MODELS_JSON",
    "JARVIS_SEARCH_TAVILY_ENABLED", "JARVIS_SEARCH_TAVILY_FREE_ATTESTED",
    "JARVIS_SEARCH_EXA_ENABLED", "JARVIS_SEARCH_EXA_FREE_ATTESTED",
    "JARVIS_API_TOKEN", "JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN",
  ];
  for (let n = 1; n <= 10; n++) {
    for (const suffix of ["NAME", "MODEL", "BASE_URL", "API_KEY"]) {
      essential.push(`JARVIS_PROVIDER_${n}_${suffix}`);
    }
  }
  const names = [...new Set([...configured, ...essential])].sort();
  return {
    redacted: true,
    keyCount: configured.length,
    variables: names.map((name) => ({
      name,
      configured: Object.hasOwn(env, name) && String(env[name] ?? "").length > 0,
    })),
  };
}
