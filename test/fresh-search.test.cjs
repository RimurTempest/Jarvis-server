"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchFreshWeb, isNewsQuery, topicQuery } = require("../fresh-search.cjs");

function mockResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => typeof data === "string" ? data : JSON.stringify(data)
  };
}
test("classifica noticia temporal e extrai palavras-chave sem tratar pergunta inteira como consulta GDELT", () => {
  assert.equal(isNewsQuery("Flávio Bolsonaro chegou em Miami ontem?"), true);
  assert.equal(topicQuery("Flávio Bolsonaro chegou em Miami ontem?"), "flavio bolsonaro miami");
});
test("busca noticias gratis no GDELT e RSS sem chave Tavily", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("gdeltproject")) return mockResponse({
      articles: [
        { title: "Flávio Bolsonaro chega a Miami", url: "https://jornal.example/1", seendate: "20261028120000" },
        { title: "Outro artigo", url: "javascript:alert(1)" }
      ]
    });
    return mockResponse('<rss><channel><item><title>Flávio Bolsonaro em Miami</title><link>https://agenciabrasil.ebc.com.br/politica/exemplo</link><pubDate>Wed, 28 Oct 2026 11:00:00 GMT</pubDate><description><![CDATA[Notícia sobre Flávio Bolsonaro e Miami.]]></description></item></channel></rss>');
  };
  const result = await searchFreshWeb("Flávio Bolsonaro chegou em Miami ontem?", { fetchImpl, tavilyApiKey: "" });
  assert.equal(result.available, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.find((x) => x.provider === "GDELT" && !x.publishedDate));
  assert.ok(result.results.find((x) => x.provider === "Agencia Brasil"));
  assert.ok(calls.every((x) => !x.includes("api.exa.ai")));
  assert.ok(calls.some((x) => x.includes("timespan=7d")));
});
test("busca geral com Tavily e sem Exa", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return mockResponse({ results: [{ title: "Documentação", url: "https://docs.example/a", content: "Documentação atualizada" }] });
  };
  const result = await searchFreshWeb("pesquise documentação de python", { fetchImpl, tavilyApiKey: "demo" });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].provider, "Tavily");
  assert.match(calls[0][1].headers.Authorization, /^Bearer /);
  assert.equal(JSON.parse(calls[0][1].body).topic, "general");
});
test("nenhum resultado nunca vira desmentido", async () => {
  const fetchImpl = async () => mockResponse({ articles: [] });
  const result = await searchFreshWeb("Notícia de ontem sobre Flávio Bolsonaro", { fetchImpl, tavilyApiKey: "" });
  assert.equal(result.available, false);
  assert.match(result.reason, /NAO significa que o fato seja falso/);
});
test("sem chave nao simula pesquisa web geral", async () => {
  const result = await searchFreshWeb("preço de notebook hoje?", { fetchImpl: () => { throw Error("Nao deveria consultar"); }, tavilyApiKey: "" });
  assert.equal(isNewsQuery("preço de notebook hoje?"), false);
  assert.equal(result.attempted, false);
  assert.equal(result.available, false);
});
