"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const root = path.resolve("jarvis-bridge/capabilities");
function modules() {
  assert.ok(fs.existsSync(root), "Pasta de capacidades ausente.");
  const files = fs.readdirSync(root);
  const accepted = files.filter(f => /^[a-zA-Z0-9_-]+\.(cjs|mjs|js)$/.test(f));
  assert.ok(accepted.length > 0, "Nenhum módulo novo para validar.");
  assert.equal(files.length, accepted.length, "Arquivo fora do padrão.");
  return accepted;
}
test("existe ao menos um módulo candidato", () => {
  assert.ok(modules().length > 0);
});
test("nomes dos módulos possuem formato permitido", () => {
  for (const file of modules()) assert.match(file, /^[a-zA-Z0-9_-]+\.(cjs|mjs|js)$/);
});
test("módulos candidatos são arquivos regulares, nunca links", () => {
  for (const file of modules()) {
    const stat = fs.lstatSync(path.join(root, file));
    assert.ok(stat.isFile());
    assert.ok(!stat.isSymbolicLink());
  }
});
test("módulos possuem conteúdo e passam em node --check", () => {
  for (const file of modules()) {
    const name = path.join(root, file);
    assert.ok(fs.statSync(name).size > 0);
    const result = cp.spawnSync(process.execPath, ["--check", name], {
      timeout: 15_000, encoding: "utf8", env: { PATH: process.env.PATH }
    });
    assert.equal(result.status, 0, "Sintaxe inválida no módulo candidato.");
  }
});
test("módulos não incluem chaves privadas em texto", () => {
  for (const file of modules()) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"),
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  }
});
