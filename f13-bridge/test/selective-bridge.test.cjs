"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const {
  ORIGINAL_GUARD, NEW_GUARD, FILES, inspectText
} = require("../tools/selective-bridge.cjs");

const TOOL = path.resolve(__dirname, "../tools/selective-bridge.cjs");
const SANDBOX_SRC = path.resolve(__dirname, "fixtures/hotfixed-sandbox.cjs");
const PREFIX = "homolog-phase13-client/fase13-original";
const EVOLUTION = [
  '"use strict";',
  'const { runIsolatedNodeTests } = require("./sandbox-tests.cjs");',
  'async function runEvolution({ testRunner = runIsolatedNodeTests } = {}) {',
  '  return testRunner({target:"server",files:[]});',
  '}',
  'module.exports = {runEvolution};'
].join("\n");

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-bridge-"));
  t.after(() => fs.rmSync(temp, {recursive:true,force:true}));
  const root = path.join(temp, "repo");
  const worker = path.join(root, PREFIX, "worker");
  const backup = path.join(temp, "backups");
  fs.mkdirSync(worker, {recursive:true});
  const sandbox = path.join(worker, "sandbox-tests.cjs");
  fs.copyFileSync(SANDBOX_SRC, sandbox);
  fs.writeFileSync(path.join(worker, "evolution-worker.cjs"), EVOLUTION);
  return {root,worker,sandbox,backup,temp};
}
function cmd(f,mode) {
  return cp.spawnSync(process.execPath,
    [TOOL, mode, f.root, f.backup],
    {encoding:"utf8",timeout:10000});
}

test("guard original unico e verificavel", () => {
  const content = fs.readFileSync(SANDBOX_SRC, "utf8");
  assert.deepEqual(inspectText(content),{originalCount:1,bridgeCount:0});
  assert.ok(content.includes("spawn(\"docker\""));
});

test("check nao altera worktree",t => {
  const f=fixture(t);
  const before=fs.readFileSync(f.sandbox);
  const result=cmd(f,"--check");
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/BRIDGE_READY/);
  assert.deepEqual(fs.readFileSync(f.sandbox),before);
  assert.equal(fs.existsSync(f.backup),false);
});

test("apply troca apenas o retorno do guard e preserva backup", t => {
  const f=fixture(t);
  const before=fs.readFileSync(f.sandbox,"utf8");
  const result=cmd(f,"--apply");
  assert.equal(result.status,0,result.stderr);
  const after=fs.readFileSync(f.sandbox,"utf8");
  assert.equal(after.replace(NEW_GUARD, ORIGINAL_GUARD),before);
  const backups=fs.readdirSync(f.backup);
  assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(f.backup,backups[0]),"utf8"),before);
  for (const filename of FILES) {
    assert.equal(fs.existsSync(path.join(f.root,PREFIX,filename)),true);
  }
  assert.equal(cmd(f,"--verify").status,0);
});

test("evolution-worker default realmente chama o bridge ativo", async t => {
  const f=fixture(t);
  assert.equal(cmd(f,"--apply").status,0);
  const target = path.join(f.worker,"verified-sandbox-entry.cjs");
  const entry = require(target);
  const original = entry.runVerifiedSandbox;
  let called=0;
  entry.runVerifiedSandbox = async (req) => {
    called++;
    assert.deepEqual(req, {target:"server",files:[]});
    return {executed:false,passed:false,functionalValidated:false,reason:"mocked"};
  };
  try {
    const {runEvolution}=require(path.join(f.worker,"evolution-worker.cjs"));
    const result=await runEvolution();
    assert.equal(result.reason,"mocked");
    assert.equal(called,1);
  } finally {
    entry.runVerifiedSandbox=original;
  }
});

test("sem imagem fixada o caminho ativo falha fechado", async t => {
  const f=fixture(t);
  assert.equal(cmd(f,"--apply").status,0);
  const sandbox=require(f.sandbox);
  const r=await sandbox.runIsolatedNodeTests({
    target:"server",files:[],worktree:f.root
  });
  assert.equal(r.executed,false);
  assert.equal(r.passed,false);
  assert.equal(r.functionalValidated,false);
  assert.throws(()=>sandbox.dockerArgs("/repo","unsafe",[]),/LEGACY/);
});

test("campos arbitrarios de execucao sao recusados", async t => {
  const f=fixture(t);
  assert.equal(cmd(f,"--apply").status,0);
  const bridge=require(path.join(f.worker,"verified-sandbox-entry.cjs"));
  const ret=await bridge.runVerifiedSandbox({
    worktree:f.root, files:[],target:"server",runnerFactory:()=>{}
  });
  assert.equal(ret.executed,false);
  assert.match(ret.reason,/argumentos externos recusados/);
});

test("caminho desconhecido do worker recusa aplicacao",t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.worker,"evolution-worker.cjs"),
    "const testRunner = require('./something-else.cjs');\n");
  const result=cmd(f,"--check");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Caminho evolution-worker/);
  assert.equal(fs.existsSync(f.backup),false);
});

test("guard modificado recusa aplicacao",t=>{
  const f=fixture(t);
  fs.writeFileSync(f.sandbox,fs.readFileSync(f.sandbox,"utf8")
    .replace("JARVIS_LEGACY_DOCKER_DISABLED_V1: runner legado bloqueado",
      "UNKNOWN_GUARD: runner legado bloqueado"));
  const result=cmd(f,"--check");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Hotfix ausente/);
});

test("conflito em modulo existente recusa alteracao",t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.worker,"verified-container.cjs"),
    "module.exports={unsafe:true};\n");
  const before=fs.readFileSync(f.sandbox);
  const result=cmd(f,"--apply");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Arquivo divergente/);
  assert.deepEqual(fs.readFileSync(f.sandbox),before);
  assert.equal(fs.existsSync(f.backup),false);
});

test("aplicacao repetida nao reescreve o sandbox",t=>{
  const f=fixture(t);
  assert.equal(cmd(f,"--apply").status,0);
  const original=fs.readFileSync(f.sandbox);
  const result=cmd(f,"--apply");
  assert.notEqual(result.status,0);
  assert.deepEqual(fs.readFileSync(f.sandbox),original);
});
