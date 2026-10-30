"use strict";

// Busca sem Exa: Tavily opcional + fontes publicas de noticias.
// Nunca interpreta "nenhum resultado" como prova de que uma noticia e falsa.
const NEWS = /\b(noticia|noticias|noticiario|hoje|ontem|anteontem|agora|atual|atualmente|recente|ultimas|ultima|aconteceu|acontecendo|chegou|fugiu|viajou|morreu|preso|prisao|eleicao|eleicoes|governo|anunciou|anuncio|investigacao|foi|esta|estao)\b/i;
const STOPS = new Set(("a o os as um uma uns umas de do da dos das para por que qual quais como quando onde porque " +
  "na no nos nas em ao aos com sobre entre este esta estes essas essa isso aquilo quem " +
  "me diga conte explique pesquise pesquisar pesquisa verifique confirme saber " +
  "verdade boato boatos rumor rumores aconteceu acontecendo chegou fugiu viajou estaria esta estao estar foi foram " +
  "hoje ontem anteontem agora atual recente ultimas ultima noticias noticia").split(" "));
const MAX_RESULTS = 7;
const MAX_LENGTH = 1800;

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function isNewsQuery(message) {
  return NEWS.test(normalize(message));
}
function terms(message) {
  return (normalize(message).match(/[a-z0-9]{2,}/g) || [])
    .filter((word) => !STOPS.has(word)).slice(0, 8);
}
function topicQuery(message) {
  const selected = [...new Set(terms(message))].slice(0, 5);
  return selected.join(" ");
}
function safeUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function shorten(raw, length = MAX_LENGTH) {
  return String(raw || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, length);
}
async function responseText(fetchImpl, url, options = {}, timeoutMs = 9500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const contentLength = Number(res.headers?.get?.("content-length") || 0);
    if (contentLength > 1000000) throw new Error("Resposta muito grande");
    const text = await res.text();
    if (text.length > 1000000) throw new Error("Resposta muito grande");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
async function searchTavily(message, apiKey, news, fetchImpl) {
  const body = {
    query: String(message).trim().slice(0, 400),
    topic: news ? "news" : "general",
    search_depth: "basic",
    max_results: 7,
    include_answer: false,
    include_raw_content: false
  };
  if (news) body.time_range = "week";
  const raw = await responseText(fetchImpl, "https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify(body)
  });
  const data = JSON.parse(raw);
  return (Array.isArray(data.results) ? data.results : []).map((item) => ({
    title: shorten(item.title, 240),
    url: safeUrl(item.url),
    publishedDate: shorten(item.published_date || item.publishedDate, 80),
    text: shorten(item.content),
    provider: "Tavily"
  })).filter((r) => r.title && r.url);
}
async function searchGdelt(message, fetchImpl) {
  const query = topicQuery(message);
  if (query.split(" ").length < 2) return [];
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", "7d");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("maxrecords", "20");
  const raw = await responseText(fetchImpl, url.href);
  const data = JSON.parse(raw);
  return (Array.isArray(data.articles) ? data.articles : []).map((item) => ({
    title: shorten(item.title, 240),
    url: safeUrl(item.url),
    // GDELT frequentemente retorna "seendate": nunca chamar isso de data de publicacao.
    indexedAt: shorten(item.seendate, 32),
    text: "",
    provider: "GDELT",
    evidenceKind: "headline"
  })).filter((r) => r.title && r.url);
}
function xmlText(value) {
  return shorten(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&#39;": "'"
    }[entity] || entity)));
}
function xmlTag(item, name) {
  const match = item.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return match ? xmlText(match[1]) : "";
}
async function searchAgenciaBrasil(message, fetchImpl) {
  const keywords = [...new Set(terms(message))].slice(0, 5);
  if (keywords.length < 2) return [];
  const xml = await responseText(fetchImpl, "https://agenciabrasil.ebc.com.br/feed/ultimasnoticias/feed.xml");
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  return items.map((item) => {
    const title = xmlTag(item, "title");
    const description = xmlTag(item, "description");
    const haystack = normalize(title + " " + description);
    const matches = keywords.filter((word) => haystack.includes(word)).length;
    return {
      title, url: safeUrl(xmlTag(item, "link")),
      publishedDate: xmlTag(item, "pubDate"),
      text: description.slice(0, 1000),
      provider: "Agencia Brasil",
      relevance: matches,
      evidenceKind: "snippet"
    };
  }).filter((item) => item.url && item.title && item.relevance >= 2)
    .sort((a, b) => b.relevance - a.relevance).slice(0, 7);
}
function combine(groups) {
  const candidates = groups.flat().filter(Boolean);
  const seen = new Set();
  const results = [];
  // Diversidade de fontes: evita repetir a mesma pagina por provedores distintos.
  for (const item of candidates) {
    const key = item.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}
async function searchFreshWeb(message, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey = options.tavilyApiKey === undefined ? process.env.TAVILY_API_KEY : options.tavilyApiKey;
  const news = isNewsQuery(message);
  const tasks = [];
  if (apiKey) tasks.push({ name: "Tavily", call: () => searchTavily(message, apiKey, news, fetchImpl) });
  if (news) {
    tasks.push({ name: "GDELT", call: () => searchGdelt(message, fetchImpl) });
    tasks.push({ name: "Agencia Brasil", call: () => searchAgenciaBrasil(message, fetchImpl) });
  }
  if (!tasks.length) {
    return { attempted: false, available: false, results: [],
      reason: "Pesquisa geral indisponivel: configure TAVILY_API_KEY no servidor; Exa nao e utilizado." };
  }
  const settled = await Promise.allSettled(tasks.map((task) => task.call()));
  const results = combine(settled.map((outcome) => outcome.status === "fulfilled" ? outcome.value : []));
  const failed = settled.map((outcome, i) => outcome.status === "rejected" ? tasks[i].name : null).filter(Boolean);
  const providers = tasks.map((task) => task.name);
  return {
    attempted: true,
    available: results.length > 0,
    results,
    providers,
    reason: results.length ? null : "Nenhuma fonte verificavel encontrada" +
      (failed.length ? "; falha em: " + failed.join(", ") : "") +
      ". Isso NAO significa que o fato seja falso."
  };
}
module.exports = { searchFreshWeb, isNewsQuery, topicQuery };
