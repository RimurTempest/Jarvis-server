import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyResearchQuery, researchBySpecialty, researchRouterPolicy,
  reserveResearchDailyQuota, configuredJarvisEnvInventory,
} from "../jarvis-research/research-router.mjs";

const testEnv = {
  TAVILY_API_KEY: "t".repeat(32), EXA_API_KEY: "e".repeat(32),
};
const sampleRss = (title) => '<rss><channel><item>' +
  '<title>' + title + '</title>' +
  '<link>https://agenciabrasil.ebc.com.br/geral/noticia/2026-11/energia-publica</link>' +
  '<pubDate>' + new Date().toUTCString() + '</pubDate>' +
  '<description>' + title + ' informações recentes do Brasil</description>' +
  '</item></channel></rss>';
const mockFetcher = (queries) => async (url, options = {}) => {
  const target = String(url);
  queries.push({ target, method: options.method || "GET", auth: options.headers?.Authorization || null });
  let response;
  if (target.includes("agenciabrasil")) response = sampleRss("energia Brasil");
  else if (target.includes("gdelt")) response = JSON.stringify({
    articles: [{ title: "Cobertura internacional energia", url: "https://news.example.org/energia",
      seendate: "20261110120000", domain: "news.example.org" }],
  });
  else if (target.includes("tavily")) response = JSON.stringify({
    results: [{ title: "Pesquisa geral", url: "https://example.org/research",
      content: "Informações atuais" }],
  });
  else if (target.includes("exa")) response = JSON.stringify({
    results: [{ title: "Manual técnico", url: "https://example.org/manual", text: "documento" }],
  });
  else throw new Error("unexpected endpoint");
  return {
    ok: true, headers: { get: () => null }, text: async () => response,
  };
};

test("news and specialist research are delegated by topic", () => {
  assert.equal(classifyResearchQuery("notícias do Brasil hoje energia"), "brazil-news");
  assert.equal(classifyResearchQuery("notícias internacionais sobre energia na Europa"), "global-news");
  assert.equal(classifyResearchQuery("artigo científico sobre baterias"), "specialist");
  assert.equal(classifyResearchQuery("previsão para compras de uma casa"), "general");
  assert.equal(classifyResearchQuery("oi"), "invalid");
});

test("no key or paid researcher is used by default", () => {
  const policy = researchRouterPolicy(testEnv);
  assert.equal(policy.researchers.find((x) => x.id === "tavily").configured, true);
  assert.equal(policy.researchers.find((x) => x.id === "tavily").enabled, false);
  assert.equal(policy.researchers.find((x) => x.id === "exa").enabled, false);
  assert.equal(policy.researchers.find((x) => x.id === "gdelt").enabled, true);
  assert.equal(policy.researchers.find((x) => x.id === "agencia-brasil").enabled, true);
});

test("Brazil news uses Agency Brasil and GDELT without credentials", async () => {
  const queries = [];
  const r = await researchBySpecialty("notícias do Brasil hoje energia", {
    env: testEnv, fetchImpl: mockFetcher(queries),
  });
  assert.deepEqual(queries.map((x) => x.method), ["GET", "GET"]);
  assert.ok(queries[0].target.includes("agenciabrasil"));
  assert.ok(queries[1].target.includes("gdelt"));
  assert.equal(queries.some((x) => x.auth != null), false);
  assert.ok(r.available);
  assert.ok(r.results.some((x) => x.researcher === "agencia-brasil"));
  assert.ok(r.results.some((x) => x.researcher === "gdelt"));
});

test("global news uses GDELT, not Exa by default", async () => {
  const queries = [];
  const r = await researchBySpecialty("notícias internacionais sobre energia na Europa", {
    env: testEnv, fetchImpl: mockFetcher(queries),
  });
  assert.deepEqual(queries.map((q) => new URL(q.target).hostname),
    ["api.gdeltproject.org"]);
  assert.equal(r.results[0].researcher, "gdelt");
});

test("general research refuses paid tools unless explicitly free-attested", async () => {
  const calls = [];
  const r = await researchBySpecialty("como escolher carregador", {
    env: testEnv, fetchImpl: mockFetcher(calls),
  });
  assert.equal(r.available, false);
  assert.equal(calls.length, 0);
  assert.match(r.reason, /autorizado/);
  const optIn = {
    ...testEnv,
    JARVIS_SEARCH_TAVILY_ENABLED: "true",
    JARVIS_SEARCH_TAVILY_FREE_ATTESTED: "true",
  };
  const calls2 = [];
  const found = await researchBySpecialty("como escolher carregador", {
    env: optIn, fetchImpl: mockFetcher(calls2),
  });
  assert.equal(found.results[0].researcher, "tavily");
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].method, "POST");
});

test("Exa is only an optional specialist researcher with explicit approval", async () => {
  const calls = [];
  const env = {
    ...testEnv,
    JARVIS_SEARCH_EXA_ENABLED: "true",
    JARVIS_SEARCH_EXA_FREE_ATTESTED: "true",
  };
  const result = await researchBySpecialty("manual técnico da bateria", {
    env, fetchImpl: mockFetcher(calls),
  });
  assert.ok(result.results.some((x) => x.researcher === "exa"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].target.includes("api.exa.ai"));
});

test("reported environment inventory contains names and presence, never secret values", () => {
  const secret = "ultra-secret-token-not-to-appear";
  const vars = configuredJarvisEnvInventory({
    JARVIS_PROVIDER_2_API_KEY: secret,
    TAVILY_API_KEY: secret,
    GROQ_API_KEY: secret,
    NON_JARVIS_SECRET: secret,
  });
  assert.equal(vars.redacted, true);
  assert.ok(vars.variables.some((x) => x.name === "JARVIS_PROVIDER_2_API_KEY" && x.configured));
  assert.ok(vars.variables.some((x) => x.name === "JARVIS_PROVIDER_3_API_KEY" && !x.configured));
  assert.ok(vars.variables.some((x) => x.name === "TAVILY_API_KEY" && x.configured));
  assert.ok(!JSON.stringify(vars).includes(secret));
  assert.ok(!JSON.stringify(vars).includes("NON_JARVIS_SECRET"));
});

test("research daily allowance reserves at most six calls", async () => {
  let used = 0;
  const pool = { query: async (sql, params) => {
    if (sql.startsWith("CREATE TABLE")) return { rowCount: 0, rows: [] };
    assert.equal(params[1], 6);
    if (used === 6) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ request_count: ++used }] };
  } };
  for (let i = 0; i < 6; i++) assert.equal(
    (await reserveResearchDailyQuota(pool, "phone-id")).accepted, true);
  assert.equal((await reserveResearchDailyQuota(pool, "phone-id")).accepted, false);
});
