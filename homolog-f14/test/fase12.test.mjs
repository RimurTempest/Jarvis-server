import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { registerEvolutionBridge } from "../jarvis-capabilities/evolution-additive-bridge.mjs";
import { createEvolutionStore } from "../jarvis-capabilities/evolution-additive-store.mjs";

const require = createRequire(import.meta.url);
const { createPhase11Api } = require("../worker/phase11-api.cjs");
const { processAuthorizedOnce, reportOutcome } = require("../worker/phase11-dispatcher.cjs");
const { runEvolution } = require("../worker/evolution-worker.cjs");
const { installTestHarness } = require("../install-backend-test-harness.cjs");

const id = "4d192bbf-ef17-4bf3-9b92-cba0f9299904";
const token = "r".repeat(48), leaseToken = "l".repeat(48);
const env = {
  JARVIS_EVOLUTION_BRIDGE_ENABLED: "1",
  JARVIS_EVOLUTION_SINGLE_OWNER: "1",
  JARVIS_EVOLUTION_OWNER_ID: "owner_one",
  JARVIS_EVOLUTION_ADMIN_TOKEN: "a".repeat(48),
  JARVIS_EVOLUTION_RUNNER_TOKEN: token,
  JARVIS_API_TOKEN: "c".repeat(48)
};
const claimTask = () => ({id, request:"descobrir uma capacidade inédita", leaseToken, attempt:1});
const fakeResult = () => ({
  taskId:id, applied:true, localTestsValidated:true,
  isolatedTests:{executed:true,passed:true},
  localCommitSha:"a".repeat(40),branch:`work/evolution/${id}`,
  remoteTouched:false, installed:false, capabilityLearned:false, readyForRelease:false,
  summary:"Mudança local proposta"
});
const provider = {research:async()=>({}),generate:async()=>({})};

