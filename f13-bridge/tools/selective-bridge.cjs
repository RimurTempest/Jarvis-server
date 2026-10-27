#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const PREFIX = "homolog-phase13-client/fase13-original";
const RELATIVE = `${PREFIX}/worker/sandbox-tests.cjs`;
const SOURCE = path.resolve(__dirname, "..");
const MARKER = "JARVIS_LEGACY_DOCKER_DISABLED_V1";
const BRIDGE_MARKER = "JARVIS_ROOTLESS_BRIDGE_V1";
const ORIGINAL_GUARD = `
  // ${MARKER}: fail closed ate integracao do runner rootless.
  return {
    executed: false,
    passed: false,
    functionalValidated: false,
    structuralPassed: false,
    runtimeIntegrationVerified: false,
    capabilityLearned: false,
    reason: "${MARKER}: runner legado bloqueado; sandbox reforcado ainda nao integrado."
  };
`;
const NEW_GUARD = `
  // ${BRIDGE_MARKER}: delega exclusivamente ao novo sandbox, que exige rootless.
  return require("./verified-sandbox-entry.cjs").runVerifiedSandbox(arguments[0]);
`;
const FILES = [
  "worker/verified-container.cjs",
  "worker/cancellable-process.cjs",
  "worker/verified-worker-leadership.cjs",
  "worker/verified-sandbox.cjs",
  "worker/verified-sandbox-entry.cjs",
  "trusted-harness/jarvis-bridge/ci-test-backend.cjs",
  "trusted-harness/jarvis-bridge/test/phase12-contract.test.cjs",
  "rootless/verified-supervise-worker.sh"
];

function insist(predicate, message) {
  if (!predicate) throw Error(message);
}

function sha(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    `Arquivo regular e sem hardlinks exigido: ${filename}`);
  return stat;
}

function targetInfo(root) {
  const target = path.join(root, RELATIVE);
  regularFile(target);
  const worker = path.join(root, PREFIX, "worker/evolution-worker.cjs");
  const evolution = fs.readFileSync(worker, "utf8");
  insist(/\brequire\s*\(\s*["']\.\/sandbox-tests\.cjs["']\s*\)/.test(evolution) &&
    /\btestRunner\s*=\s*runIsolatedNodeTests\b/.test(evolution),
    "Caminho evolution-worker -> sandbox-tests desconhecido; recusado.");
  return {target, content: fs.readFileSync(target, "utf8")};
}

function inspectText(content) {
  const originalCount = content.split(ORIGINAL_GUARD).length - 1;
  const bridgeCount = content.split(NEW_GUARD).length - 1;
  insist(originalCount + bridgeCount === 1,
    "Hotfix ausente, duplicado ou divergente: nao modificar.");
  const legacy = content.match(/function\s+dockerArgs\s*\([^)]{0,300}\)\s*\{/);
  insist(legacy, "dockerArgs legado ausente: estrutura diferente.");
  const legacyBody = content.slice(legacy.index + legacy[0].length,
    legacy.index + legacy[0].length + 260);
  insist(legacyBody.includes(MARKER) &&
    legacyBody.includes("throw new Error"),
    "dockerArgs legado nao esta bloqueado.");
  const entry = content.match(/(?:async\s+)?function\s+runIsolatedNodeTests\s*\(\s*\{[\s\S]{0,1200}?\}\s*\)\s*\{/);
  insist(entry, "Entrada do sandbox nao encontrada.");
  const beginning = content.slice(entry.index + entry[0].length,
    entry.index + entry[0].length + 500);
  insist(beginning.includes(originalCount ? ORIGINAL_GUARD.trim() : NEW_GUARD.trim()),
    "A primeira instrucao do runner nao e o guard conhecido.");
  return {originalCount, bridgeCount};
}

function ensureDestinations(root) {
  for (const item of FILES) {
    const relative = `${PREFIX}/${item}`;
    const src = path.join(SOURCE, item);
    regularFile(src);
    const dest = path.join(root, relative);
    if (fs.existsSync(dest)) {
      regularFile(dest);
      insist(sha(fs.readFileSync(src)) === sha(fs.readFileSync(dest)),
        `Arquivo divergente; nao sobrescrever: ${relative}`);
    }
  }
}

function backupDirectory(root, dest) {
  insist(dest && path.isAbsolute(dest), "Backup fora da worktree precisa ser absoluto.");
  const normal = path.resolve(dest);
  insist(normal !== root && !normal.startsWith(root + path.sep),
    "Backup dentro da worktree nao permitido.");
  if (fs.existsSync(normal)) {
    const stat = fs.lstatSync(normal);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), "Diretorio backup invalido.");
  } else {
    fs.mkdirSync(normal, {mode: 0o700});
  }
  return normal;
}

function checkJS(filename) {
  cp.execFileSync(process.execPath, ["--check", filename], {
    stdio: "pipe", timeout: 10000
  });
}

function apply(root, target, content, backupArg) {
  const state = inspectText(content);
  insist(state.originalCount === 1, "Bridge ja aplicado.");
  ensureDestinations(root);
  const backupDir = backupDirectory(root, backupArg);
  const backup = path.join(backupDir, `sandbox-bridge.${sha(content).slice(0,16)}.cjs`);
  insist(!fs.existsSync(backup), `Backup ja existe: ${backup}`);
  const next = content.replace(ORIGINAL_GUARD, NEW_GUARD);
  const temp = `${target}.jarvis-bridge-${process.pid}.cjs`;
  const created = [];
  let swapped = false;
  const originalMode = fs.statSync(target).mode & 0o777;
  try {
    fs.writeFileSync(temp, next, {flag:"wx",mode:0o600});
    checkJS(temp);
    inspectText(next);
    for (const item of FILES) {
      const dest = path.join(root, PREFIX, item);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), {recursive: true, mode: 0o755});
      fs.copyFileSync(path.join(SOURCE, item), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, dest.endsWith(".sh") ? 0o755 : 0o644);
      created.push(dest);
      if (dest.endsWith(".cjs")) checkJS(dest);
    }
    insist(fs.readFileSync(target,"utf8") === content,
      "Arquivo alterado durante instalacao; abortado.");
    fs.writeFileSync(backup, content, {flag:"wx",mode:0o600});
    fs.renameSync(temp, target);
    swapped = true;
    fs.chmodSync(target, originalMode);
    console.log("BRIDGE_APPLIED", target);
    console.log("BACKUP", backup);
    console.log("PRODUCTION_UNCHANGED sandbox ainda bloqueado sem rootless.");
  } catch (error) {
    if (!swapped) {
      for (const dest of created.reverse()) {
        try { fs.rmSync(dest); } catch {}
      }
    }
    throw error;
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp);
  }
}

