"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const fs=require("node:fs");const os=require("node:os");const path=require("node:path");const cp=require("node:child_process");
const {processAuthorizedOnce}=require("../worker/phase11-dispatcher.cjs");
const {runEvolution}=require("../worker/evolution-worker.cjs");
const {runIsolatedNodeTests}=require("../../f13-bridge/worker/verified-sandbox.cjs");
const id="56d1c101-1234-4234-8234-123456789abc",token="x".repeat(43);
function git(dir,...args){return cp.execFileSync("git",args,{cwd:dir,encoding:"utf8",env:{...process.env,GIT_TERMINAL_PROMPT:"0"}}).trim();}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-worker-real-")),repo=path.join(root,"repo"),worktrees=path.join(root,"worktrees"),staging=path.join(root,"staging");
 fs.mkdirSync(path.join(repo,"jarvis-bridge"),{recursive:true});fs.mkdirSync(path.join(repo,"jarvis-capabilities"),{recursive:true});fs.mkdirSync(worktrees);fs.mkdirSync(staging);fs.chmodSync(staging,0o755);
 fs.writeFileSync(path.join(repo,"server.js"),"export const server = true;\n");fs.writeFileSync(path.join(repo,"jarvis-capabilities/evolution-additive-bridge.mjs"),"export const bridge=true;\n");fs.writeFileSync(path.join(repo,"jarvis-bridge/ci-test-backend.cjs"),"module.exports=true;\n");
 git(repo,"init","-q","-b","work/test");git(repo,"add",".");git(repo,"-c","user.name=Tester","-c","user.email=tests@localhost","commit","-qm","base");
 const sha=git(repo,"rev-parse","HEAD");return {root,repo,worktrees,staging,sha,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const provider={research:async()=>({summary:"plano",sources:["https://example.com"],target:"server",steps:["teste"],permissions:[]}),generate:async()=>({summary:"candidato",changes:[{path:"jarvis-bridge/capabilities/new-capability.cjs",beforeSha256:null,content:'"use strict"; module.exports = true;\n'}],risks:[]})};
function baseApi(renew){let reports=0;return {claim:async()=>({id,request:"Criar capacidade de teste",leaseToken:token}),renew,report:async()=>{reports++;},reports:()=>reports};}
test("worker real cancela sandbox simulado revogado sem commit ou relatório",async()=>{
 const f=fixture();let n=0,started=false,cleaned=false;const api=baseApi(async()=>{if(++n>1)throw Error("revogado");return {id};});
 try {
  const testRunner=options=>runIsolatedNodeTests({...options,image:"node@sha256:"+"a".repeat(64),stagingRoot:f.staging,trustedRoot:path.resolve(__dirname,"../../f13-bridge/trusted-harness"),
   runnerFactory:async()=>({executeAsync:async(_input,{signal})=>{started=true;await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener("abort",resolve,{once:true});});cleaned=true;throw Error("cancelled");}})});
  await assert.rejects(processAuthorizedOnce({api,provider,repositories:{server:f.repo},worktreesDir:f.worktrees,heartbeatMs:1000,execute:args=>runEvolution({...args,testRunner})}),/Autorização de execução perdida/);
  assert.equal(started,true);assert.equal(cleaned,true);assert.equal(api.reports(),0);
  const workspace=path.join(f.worktrees,"jarvis-evolution-"+id);assert.equal(git(workspace,"rev-parse","HEAD"),f.sha);
 }finally{f.close();}
});
test("renovação antes do commit recusa revogação e preserva HEAD",async()=>{
 const f=fixture();let n=0;const api=baseApi(async()=>{if(++n===2)throw Error("revogado antes do commit");return {id};});
 try{
  const testRunner=async()=>({executed:true,passed:true,testCount:1});
  await assert.rejects(processAuthorizedOnce({api,provider,repositories:{server:f.repo},worktreesDir:f.worktrees,heartbeatMs:1000,execute:args=>runEvolution({...args,testRunner})}),/Autorização de execução perdida/);
  const workspace=path.join(f.worktrees,"jarvis-evolution-"+id);assert.equal(git(workspace,"rev-parse","HEAD"),f.sha);assert.equal(api.reports(),0);assert.equal(n,2);
 }finally{f.close();}
});
