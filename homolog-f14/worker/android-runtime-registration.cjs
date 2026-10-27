"use strict";

/**
 * Liga classes Kotlin ao runtime sem editar MainActivity por habilidade.
 * A lista é um asset do APK, nunca um arquivo baixado em tempo de execução.
 * Esta operação NÃO compila, assina, instala ou valida a habilidade.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { sha } = require("./capability-changes.cjs");

const ASSET = "app/src/main/assets/jarvis_capabilities.json";
const PREFIX = "app/src/main/java/com/senhor/jarvis/capabilities/";
const HANDLER = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const QUALIFIED = /^com\.senhor\.jarvis\.capabilities\.[A-Za-z][A-Za-z0-9_]{0,79}$/;

function assertNoSymlink(root, relative) {
  let current = fs.realpathSync(root);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Registro de habilidades não aceita caminhos simbólicos.");
    }
  }
}

function readCatalog(worktree) {
  assertNoSymlink(worktree, ASSET);
  const file = path.join(worktree, ASSET);
  if (!fs.existsSync(file)) return { existed: false, handlers: [] };
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 32_000) {
    throw new Error("Catálogo de habilidades inválido ou muito grande.");
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.handlers) || parsed.handlers.length > 40 ||
      Object.keys(parsed).sort().join(",") !== "handlers,schemaVersion" ||
      parsed.handlers.some(name => typeof name !== "string" || !QUALIFIED.test(name)) ||
      new Set(parsed.handlers).size !== parsed.handlers.length) {
    throw new Error("Catálogo Android inválido ou incompatível.");
  }
  return { existed: true, handlers: parsed.handlers };
}

function extractHandler(relative, content) {
  if (!relative.startsWith(PREFIX) || !relative.endsWith(".kt")) return null;
  const name = relative.slice(PREFIX.length, -3);
  if (!HANDLER.test(name) || name.includes("/")) {
    throw new Error("Handler deve ser arquivo Kotlin diretamente na pasta capabilities.");
  }
  if (!/^\s*package\s+com\.senhor\.jarvis\.capabilities\s*$/m.test(content)) {
    throw new Error("Handler tem namespace Kotlin divergente.");
  }
  const declaration = new RegExp(
    `\\bclass\\s+${name}\\b[^\\{]{0,300}:\\s*(?:com\\.senhor\\.jarvis\\.)?JarvisNativeCapability\\b`
  );
  if (!declaration.test(content) ||
      !/@(?:com\.senhor\.jarvis\.)?JarvisCapabilitySpec\s*\(/.test(content)) {
    throw new Error("Handler requer JarvisNativeCapability e @JarvisCapabilitySpec.");
  }
  return `com.senhor.jarvis.capabilities.${name}`;
}

function integrateAndroidRegistry(worktree, changes) {
  const discovered = [];
  for (const item of changes) {
    const absolute = path.join(worktree, item.path);
    const content = fs.readFileSync(absolute, "utf8");
    const name = extractHandler(item.path, content);
    if (name) discovered.push(name);
  }
  if (!discovered.length) return { prepared: false, changes: [] };

  const catalog = readCatalog(worktree);
  const handlers = [...new Set([...catalog.handlers, ...discovered])].sort();
  if (handlers.length > 40) throw new Error("Máximo de 40 handlers por APK.");
  const full = path.join(worktree, ASSET);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  assertNoSymlink(worktree, ASSET);
  const content = JSON.stringify({ schemaVersion: 1, handlers }, null, 2) + "\n";
  const tmp = `${full}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, full);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  return { prepared: true, changes: [{
    path: ASSET, sha256: sha(content), added: !catalog.existed
  }] };
}

module.exports = { integrateAndroidRegistry, readCatalog, extractHandler, ASSET };