function verify(root, content) {
  insist(inspectText(content).bridgeCount === 1, "Bridge nao esta ativo.");
  ensureDestinations(root);
  const active = require(path.join(root, PREFIX, "worker/sandbox-tests.cjs"));
  insist(typeof active.runIsolatedNodeTests === "function" &&
    typeof active.dockerArgs === "function", "Entradas publicas desconhecidas.");
  let thrown = false;
  try { active.dockerArgs(); } catch { thrown = true; }
  insist(thrown, "dockerArgs antigo acessivel.");
  return active.runIsolatedNodeTests({
    target: "server", worktree: root, files: []
  }).then(r => {
    insist(r?.executed === false && r?.passed === false &&
      r?.functionalValidated === false,
      "Nao houve falha segura na ausencia do perfil operacional.");
    console.log("PASS BRIDGE_ACTIVE_LEGACY_DISABLED EXECUTION_BLOCKED");
  });
}

async function main() {
  const [mode, base, backupArg] = process.argv.slice(2);
  insist(["--check","--apply","--verify"].includes(mode) && base,
    "Uso: node selective-bridge.cjs --check|--apply|--verify WORKTREE [BACKUP_DIR]");
  const root = fs.realpathSync(base);
  const {target,content} = targetInfo(root);
  const state = inspectText(content);
  ensureDestinations(root);
  if (mode === "--check") {
    console.log(state.bridgeCount ? "BRIDGE_ALREADY_PRESENT" : "BRIDGE_READY", sha(content));
    console.log("TARGET", target);
    console.log("ADDITIONAL_FILES", FILES.length);
  } else if (mode === "--apply") {
    apply(root, target, content, backupArg);
  } else {
    await verify(root, content);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("FAIL_CLOSED", error.message);
    process.exitCode = 1;
  });
}
module.exports = {inspectText, ensureDestinations, sha, ORIGINAL_GUARD, NEW_GUARD, FILES};
