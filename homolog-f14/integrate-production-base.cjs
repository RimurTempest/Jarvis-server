#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const PINNED_BASE = "9176efd763defecc128605832de9af410f43fee9";
const OLD_IMPORT = 'import { initializeAndroidDeviceRegistry } from "./jarvis-capabilities/android-device-registry.mjs";';
const NEW_IMPORT = 'import { initializeAndroidDeviceRegistry, authenticateAndroidDevice } from "./jarvis-capabilities/android-device-registry.mjs";';
const BRIDGE_IMPORT = 'import { registerEvolutionBridge } from "./jarvis-capabilities/evolution-additive-bridge.mjs";';
const INSERT = `
if (process.env.JARVIS_EVOLUTION_BRIDGE_ENABLED === "1" && pool) {
  registerEvolutionBridge({
    app, pool, authenticateDevice: authenticateAndroidDevice,
    initializeLegacyRegistry: initializeAndroidDeviceRegistry,
    env: process.env
  });
}
`;

function patchServer(original) {
  if (typeof original !== "string" ||
      !original.includes(OLD_IMPORT) ||
      !original.includes("const MAX_AI_PROVIDERS = 10;") ||
      !original.includes("const providers = [];") ||
      !original.includes("const pool = process.env.DATABASE_URL")) {
    throw new Error("server.js não corresponde à arquitetura da revisão 9176efd.");
  }
  if (original.includes(BRIDGE_IMPORT)) throw new Error("Ponte já integrada.");
  if (/createJarvisBridge|jarvis-bridge\/bridge|app\.(?:get|post|use)\s*\(\s*["']\/api\/android\/evolution/.test(original)) {
    throw new Error("Rotas legadas de evolução detectadas; reconcilie antes de instalar.");
  }
  const updatedImport = original.replace(OLD_IMPORT, NEW_IMPORT);
  const withBridgeImport = updatedImport.replace(
    NEW_IMPORT, `${NEW_IMPORT}\n${BRIDGE_IMPORT}`
  );
  return withBridgeImport.replace(
    "const providers = [];",
    `${INSERT}\nconst providers = [];`
  );
}
function git(repo, args) {
  const r = cp.spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout: 12000
  });
  if (r.status !== 0) throw new Error("Verificação Git recusada: " + args.join(" "));
  return r.stdout.trim();
}
function prepare(repo, apply = false) {
  const root = fs.realpathSync(repo);
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top !== root) throw new Error("Selecione a raiz do repositório.");
  const branch = git(root, ["branch", "--show-current"]);
  if (!/^work\/[a-z0-9._/-]+$/i.test(branch)) {
    throw new Error("Somente branch isolada work/* é aceita.");
  }
  git(root, ["cat-file", "-e", `${PINNED_BASE}^{commit}`]);
  git(root, ["merge-base", "--is-ancestor", PINNED_BASE, "HEAD"]);
  if (git(root, ["diff", "--name-only", "HEAD", "--", "server.js"])) {
    throw new Error("server.js tem alterações locais. Preserve-as antes.");
  }
  const source = path.join(root, "server.js");
  const updated = patchServer(fs.readFileSync(source, "utf8"));
  const destDir = path.join(root, "jarvis-capabilities");
  if (!fs.existsSync(destDir)) throw new Error("Módulos de capacidades não encontrados.");
  const modules = ["evolution-additive-store.mjs", "evolution-additive-bridge.mjs"];
  for (const file of modules) {
    if (fs.existsSync(path.join(destDir, file))) {
      throw new Error(`Arquivo já existe: ${file}`);
    }
  }
  if (!apply) return { branch, changed: false, files: ["server.js", ...modules] };
  const copied = [];
  try {
    for (const file of modules) {
      const src = path.join(__dirname, "jarvis-capabilities", file);
      const dst = path.join(destDir, file);
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      copied.push(dst);
    }
    fs.writeFileSync(source, updated, "utf8");
  } catch (error) {
    for (const file of copied) fs.rmSync(file, { force: true });
    throw error;
  }
  return { branch, changed: true, files: ["server.js", ...modules] };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !["--check", "--apply"].includes(args[0])) {
    throw new Error("Uso: node integrate-production-base.cjs --check|--apply /caminho/Jarvis-server");
  }
  const result = prepare(args[1], args[0] === "--apply");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Integração recusada: ${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { patchServer, prepare, PINNED_BASE };
