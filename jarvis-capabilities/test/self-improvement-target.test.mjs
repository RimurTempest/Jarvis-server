import test from "node:test";
import assert from "node:assert/strict";
import { classifySelfImprovementTarget, resolveSelfImprovementTarget } from "../self-improvement-target.mjs";

test("classifies Android and device capabilities separately from backend work", () => {
  assert.equal(classifySelfImprovementTarget("Adicionar uma função para enviar e-mails pelo celular"), "android");
  assert.equal(classifySelfImprovementTarget("Implementar a ação de fazer ligações no JARVIS"), "android");
  assert.equal(classifySelfImprovementTarget("Adicionar suporte a um endpoint de relatório no servidor"), "server");
});

test("does not fall back to the server repository for Android capabilities", () => {
  const result = resolveSelfImprovementTarget("Enviar e-mails pelo aplicativo", {
    JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
    JARVIS_ANDROID_REPOSITORY: "",
  });
  assert.equal(result.available, false);
  assert.equal(result.target, "android");
  assert.equal(result.repository, null);
  assert.match(result.reason, /JARVIS_ANDROID_REPOSITORY/);
});

test("resolves configured Android and server repositories independently", () => {
  const env = {
    JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
    JARVIS_GITHUB_BASE_BRANCH: "main",
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
    JARVIS_ANDROID_BASE_BRANCH: "develop",
  };
  assert.deepEqual(resolveSelfImprovementTarget("Adicionar endpoint no servidor", env), {
    available: true, target: "server", repository: "RimurTempest/Jarvis-server", baseBranch: "main", reason: null,
  });
  assert.deepEqual(resolveSelfImprovementTarget("Adicionar a função de enviar e-mails pelo app", env), {
    available: true, target: "android", repository: "RimurTempest/Jarvis-android", baseBranch: "develop", reason: null,
  });
});

test("rejects invalid target configuration", () => {
  assert.equal(resolveSelfImprovementTarget("Criar API no servidor", { JARVIS_GITHUB_REPOSITORY: "bad repo" }).available, false);
  assert.equal(resolveSelfImprovementTarget("Adicionar recurso no app", {
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
    JARVIS_ANDROID_BASE_BRANCH: "../main",
  }).available, false);
  assert.throws(() => classifySelfImprovementTarget(""), /goal inválido/);
});
