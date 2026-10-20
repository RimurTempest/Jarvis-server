import test from "node:test";
import assert from "node:assert/strict";
import { detectCapabilityLearningRequest } from "../learning-intent.mjs";

test("detects a generic Portuguese learning request", () => {
  assert.deepEqual(detectCapabilityLearningRequest("Aprenda a fazer uma tarefa nova no Android."), {
    goal: "uma tarefa nova no Android",
    originalRequest: "Aprenda a fazer uma tarefa nova no Android.",
  });
});

test("detects requests with a leading assistant name and different verbs", () => {
  assert.equal(detectCapabilityLearningRequest("JARVIS, aprenda a executar uma rotina de trabalho.").goal, "uma rotina de trabalho");
  assert.equal(detectCapabilityLearningRequest("Quero que você aprenda a fazer uma tarefa nova.").goal, "uma tarefa nova");
  assert.equal(detectCapabilityLearningRequest("Aprenda como usar um recurso do sistema").goal, "um recurso do sistema");
});

test("detects direct capability requests phrased as becoming able to do something", () => {
  assert.equal(detectCapabilityLearningRequest("Quero que você consiga enviar e-mails.").goal, "enviar e-mails");
  assert.equal(detectCapabilityLearningRequest("Quero que você possa realizar chamadas.").goal, "realizar chamadas");
  assert.equal(detectCapabilityLearningRequest("Preciso que você seja capaz de integrar uma API."), null);
  assert.equal(detectCapabilityLearningRequest("I want you to be able to send emails.").goal, "send emails");
});

test("detects English requests without task-specific shortcuts", () => {
  assert.equal(detectCapabilityLearningRequest("Learn how to organize files.").goal, "organize files");
});

test("does not mistake ordinary questions or teaching requests for learning commands", () => {
  assert.equal(detectCapabilityLearningRequest("Como faço para organizar arquivos?"), null);
  assert.equal(detectCapabilityLearningRequest("Me ensine a organizar arquivos."), null);
  assert.equal(detectCapabilityLearningRequest("Aprenda"), null);
});

test("rejects empty, oversized, and vague goals", () => {
  assert.equal(detectCapabilityLearningRequest(" "), null);
  assert.equal(detectCapabilityLearningRequest("Aprenda a fazer isso."), null);
  assert.equal(detectCapabilityLearningRequest("Aprenda a fazer " + "x".repeat(4000)), null);
});
