"use strict";

const path = require("node:path");
const fs = require("node:fs");
const cp = require("node:child_process");
const { verifyRepo } = require("./dev-workspace.cjs");

const REQUIRED = Object.freeze([
  "JARVIS_BRIDGE_API_URL", "JARVIS_CI_RUNNER_TOKEN",
  "OPENAI_API_KEY", "JARVIS_TEST_IMAGE",
  "JARVIS_ANDROID_DEV_REPO", "JARVIS_SERVER_DEV_REPO",
  "JARVIS_WORKTREES_DIR"
]);
const PROHIBITED = Object.freeze([
  "DATABASE_URL", "JARVIS_API_TOKEN",
  "JARVIS_OWNER_API_TOKEN", "JARVIS_OWNER_TOKEN",
  "JARVIS_ANDROID_SIGNING_KEY", "ANDROID_KEYSTORE_PASSWORD",
  "GITHUB_TOKEN", "GH_TOKEN",
  "JARVIS_EVOLUTION_ADMIN_TOKEN", "JARVIS_EVOLUTION_OWNER_TOKEN"
]);
function buildWorkerPreflight({
  env = process.env, spawn = cp.spawnSync, uid = process.getuid?.()
} = {}) {
  const checks = [];
  function add(name, ok, detail) {
    checks.push({ name, passed: !!ok, detail });
  }
  add("ativação explícita", env.JARVIS_AUTODEV_ENABLED === "1",
    "Exige JARVIS_AUTODEV_ENABLED=1");
  for (const key of REQUIRED) {
    const value = env[key];
    const ok = typeof value === "string" && value.trim().length >=
      (key.endsWith("_TOKEN") || key === "OPENAI_API_KEY" ? 32 : 1);
    add(`configuração ${key}`, ok, ok ? "presente" : "ausente ou inválida");
  }
  for (const key of PROHIBITED) {
    add(`separação de segredo ${key}`, !env[key],
      env[key] ? "credencial de outro serviço presente no worker" : "não presente");
  }
  add("processo não privilegiado", uid !== 0, "Worker não deve rodar como root.");
  let endpointOk = false;
  try {
    const u = new URL(env.JARVIS_BRIDGE_API_URL);
    endpointOk = u.protocol === "https:" && !u.username && !u.password &&
      !u.search && !u.hash;
  } catch {}
  add("endpoint autenticado em HTTPS", endpointOk, "Exige HTTPS sem credenciais na URL.");
  add("digest de imagem aprovado",
    /^node@sha256:[a-f0-9]{64}$/.test(env.JARVIS_TEST_IMAGE || ""),
    "Imagem deve estar fixada por digest.");
  const workspace = env.JARVIS_WORKTREES_DIR;
  let root = null;
  try {
    root = fs.realpathSync(workspace);
    if (root === "/" || root === fs.realpathSync(require("node:os").homedir()) ||
        !fs.statSync(root).isDirectory()) root = null;
  } catch {}
  add("worktrees existentes", !!root, "Pasta deve existir fora do diretório pessoal.");
  for (const key of ["JARVIS_ANDROID_DEV_REPO", "JARVIS_SERVER_DEV_REPO"]) {
    let valid = false;
    try {
      const repo = verifyRepo(env[key]);
      valid = !!root && repo.base !== root &&
        !root.startsWith(repo.base + path.sep) &&
        !repo.base.startsWith(root + path.sep);
    } catch {}
    add(`checkout Git isolado ${key}`, valid,
      "Exige branch work/* limpa e worktrees em diretório separado.");
  }
  function runDocker(args) {
    try {
      return spawn("docker", args, {
        encoding: "utf8", timeout: 12000, maxBuffer: 6000,
        env: { PATH: env.PATH || process.env.PATH,
          HOME: "/nonexistent", DOCKER_CONFIG: "/nonexistent" }
      });
    } catch {
      return { status: null };
    }
  }
  const daemon = runDocker(["info", "--format", "{{json .SecurityOptions}}"]);
  const dockerReady = !daemon.error && daemon.status === 0;
  add("daemon Docker", dockerReady, "Docker precisa responder antes de gerar código.");
  let rootless = false;
  if (dockerReady) {
    try {
      const opts = JSON.parse(daemon.stdout || "[]");
      rootless = Array.isArray(opts) && opts.some(v => String(v).includes("rootless"));
    } catch {}
  }
  add("isolamento rootless Docker", rootless,
    "Exige Docker rootless no worker dedicado; acesso ao docker.sock rootful não é isolamento suficiente.");
  const image = dockerReady && /^node@sha256:[a-f0-9]{64}$/.test(env.JARVIS_TEST_IMAGE || "")
    ? runDocker(["image", "inspect", env.JARVIS_TEST_IMAGE]) : { status: null };
  add("imagem Docker local", image.status === 0,
    "Imagem fixada deve ser pré-carregada (sem pull de código não confiável).");
  return { ok: checks.every(c => c.passed), checks,
    liveAiInvoked: false, sandboxTestsExecuted: false,
    productionModified: false };
}
function assertWorkerReady(options) {
  const report = buildWorkerPreflight(options);
  if (!report.ok) {
    const names = report.checks.filter(c => !c.passed).map(c => c.name);
    throw new Error("Preflight recusado: " + names.join("; "));
  }
  return report;
}
if (require.main === module) {
  const result = buildWorkerPreflight();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}
module.exports = { buildWorkerPreflight, assertWorkerReady };
