import test from "node:test";
import assert from "node:assert/strict";
import { classifySelfImprovementTarget, resolveSelfImprovementTarget, requiredWorkflowsForRepository } from "../self-improvement-target.mjs";

test("classifies Android and device capabilities separately from backend work", () => {
  assert.equal(classifySelfImprovementTarget("Adicionar uma função para enviar e-mails pelo celular"), "android");
  assert.equal(classifySelfImprovementTarget("Implementar a ação de fazer ligações no JARVIS"), "android");
  assert.equal(classifySelfImprovementTarget("Adicionar suporte a um endpoint de relatório no servidor"), "server");
  assert.equal(classifySelfImprovementTarget("Adicionar endpoint para enviar e-mails pelo aplicativo Android"), "full_stack");
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
  const fullStack = resolveSelfImprovementTarget("Add an email endpoint for the Android app", {
    JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
  });
  assert.equal(fullStack.available, false);
  assert.equal(fullStack.target, "full_stack");
  assert.match(fullStack.reason, /JARVIS_FULL_STACK_REPOSITORY/);
});

test("resolves configured Android and server repositories independently", () => {
  const env = {
    JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
    JARVIS_GITHUB_BASE_BRANCH: "main",
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
    JARVIS_ANDROID_BASE_BRANCH: "develop",
    JARVIS_FULL_STACK_REPOSITORY: "RimurTempest/Jarvis-monorepo",
    JARVIS_FULL_STACK_BASE_BRANCH: "main",
  };
  assert.deepEqual(resolveSelfImprovementTarget("Adicionar endpoint no servidor", env), {
    available: true, target: "server", repository: "RimurTempest/Jarvis-server", baseBranch: "main", reason: null,
  });
  assert.deepEqual(resolveSelfImprovementTarget("Adicionar a função de enviar e-mails pelo app", env), {
    available: true, target: "android", repository: "RimurTempest/Jarvis-android", baseBranch: "develop", reason: null,
  });
  assert.deepEqual(resolveSelfImprovementTarget("Adicionar endpoint para enviar e-mails pelo aplicativo Android", env), {
    available: true, target: "full_stack", repository: "RimurTempest/Jarvis-monorepo", baseBranch: "main", reason: null,
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

test("uses Android CI workflow names only for the configured Android repository", () => {
  const env = {
    JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
  };
  assert.equal(requiredWorkflowsForRepository("RimurTempest/Jarvis-server", env), null);
  assert.deepEqual(requiredWorkflowsForRepository("RimurTempest/Jarvis-android", env), ["JARVIS Android Build and Tests"]);
  assert.deepEqual(requiredWorkflowsForRepository("RimurTempest/Jarvis-android", {
    ...env,
    JARVIS_ANDROID_REQUIRED_WORKFLOWS: "Android Unit Tests, APK Debug Build",
  }), ["Android Unit Tests", "APK Debug Build"]);
  assert.deepEqual(requiredWorkflowsForRepository("RimurTempest/Jarvis-monorepo", {
    JARVIS_FULL_STACK_REPOSITORY: "RimurTempest/Jarvis-monorepo",
  }), ["JARVIS Capability Tests", "JARVIS Android Build and Tests"]);
  assert.deepEqual(requiredWorkflowsForRepository("RimurTempest/Jarvis-monorepo", {
    JARVIS_FULL_STACK_REPOSITORY: "RimurTempest/Jarvis-monorepo",
    JARVIS_FULL_STACK_REQUIRED_WORKFLOWS: "Backend Tests,Android APK Build,Integration Tests",
  }), ["Backend Tests", "Android APK Build", "Integration Tests"]);
});

test("rejects malformed Android CI workflow configuration", () => {
  assert.throws(() => requiredWorkflowsForRepository("RimurTempest/Jarvis-android", {
    JARVIS_ANDROID_REPOSITORY: "RimurTempest/Jarvis-android",
    JARVIS_ANDROID_REQUIRED_WORKFLOWS: "Android Unit Tests,,APK Build",
  }), /nomes únicos/i);
  assert.throws(() => requiredWorkflowsForRepository("RimurTempest/Jarvis-monorepo", {
    JARVIS_FULL_STACK_REPOSITORY: "RimurTempest/Jarvis-monorepo",
    JARVIS_FULL_STACK_REQUIRED_WORKFLOWS: "Backend Tests,Backend Tests",
  }), /nomes únicos/i);
});
