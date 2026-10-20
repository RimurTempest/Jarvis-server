import test from "node:test";
import assert from "node:assert/strict";
import { parseCapabilityIntentClassification, shouldClassifyCapabilityIntent } from "../capability-intent-classifier.mjs";

test("recognizes common Portuguese and English execution requests", () => {
  assert.equal(shouldClassifyCapabilityIntent("Pode enviar um e-mail para mim?"), true);
  assert.equal(shouldClassifyCapabilityIntent("Quero que você faça uma ligação."), true);
  assert.equal(shouldClassifyCapabilityIntent("Manda um e-mail para alguém"), true);
  assert.equal(shouldClassifyCapabilityIntent("Please schedule the appointment for me."), true);
  assert.equal(shouldClassifyCapabilityIntent("Can you install and configure this app?"), true);
});

test("does not classify informational questions or ordinary statements", () => {
  assert.equal(shouldClassifyCapabilityIntent("Como eu faço para enviar um e-mail?"), false);
  assert.equal(shouldClassifyCapabilityIntent("Me explique como funciona uma ligação VoIP."), false);
  assert.equal(shouldClassifyCapabilityIntent("Pode me explicar como enviar uma mensagem?"), false);
  assert.equal(shouldClassifyCapabilityIntent("Recebi um e-mail ontem."), false);
  assert.equal(shouldClassifyCapabilityIntent("Boa tarde, tudo bem?"), false);
  assert.equal(shouldClassifyCapabilityIntent(""), false);
});

test("parses and normalizes positive and negative decisions", () => {
  assert.deepEqual(parseCapabilityIntentClassification('{"shouldResearch":true,"goal":"enviar e-mails com autorização do usuário."}'), {
    shouldResearch: true, goal: "enviar e-mails com autorização do usuário"
  });
  assert.deepEqual(parseCapabilityIntentClassification('{"shouldResearch":false,"goal":null}'), {
    shouldResearch: false, goal: null
  });
});

test("fails closed on malformed, oversized, or unsafe classifier output", () => {
  assert.equal(parseCapabilityIntentClassification("not JSON"), null);
  assert.equal(parseCapabilityIntentClassification('{"shouldResearch":"yes","goal":"enviar e-mails"}'), null);
  assert.equal(parseCapabilityIntentClassification('{"shouldResearch":true,"goal":"x"}'), null);
  assert.equal(parseCapabilityIntentClassification("x".repeat(4001)), null);
  assert.equal(parseCapabilityIntentClassification('{"shouldResearch":true,"goal":"send to someone@example.com"}'), null);
  assert.equal(parseCapabilityIntentClassification('{"shouldResearch":true,"goal":"use api_key=secret123"}'), null);
});

test("recognizes broader natural-language capability requests without learn/research keywords", () => {
  const requests = [
    "Quero que você encontre informações oficiais sobre esse serviço.",
    "Preciso que você pesquise opções para automatizar meus relatórios.",
    "Pode verificar se existe uma forma de sincronizar meus arquivos?",
    "Gostaria que você analisasse esses dados e preparasse um resumo.",
    "Me ajuda a descobrir como agendar compromissos automaticamente?",
    "Você consegue monitorar quando sair uma nova versão?",
    "Por favor, identifique uma maneira segura de digitalizar esses documentos.",
    "I need you to find and compare free ways to automate this workflow.",
    "Could you monitor the release and notify me when it is available?",
  ];

  for (const request of requests) {
    assert.equal(shouldClassifyCapabilityIntent(request), true, request);
  }
});

test("keeps broad informational and learning questions out of capability execution", () => {
  const questions = [
    "Como posso pesquisar opções para automatizar meus relatórios?",
    "Me explique como funciona o monitoramento de versões.",
    "Quero aprender a analisar esses dados.",
    "What is the best way to monitor software releases?",
    "Teach me how to compare these services.",
    "Recebi um relatório e pesquisei sobre o assunto ontem.",
  ];

  for (const question of questions) {
    assert.equal(shouldClassifyCapabilityIntent(question), false, question);
  }
});
