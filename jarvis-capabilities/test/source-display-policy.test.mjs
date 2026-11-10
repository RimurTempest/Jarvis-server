import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowSources } from "../source-display-policy.mjs";

test("does not show source lists during ordinary conversation or research requests", () => {
  assert.equal(shouldShowSources("Pesquise como funciona a integração de e-mail."), false);
  assert.equal(shouldShowSources("Explique isso com suas próprias palavras."), false);
  assert.equal(shouldShowSources("Não quero fontes, só me dê a resposta."), false);
  assert.equal(shouldShowSources("Responda sem citações nem links."), false);
  assert.equal(shouldShowSources("Não cite as fontes automaticamente."), false);
});

test("shows source lists only when the user explicitly asks for them", () => {
  assert.equal(shouldShowSources("Quais são as fontes?"), true);
  assert.equal(shouldShowSources("Me mostre as fontes consultadas."), true);
  assert.equal(shouldShowSources("Traga os links das referências."), true);
  assert.equal(shouldShowSources("Fontes"), true);
});

test("source request detection is accent-insensitive and rejects empty input", () => {
  assert.equal(shouldShowSources("Quais são as referências?"), true);
  assert.equal(shouldShowSources("Sem referências, por favor."), false);
  assert.equal(shouldShowSources("   "), false);
});
