"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const fs=require("node:fs");const os=require("node:os");const path=require("node:path");
const {processAuthorizedOnce}=require("../worker/phase11-dispatcher.cjs");
const {runCancellable}=require("../worker/cancellable-process.cjs");
const id="12345678-1234-4234-8234-123456789abc", token="x".repeat(43);
const provider={research:async()=>({}),generate:async()=>({})};
test("revogação durante processo lento cancela sem commit nem relatório",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-lease-")), marker=path.join(dir,"commit");let renewals=0,reports=0,beats=0;
 const timer=setInterval(()=>beats++,25);
 const api={claim:async()=>({id,request:"capacidade nova",leaseToken:token}),renew:async()=>{if(++renewals>1)throw Error("revogado");return {id};},report:async()=>{reports++;}};
 try {
   await assert.rejects(processAuthorizedOnce({api,provider,repositories:{},worktreesDir:dir,heartbeatMs:1000,
    execute:async({signal,assertLease})=>{
     const result=await runCancellable(process.execPath,["-e",'setTimeout(()=>require("fs").writeFileSync(process.argv[1],"commit"),1600)',marker],{signal,timeoutMs:3000,killGraceMs:40});
     if(result.cancelled)throw Error("cancelado");assertLease();return {};
    }}),/Autorização de execução perdida/);
   await new Promise(r=>setTimeout(r,750));
   assert.equal(fs.existsSync(marker),false);assert.equal(reports,0);assert.ok(beats>5);assert.equal(renewals,2);
 } finally {clearInterval(timer);fs.rmSync(dir,{recursive:true,force:true});}
});
test("renovação que não responde cancela antes de executar",async()=>{
 let executed=false,reports=0;
 const api={claim:async()=>({id,request:"capacidade",leaseToken:token}),renew:()=>new Promise(()=>{}),report:async()=>reports++};
 await assert.rejects(processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",renewTimeoutMs:30,execute:async()=>{executed=true;}}),/Autorização de execução perdida/);
 assert.equal(executed,false);assert.equal(reports,0);
});
test("verificação antes do commit aguarda renovação e recusa tarefa revogada",async()=>{
 let n=0,commit=false,reports=0;
 const api={claim:async()=>({id,request:"teste",leaseToken:token}),renew:async()=>{if(++n===2)throw Error("revogado");return {id};},report:async()=>reports++};
 await assert.rejects(processAuthorizedOnce({api,provider,repositories:{},worktreesDir:"unused",heartbeatMs:1000,
   execute:async({api:guard})=>{await guard.beforeCommit(id);commit=true;return {};}}),/Autorização de execução perdida/);
 assert.equal(commit,false);assert.equal(reports,0);assert.equal(n,2);
});
