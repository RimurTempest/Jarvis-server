import test from "node:test";
import assert from "node:assert/strict";
import { detectExplicitLearning } from "../explicit-learning.mjs";

test("captures an explicit preference about interpreting future requests", () => {
  const result = detectExplicitLearning("Quero que você entenda melhor minhas intenções nas próximas conversas.");
  assert.equal(result?.type, "explicit_preference");
  assert.equal(result?.category, "preferencia");
});

test("captures corrections as feedback without promoting them to permanent facts", () => {
  const result = detectExplicitLearning("Não foi isso que eu pedi; eu queria enviar um e-mail.");
  assert.equal(result?.type, "user_correction");
  assert.equal(result?.category, null);
});

test("does not treat a one-off action as a persistent preference", () => {
  assert.equal(detectExplicitLearning("Abra o WhatsApp."), null);
  assert.equal(detectExplicitLearning("A partir de agora, abra o WhatsApp."), null);
});

test("routes capability learning requests to the capability-learning pipeline", () => {
  assert.equal(detectExplicitLearning("Quero que você aprenda a enviar e-mails."), null);
});

test("recognizes a durable preference that describes future behavior", () => {
  const result = detectExplicitLearning("A partir de agora, quando eu pedir algo, quero que você pesquise e implemente.");
  assert.equal(result?.type, "explicit_preference");
});

test("does not automatically store sensitive content", () => {
  assert.equal(detectExplicitLearning("Prefiro usar esta API key: abcdefghijklmnopqrstuvwxyz"), null);
});
