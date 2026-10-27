#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { verifyRepo } = require("./worker/dev-workspace.cjs");

const FILES = [
  "jarvis-bridge/ci-test-backend.cjs",
  "jarvis-bridge/test/phase12-contract.test.cjs"
];
function installTestHarness(repoPath) {
  const repo = verifyRepo(repoPath);
  if (!fs.existsSync(path.join(repo.base, "server.js")) ||
      !fs.existsSync(path.join(repo.base, "jarvis-capabilities/evolution-additive-bridge.mjs"))) {
    throw new Error("O checkout não é a base de servidor conciliada com a Fase 11.");
  }
  for (const relative of FILES) {
    const dest = path.join(repo.base, relative);
    if (fs.existsSync(dest)) {
      throw new Error("Arquivo de testes já existe; não sobrescrever.");
    }
    let cursor = path.dirname(dest);
    while (cursor.startsWith(repo.base) && cursor !== repo.base) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error("Caminho simbólico não permitido.");
      }
      cursor = path.dirname(cursor);
    }
  }
  const installed = [];
  try {
    for (const relative of FILES) {
      const source = path.join(__dirname, "sandbox-harness", relative);
      const dest = path.join(repo.base, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      installed.push(dest);
    }
    return { installed: FILES, branch: repo.branch, committed: false, published: false };
  } catch (error) {
    for (const dest of installed) fs.unlinkSync(dest);
    throw error;
  }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Uso: node install-backend-test-harness.cjs CAMINHO_CHECKOUT");
    }
    process.stdout.write(JSON.stringify(installTestHarness(process.argv[2]), null, 2) + "\n");
  } catch (error) {
    process.stderr.write("Instalação do harness recusada: " + error.message + "\n");
    process.exitCode = 1;
  }
}
module.exports = { installTestHarness };
