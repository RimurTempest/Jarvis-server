"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { createHardenedRunner } = require("./verified-container.cjs");
const { assertWorkerLeadership } = require("./verified-worker-leadership.cjs");

const IMAGE_PATTERN = /^node@sha256:[a-f0-9]{64}$/;
const MODULE_PATTERN = /^jarvis-bridge\/capabilities\/[A-Za-z0-9_/-]+\.(?:cjs|mjs|js)$/;
const TRUSTED_FILES = Object.freeze([
  "jarvis-bridge/ci-test-backend.cjs",
  "jarvis-bridge/test/phase12-contract.test.cjs"
]);

function staticCheck({ worktree, target, files }) {
  const results = [];
  for (const item of files) {
    if (!/\.(cjs|mjs|js)$/.test(item.path)) continue;
    const r = cp.spawnSync(process.execPath,
      ["--check", path.join(worktree, item.path)], {
        cwd: worktree, encoding: "utf8", timeout: 15000, maxBuffer: 30000,
        env: { PATH: process.env.PATH }
      });
    const passed = !r.error && r.status === 0;
    results.push({ file: item.path, kind: "syntax-only", passed });
    if (!passed) throw new Error("Verificacao estatica reprovada.");
  }
  if (target === "android") {
    results.push({ kind: "android-compilation", executed: false,
      reason: "CI Android real obrigatorio." });
  }
  return results;
}

function normalizeGeneratedModules(files) {
  if (!Array.isArray(files) || !files.length || files.length > 6) return null;
  const values = [];
  const seen = new Set();
  for (const item of files) {
    const candidate = item?.path;
    if (typeof candidate !== "string" || !MODULE_PATTERN.test(candidate) ||
        candidate.includes("..") || candidate.includes("//") ||
        seen.has(candidate)) return null;
    seen.add(candidate);
    values.push(candidate);
  }
  return values;
}

function parseTapSummary(output) {
  if (typeof output !== "string" || !output.includes("TAP version 13")) return null;
  const tests = [...output.matchAll(/^# tests (\d+)\s*$/gm)];
  const fails = [...output.matchAll(/^# fail (\d+)\s*$/gm)];
  if (tests.length !== 1 || fails.length !== 1) return null;
  const count = Number(tests[0][1]);
  const failed = Number(fails[0][1]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(failed)) return null;
  return { count, failed };
}

function copyRegular(sourceRoot, relative, destRoot) {
  const source = path.join(sourceRoot, relative);
  const sourceBase = fs.realpathSync(sourceRoot);
  const relativeParts = relative.split("/");
  let current = sourceBase;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || (!st.isDirectory() && current !== source)) {
      throw new Error("Caminho do staging contem link ou arquivo inesperado.");
    }
  }
  const st = fs.lstatSync(source);
  if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 2_000_000) {
    throw new Error("Arquivo do staging recusado.");
  }
  const dest = path.join(destRoot, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o444);
}

function stageForTests({ worktree, files, stagingRoot, trustedRoot }) {
  const repo = fs.realpathSync(worktree);
  const stageRoot = fs.realpathSync(stagingRoot);
  if (!fs.statSync(repo).isDirectory() || !fs.statSync(stageRoot).isDirectory() ||
      stageRoot === repo || stageRoot.startsWith(repo + path.sep) ||
      (fs.statSync(stageRoot).mode & 0o001) === 0) {
    throw new Error("Raiz de staging nao isolada da worktree.");
  }
  const modules = normalizeGeneratedModules(files);
  if (!modules) throw new Error("Modulo candidato invalido.");
  const stage = fs.mkdtempSync(path.join(stageRoot, "jarvis-f13-stage-"));
  try {
    fs.chmodSync(stage, 0o755);
    for (const relative of TRUSTED_FILES) copyRegular(trustedRoot, relative, stage);
    for (const relative of modules) copyRegular(repo, relative, stage);
    return { stage, modules };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A verificacao atual e ESTRUTURAL; jamais autoriza commit como teste funcional.
 * Executor e credenciais permanecem fora dos containers.
 */
async function runIsolatedNodeTests({
  worktree, target, files = [], image = process.env.JARVIS_TEST_IMAGE,
  stagingRoot = process.env.JARVIS_STAGING_ROOT || os.tmpdir(),
  trustedRoot = path.resolve(__dirname, "../trusted-harness"),
  runnerFactory = createSupervisedRunner, signal
}) {
  if (target !== "server") return {
    executed: false, passed: false, functionalValidated: false,
    reason: "Android exige CI com SDK dedicado."
  };
  if (typeof image !== "string" || !IMAGE_PATTERN.test(image)) return {
    executed: false, passed: false, functionalValidated: false,
    reason: "Imagem Docker nao fixada por digest."
  };
  if (!signal || typeof signal.addEventListener !== "function" || signal.aborted) return {
    executed: false, passed: false, functionalValidated: false,
    reason: "Reserva de execução ausente ou cancelada."
  };
  let temp;
  try {
    temp = stageForTests({ worktree, files, stagingRoot, trustedRoot });
    const runner = await runnerFactory({ signal });
    if (typeof runner?.executeAsync !== "function") throw new Error("Runner assíncrono obrigatório.");
    const suite = await runner.executeAsync({
      kind: "suite", stagingRoot, stagingDir: temp.stage, image
    }, { signal });
    const tap = suite.passed ? parseTapSummary(suite.stdout) : null;
    if (!suite.executed || !suite.containerRemoved ||
        !suite.passed || !tap || tap.count === 0 || tap.failed !== 0) {
      return {
        executed: !!suite.executed, passed: false, functionalValidated: false,
        reason: "Teste estrutural TAP nao comprovado."
      };
    }
    const smoke = await runner.executeAsync({
      kind: "smoke", modules: temp.modules,
      stagingRoot, stagingDir: temp.stage, image
    }, { signal });
    const marker = `JARVIS_MODULE_SMOKE=${temp.modules.length}`;
    const loaded = smoke.executed && smoke.passed && smoke.containerRemoved &&
      String(smoke.stdout || "").split("\n").some(x => x.trim() === marker);
    return {
      executed: true, passed: false, functionalValidated: false,
      structuralPassed: !!loaded, testCount: tap.count,
      failedCount: tap.failed,
      moduleSmokeLoaded: loaded ? temp.modules.length : 0,
      reason: loaded
        ? "Sintaxe e carregamento verificados. Teste funcional independente exigido."
        : "Modulo nao passou no carregamento isolado.",
      capabilityLearned: false, runtimeIntegrationVerified: false
    };
  } catch (error) {
    return {
      executed: false, passed: false, functionalValidated: false,
      reason: "Falha de infraestrutura ou staging. Worker bloqueado."
    };
  } finally {
    if (temp?.stage) fs.rmSync(temp.stage, { recursive: true, force: true });
  }
}

async function createSupervisedRunner({ signal }) {
  const workerId = assertWorkerLeadership();
  const runner = createHardenedRunner({
    workerId, assertLeader: () => assertWorkerLeadership()
  });
  await runner.reconcileOrphansAsync(signal);
  return runner;
}

function dockerArgs() {
  throw new Error("API legado dockerArgs removida: use hardened-container.");
}

module.exports = {
  staticCheck, runIsolatedNodeTests, normalizeGeneratedModules,
  parseTapSummary, stageForTests, dockerArgs
};
