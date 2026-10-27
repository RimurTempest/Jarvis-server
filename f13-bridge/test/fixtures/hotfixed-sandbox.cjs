"use strict";

const path = require("node:path");
const cp = require("node:child_process");

const IMAGE_PATTERN = /^node@sha256:[a-f0-9]{64}$/;
const MODULE_PATTERN = /^jarvis-bridge\/capabilities\/[A-Za-z0-9_/-]+\.(?:cjs|mjs|js)$/;

function staticCheck({ worktree, target, files }) {
  const results = [];
  for (const file of files) {
    if (!/\.(cjs|mjs|js)$/.test(file.path)) continue;
    const check = cp.spawnSync(process.execPath, ["--check", path.join(worktree, file.path)], {
      cwd: worktree, encoding: "utf8", timeout: 15000,
      maxBuffer: 30_000, env: { PATH: process.env.PATH }
    });
    const passed = !check.error && check.status === 0;
    results.push({ file: file.path, passed, kind: "syntax-only" });
    if (!passed) throw new Error("Verificação estática reprovada: " + file.path);
  }
  if (target === "android") {
    results.push({ kind: "android-compilation", executed: false,
      reason: "Somente CI Android com SDK poderá comprovar compilação Kotlin." });
  }
  return results;
}

function normalizeGeneratedModules(files) {
  if (!Array.isArray(files) || !files.length || files.length > 6) return null;
  const unique = new Set();
  for (const item of files) {
    const file = item?.path;
    if (typeof file !== "string" || !MODULE_PATTERN.test(file) ||
        file.includes("..") || file.includes("//") || unique.has(file)) {
      return null;
    }
    unique.add(file);
  }
  return [...unique];
}

function dockerArgs(cwd, image, command) {
  // JARVIS_LEGACY_DOCKER_DISABLED_V1: impedir chamadas diretas ao builder inseguro.
  throw new Error("JARVIS_LEGACY_DOCKER_DISABLED_V1: dockerArgs legado nao pode ser utilizado.");

  return [
    "run", "--rm", "--pull=never", "--network=none",
    "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
    "--pids-limit=96", "--memory=768m", "--memory-swap=768m", "--cpus=1",
    "--read-only", "--user=65534:65534",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--mount", `type=bind,source=${cwd},target=/workspace,readonly`,
    "--workdir", "/workspace", image, ...command
  ];
}

const MODULE_SMOKE = [
  '"use strict";',
  'const {pathToFileURL}=require("node:url");',
  'const path=require("node:path");',
  '(async()=>{',
  'const files=process.argv.slice(1);',
  'if(!files.length)throw new Error("Sem módulos gerados");',
  'for(const file of files){',
  'if(!/^jarvis-bridge\\/capabilities\\/[A-Za-z0-9_/-]+\\.(cjs|js|mjs)$/.test(file)||file.includes(".."))',
  'throw new Error("Módulo inválido");',
  'await import(pathToFileURL(path.resolve(file)).href);',
  '}',
  'console.log("JARVIS_MODULE_SMOKE="+files.length);',
  '})().catch(()=>{process.exitCode=1;});'
].join("\n");

function parseTapSummary(output) {
  if (typeof output !== "string" || !output.includes("TAP version 13")) return null;
  const tests = [...output.matchAll(/^# tests (\d+)\s*$/gm)];
  const fail = [...output.matchAll(/^# fail (\d+)\s*$/gm)];
  if (tests.length !== 1 || fail.length !== 1) return null;
  const count = Number(tests[0][1]);
  const failed = Number(fail[0][1]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(failed)) return null;
  return { count, failed };
}

function runIsolatedNodeTests({
  worktree, target, files = [], image = process.env.JARVIS_TEST_IMAGE,
  spawn = cp.spawnSync
}) {
  // JARVIS_LEGACY_DOCKER_DISABLED_V1: fail closed ate integracao do runner rootless.
  return {
    executed: false,
    passed: false,
    functionalValidated: false,
    structuralPassed: false,
    runtimeIntegrationVerified: false,
    capabilityLearned: false,
    reason: "JARVIS_LEGACY_DOCKER_DISABLED_V1: runner legado bloqueado; sandbox reforcado ainda nao integrado."
  };

  if (target !== "server") {
    return { executed: false, passed: false, reason: "Android exige CI Gradle dedicado." };
  }
  if (typeof image !== "string" || !IMAGE_PATTERN.test(image)) {
    return { executed: false, passed: false,
      reason: "JARVIS_TEST_IMAGE deve conter um digest SHA256 aprovado." };
  }
  const modules = normalizeGeneratedModules(files);
  if (!modules) {
    return { executed: false, passed: false,
      reason: "Não há módulos de capacidade válidos para verificar." };
  }
  const cwd = path.resolve(worktree);
  function invoke(command) {
    try {
      return spawn("docker", dockerArgs(cwd, image, command), {
        cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 80_000,
        env: { PATH: process.env.PATH, HOME: "/nonexistent",
          DOCKER_CONFIG: "/nonexistent" }
      });
    } catch {
      return { error: new Error("Executor Docker indisponível.") };
    }
  }
  const suite = invoke(["node", "jarvis-bridge/ci-test-backend.cjs"]);
  if (suite.error || suite.signal || suite.status === null || suite.status === 125 ||
      suite.status === 126 || suite.status === 127) {
    return { executed: false, passed: false, reason: "Falha de infraestrutura Docker." };
  }
  const tap = parseTapSummary(suite.stdout);
  if (!tap) {
    return { executed: false, passed: false,
      reason: "Não foi possível confirmar execução da suíte TAP de testes." };
  }
  if (tap.count === 0 || tap.failed > 0 || suite.status !== 0) {
    return { executed: true, passed: false, testCount: tap.count,
      failedCount: tap.failed, reason: "Suíte de testes local reprovada.",
      output: String(suite.stdout || "").slice(-2000) };
  }
  const smoke = invoke(["node", "-e", MODULE_SMOKE, ...modules]);
  const marker = `JARVIS_MODULE_SMOKE=${modules.length}`;
  const loaded = !smoke.error && !smoke.signal && smoke.status === 0 &&
    String(smoke.stdout || "").split("\n").some(line => line.trim() === marker);
  return {
    executed: true, passed: loaded,
    testCount: tap.count, failedCount: tap.failed,
    moduleSmokeLoaded: loaded ? modules.length : 0,
    reason: loaded ? "Verificações locais concluídas; comportamento não comprovado." :
      "Módulos novos não passaram no teste de carregamento isolado.",
    output: String(loaded ? suite.stdout : smoke.stdout || "").slice(-2000),
    runtimeIntegrationVerified: false,
    capabilityLearned: false
  };
}

module.exports = {
  staticCheck, runIsolatedNodeTests, normalizeGeneratedModules,
  parseTapSummary, dockerArgs
};
