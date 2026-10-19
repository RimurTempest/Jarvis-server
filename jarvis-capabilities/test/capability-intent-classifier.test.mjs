import test from "node:test";
import assert from "node:assert/strict";
import { classifyCapabilityIntent } from "../capability-intent-classifier.mjs";

function providerReturning(payload) {
  return {
    model: "test-model",
    client: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        },
      },
    },
  };
}

test("classifies an implied unsupported action using the user's intent", async () => {
  const result = await classifyCapabilityIntent({
    provider: providerReturning({ intent: "create_capability", goal: "enviar e-mails de forma segura", confidence: 0.94 }),
    message: "Quero que você mande esse relatório por e-mail quando estiver pronto.",
    history: [{ role: "assistant", content: "Ainda não consigo enviar e-mails diretamente." }],
  });
  assert.deepEqual(result, { intent: "create_capability", goal: "enviar e-mails de forma segura", confidence: 0.94 });
});

test("does not classify an ordinary question as a capability request", async () => {
  const result = await classifyCapabilityIntent({
    provider: providerReturning({ intent: "not_capability", goal: null, confidence: 1 }),
    message: "O que é SMTP?",
  });
  assert.deepEqual(result, { intent: "not_capability", goal: null, confidence: 1 });
});

test("rejects low-confidence or vague capability goals", async () => {
  assert.equal(await classifyCapabilityIntent({
    provider: providerReturning({ intent: "create_capability", goal: "isso", confidence: 0.99 }),
    message: "Faça isso",
  }), null);
  assert.equal(await classifyCapabilityIntent({
    provider: providerReturning({ intent: "create_capability", goal: "enviar e-mails", confidence: 0.7 }),
    message: "Mande um e-mail",
  }), null);
});

test("falls back safely when the model returns invalid JSON or fails", async () => {
  const invalidProvider = {
    model: "test-model",
    client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: "not-json" } }] }) } } },
  };
  assert.equal(await classifyCapabilityIntent({ provider: invalidProvider, message: "Bom dia" }), null);
  assert.equal(await classifyCapabilityIntent({ provider: null, message: "Bom dia" }), null);
});

test("passes recent conversation and active capabilities to the classifier", async () => {
  let request;
  const provider = {
    model: "test-model",
    client: { chat: { completions: { create: async (payload) => {
      request = payload;
      return { choices: [{ message: { content: JSON.stringify({ intent: "create_capability", goal: "agendar reuniões", confidence: 0.9 }) } }] };
    } } } },
  };
  await classifyCapabilityIntent({
    provider,
    message: "Sim, implemente isso",
    history: [{ role: "assistant", content: "Posso preparar uma capacidade para agendar reuniões." }],
    activeCapabilities: [{ state: "researching", goal: "agendar reuniões" }],
  });
  assert.match(request.messages[1].content, /agendar reuniões/);
  assert.match(request.messages[1].content, /MENSAGEM ATUAL DO USUÁRIO/);
});

test("redacts secrets and personal identifiers before sending conversation context", async () => {
  let request;
  const provider = {
    model: "test-model",
    client: { chat: { completions: { create: async (payload) => {
      request = payload;
      return { choices: [{ message: { content: JSON.stringify({ intent: "not_capability", goal: null, confidence: 1 }) } }] };
    } } } },
  };
  await classifyCapabilityIntent({
    provider,
    message: "Use api_key=sk-supersecret123 and contact maria@example.com",
    history: [{ role: "user", content: "Bearer abcdefghijklmnopqrstuvwxyz123" }],
  });
  const context = request.messages[1].content;
  assert.doesNotMatch(context, /sk-supersecret123/);
  assert.doesNotMatch(context, /maria@example.com/);
  assert.doesNotMatch(context, /abcdefghijklmnopqrstuvwxyz123/);
  assert.match(context, /redigido|removido/);
});