function makeApi({task=claimTask(), renewFails=false, reportFails=false}={}) {
  const events = [];
  return {
    events,
    claim:async()=>{events.push("claim");return task;},
    renew:async()=>{events.push("renew");if(renewFails)throw Error("perdeu a reserva");return {id};},
    report:async (taskId, lease, outcome)=>{
      events.push({taskId,lease,outcome});
      if(reportFails)throw Error("503");
      return {task:{id:taskId},published:false,installed:false,learned:false};
    }
  };
}
test("API exige origem HTTPS ou localhost durante testes", () => {
  assert.throws(()=>createPhase11Api({baseUrl:"http://api.exemplo.org",token,fetchImpl:async()=>{}}),/HTTPS/);
  assert.throws(()=>createPhase11Api({baseUrl:"https://user:pass@exemplo.org/",token,fetchImpl:async()=>{}}),/credenciais/);
  assert.throws(()=>createPhase11Api({baseUrl:"https://exemplo.org/api",token,fetchImpl:async()=>{}}),/origem/);
});
test("cliente usa rotas exclusivas claim, renew e report com Bearer dedicado", async () => {
  const requests=[];
  const fetchImpl=async(url, init)=>{
    requests.push({url,init});
    const path=new URL(url).pathname;
    const data=JSON.parse(init.body);
    if(path.endsWith("/claim"))return {
      status:200,headers:{get:()=>"application/json"},
      json:async()=>({task:claimTask(),permissions:{publish:false,install:false,deploy:false}})
    };
    if(path.endsWith("/renew"))return {
      status:200,headers:{get:()=>"application/json"},
      json:async()=>({lease:{id},permissions:{publish:false,install:false,deploy:false}})
    };
    assert.equal(data.leaseToken,leaseToken);
    return {status:200,headers:{get:()=>"application/json"},
      json:async()=>({task:{id},published:false,installed:false,learned:false})};
  };
  const api=createPhase11Api({baseUrl:"https://staging.exemplo.org",token,fetchImpl});
  assert.equal((await api.claim()).id,id);
  await api.renew(id,leaseToken);
  await api.report(id,leaseToken,{status:"blocked",summary:"erro"});
  assert.deepEqual(requests.map(x=>new URL(x.url).pathname),[
    "/api/evolution/runner/claim",
    `/api/evolution/runner/requests/${id}/renew`,
    `/api/evolution/runner/requests/${id}/report`
  ]);
  assert.ok(requests.every(x=>x.init.headers.Authorization===`Bearer ${token}`));
  assert.ok(requests.every(x=>x.init.redirect==="manual"));
});
test("cliente recusa confirmação permissiva ou resultado como aprendido",async()=>{
  const fetchImpl=async()=>({status:200,headers:{get:()=>""},json:async()=>({
    task:claimTask(),permissions:{publish:true,install:false,deploy:false}
  })});
  await assert.rejects(createPhase11Api({baseUrl:"https://staging.exemplo.org",token,fetchImpl}).claim(),/restrições/);
});
test("fila vazia não aciona IA",async()=>{
  const api=makeApi({task:null});
  const result=await processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",
    execute:()=>{throw Error("não deveria rodar")}});
  assert.equal(result.status,"empty");
  assert.deepEqual(api.events,["claim"]);
});
test("sucesso em testes simulados só cria estado needs_review, jamais learned",async()=>{
  const api=makeApi();
  const result=await processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",
    execute:async({api:legacy,evolutionId,apply})=>{
      assert.equal(apply,true);
      const response=await legacy.context(id);
      assert.equal(response.task.request_text,claimTask().request);
      await legacy.advance(id,"researching",{irrelevant:true});
      await assert.rejects(legacy.advance(id,"installed"),/Transição/);
      return fakeResult();
    }});
  assert.equal(result.status,"needs_review");
  assert.equal(result.learned,false);
  assert.equal(result.reportAccepted,true);
  assert.deepEqual(api.events.find(x=>typeof x === "object" && x?.outcome).outcome,{
    status:"needs_review",summary:"Mudança local proposta",
    testsExecuted:true,testsPassed:true,commitSha:"a".repeat(40),branch:`work/evolution/${id}`
  });
});
test("um resultado sem testes, branch correta ou sem commit fica blocked",async()=>{
  for(const altered of [
    {localTestsValidated:false},
    {isolatedTests:{executed:false,passed:true}},
    {branch:"main"},
    {localCommitSha:"x"},
    {capabilityLearned:true}
  ]) {
    const api=makeApi();
    const outcome=await processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",
      execute:async()=>({...fakeResult(),...altered})});
    assert.equal(outcome.status,"blocked");
    assert.equal(api.events.find(x=>typeof x === "object" && x?.outcome).outcome.status,"blocked");
  }
});
test("falha do executor gera bloqueio, nunca sucesso",async()=>{
  const api=makeApi();
  const outcome=await processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",
    execute:async()=>{throw Error("falha de código ou Docker")}});
  assert.equal(outcome.status,"blocked");
  assert.equal(outcome.localExecutionFailed,true);
});
test("falha na gravação do relatório causa erro, sem afirmar sucesso",async()=>{
  const api=makeApi({reportFails:true});
  await assert.rejects(processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",
    execute:async()=>fakeResult()}),/não confirmou/);
});
test("renovação de lease é tratada como trava obrigatória",async()=>{
  const api=makeApi({renewFails:true});
  await assert.rejects(processAuthorizedOnce({
    api,provider,repositories:{},worktreesDir:"unused",heartbeatMs:1000,
    execute:async({assertLease})=>{
      await new Promise(resolve=>setTimeout(resolve,1100));
      assertLease();
      return fakeResult();
    }
  }),/Autorização de execução perdida/);
  assert.ok(api.events.includes("renew"));
  assert.equal(api.events.some(x=>typeof x==="object" && x.outcome.status==="needs_review"),false);
});
test("renovação rejeita lease vencido mesmo com token válido",async()=>{
  const queries=[];
  const pool={query:async(sql,params)=>{queries.push({sql,params});return {rows:[]}},
    connect:async()=>({query:async()=>({rows:[]}),release(){}})};
  const store=createEvolutionStore(pool);
  await assert.rejects(store.renewLease(id,leaseToken),e=>e.status===409);
  assert.match(queries[0].sql,/lease_expires_at > NOW\(\)/);
  assert.match(queries[0].sql,/lease_started_at > NOW\(\) - INTERVAL '90 minutes'/);
});
test("endpoint renew rejeita credenciais do Android e do administrador",async()=>{
  const routes=new Map();
  const app={get:(p,h)=>routes.set(`GET ${p}`,h),
    post:(p,h)=>routes.set(`POST ${p}`,h)};
  const store={
    initialize:async()=>{},renewLease:async()=>{
      return {id,lease_expires_at:new Date().toISOString()};
    }
  };
  registerEvolutionBridge({
    app,pool:{},env,storeOverride:store,
    initializeLegacyRegistry:async()=>{},
    authenticateDevice:async()=>({ok:true})
  });
  const route=routes.get("POST /api/evolution/runner/requests/:id/renew");
  const call=async bearer=>{
    let status=200;
    await route({headers:{authorization:`Bearer ${bearer}`},params:{id},
      body:{leaseToken}}, {
      setHeader(){},status(code){status=code;return this;},
      json() {return this;}
    });
    return status;
  };
  assert.equal(await call(env.JARVIS_EVOLUTION_ADMIN_TOKEN),401);
  assert.equal(await call(env.JARVIS_API_TOKEN),401);
  assert.equal(await call(token),200);
});
function runGit(dir,...args) {
  const result=spawnSync("git",args,{cwd:dir,encoding:"utf8",timeout:15_000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
test("fluxo Fase 11 → Fase 10 cria commit local isolado sem publicar",async()=>{
  const root=mkdtempSync(join(tmpdir(),"jarvis-phase12-"));
  try {
    const repo=join(root,"repo"),worktrees=join(root,"worktrees");
    mkdirSync(repo);mkdirSync(worktrees);
    mkdirSync(join(repo,"jarvis-bridge"),{recursive:true});
    mkdirSync(join(repo,"jarvis-capabilities"),{recursive:true});
    writeFileSync(join(repo,"server.js"),"export const app = null;\n");
    writeFileSync(join(repo,"jarvis-capabilities/evolution-additive-bridge.mjs"),"export const bridge = true;\n");
    runGit(repo,"init","-b","work/phase12-integration");
    runGit(repo,"-c","user.name=Tester","-c","user.email=tests@localhost","add",".");
    runGit(repo,"-c","user.name=Tester","-c","user.email=tests@localhost","commit","-m","baseline");
    const installation = installTestHarness(repo);
    assert.equal(installation.published, false);
    runGit(repo,"-c","user.name=Tester","-c","user.email=tests@localhost","add",".");
    runGit(repo,"-c","user.name=Tester","-c","user.email=tests@localhost","commit","-m","isolated backend test harness");
    const originalSha=runGit(repo,"rev-parse","HEAD");
    const api=makeApi();
    const workingProvider={
      research:async()=>({
        summary:"Módulo de capacidade em servidor",
        sources:["https://developer.android.com/"],
        target:"server", steps:["Implementar"],permissions:[]
      }),
      generate:async()=>({summary:"Módulo local de exemplo de teste",
        changes:[{path:"jarvis-bridge/capabilities/new-capability.cjs",
          beforeSha256:null,content:'"use strict"; module.exports = { kind: "test" };\n'}],
        risks:[]})
    };
    const result=await processAuthorizedOnce({
      api,provider:workingProvider,repositories:{server:repo},worktreesDir:worktrees,
      execute:params=>runEvolution({...params,
        testRunner:async()=>({executed:true,passed:true,
          testCount:1,reason:"simulado por teste de integração"})
      })
    });
    assert.equal(result.status,"needs_review");
    // Regressão: o commit local verdadeiro precisa informar applied=true
    // ao dispatcher, sem afirmar instalação, publicação ou aprendizado.
    const localReport = JSON.parse(readFileSync(join(worktrees,
      `jarvis-evolution-${id}.report.json`), "utf8"));
    assert.equal(localReport.applied, true);
    assert.equal(localReport.installed, false);
    assert.equal(localReport.capabilityLearned, false);
    assert.equal(runGit(repo,"rev-parse","HEAD"),originalSha);
    assert.equal(runGit(repo,"status","--porcelain"),"");
    assert.equal(runGit(repo,"branch","--list",`work/evolution/${id}`).includes(id),true);
    assert.equal(api.events.find(x=>typeof x === "object" && x?.outcome).outcome.testsExecuted,true);
    const generatedWorktree=join(worktrees,`jarvis-evolution-${id}`);
    const contract=spawnSync("node",["jarvis-bridge/ci-test-backend.cjs"],{
      cwd:generatedWorktree,encoding:"utf8",timeout:20000
    });
    assert.equal(contract.status,0,contract.stdout+contract.stderr);
    assert.match(contract.stdout,/# tests 5/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
