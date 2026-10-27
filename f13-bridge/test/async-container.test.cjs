"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const fs=require("node:fs");const path=require("node:path");const os=require("node:os");
const {createHardenedRunner}=require("../worker/verified-container.cjs");
const IMAGE="node@sha256:"+"b".repeat(64),ID="12345678-1234-4234-a234-123456789abc",OWNER="aef0250f-12ad-47c7-a3ea-080cc9374af3";
function fixture({mode="success",badCleanup=false,foreign=false}={}){
 const top=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-async-f13-"));const root=path.join(top,"stage"),stage=path.join(root,"task");fs.mkdirSync(stage,{recursive:true});
 const calls=[];let cleaned=false;const fsMock={realpathSync:fs.realpathSync,statSync:fs.statSync,readdirSync:fs.readdirSync,lstatSync:p=>p==="/run/user/1000/docker.sock"?{uid:1000,isSocket:()=>true}:fs.lstatSync(p)};
 const run=async(_cmd,args,options)=>{
  const action=args[2];calls.push(action);
  if(action==="info")return {status:0,stdout:JSON.stringify({SecurityOptions:["name=rootless"],CgroupVersion:"2",CgroupDriver:"systemd"})};
  if(action==="create") {if(mode==="slow-create") await new Promise(r=>setTimeout(r,120));return {status:0,stdout:"a".repeat(64)};}
  if(action==="start") {
   if(mode==="slow-start")return new Promise(resolve=>{const done=()=>resolve({cancelled:true,status:null});if(options.signal.aborted)done();else options.signal.addEventListener("abort",done,{once:true});});
   if(mode==="timeout")return {cancelled:true,reason:"timeout",status:null};
   return {status:0,stdout:"TAP version 13\n# tests 1\n# fail 0\n"};
  }
  if(action==="inspect")return {status:0,stdout:JSON.stringify(args.includes("{{json .Config.Labels}}")?{"br.jarvis.sandbox":"isolated","br.jarvis.worker_id":foreign?"foreign":OWNER}:{Status:"exited",ExitCode:0,OOMKilled:false})};
  if(action==="ps")return {status:0,stdout:"a".repeat(64)};
  if(action==="rm"){cleaned=true;return badCleanup?{error:Error("rm failed"),status:null}:{status:0};}
  if(action==="container")return badCleanup?{status:0,stdout:"still exists"}:{status:1,stderr:"Error: No such object"};
  throw Error("Unexpected Docker action "+action);
 };
 const runner=createHardenedRunner({asyncDocker:run,filesystem:fsMock,uid:1000,workerId:OWNER,assertLeader:()=>{},createId:()=>ID});
 return {runner,calls,cleaned:()=>cleaned,input:{kind:"suite",stagingDir:stage,stagingRoot:root,image:IMAGE},close:()=>fs.rmSync(top,{recursive:true,force:true})};
}
test("execução assíncrona confirma perfil e limpeza",async()=>{const f=fixture();try{const c=new AbortController();const r=await f.runner.executeAsync(f.input,{signal:c.signal});assert.equal(r.passed,true);assert.equal(r.containerRemoved,true);assert.deepEqual(f.calls,["info","create","start","inspect","rm","container"]);}finally{f.close();}});
test("revogação durante Docker interrompe, limpa e rejeita resultado",async()=>{const f=fixture({mode:"slow-start"});const c=new AbortController();let beats=0;const tick=setInterval(()=>beats++,10);try{const pending=f.runner.executeAsync(f.input,{signal:c.signal});setTimeout(()=>c.abort(),80);await assert.rejects(pending,/cancelada/);assert.equal(f.cleaned(),true);assert.ok(beats>=3);assert.deepEqual(f.calls,["info","create","start","rm","container"]);}finally{clearInterval(tick);f.close();}});
test("revogação durante criação impede start e limpa após resposta",async()=>{const f=fixture({mode:"slow-create"});const c=new AbortController();try{const pending=f.runner.executeAsync(f.input,{signal:c.signal});setTimeout(()=>c.abort(),30);await assert.rejects(pending,/cancelada/);assert.equal(f.cleaned(),true);assert.ok(!f.calls.includes("start"));}finally{f.close();}});
test("tempo esgotado bloqueia e limpa contêiner",async()=>{const f=fixture({mode:"timeout"});try{await assert.rejects(f.runner.executeAsync(f.input,{signal:new AbortController().signal}),/interrompida/);assert.equal(f.cleaned(),true);}finally{f.close();}});
test("limpeza não comprovada bloqueia mesmo após revogação",async()=>{const f=fixture({mode:"slow-start",badCleanup:true});const c=new AbortController();try{const pending=f.runner.executeAsync(f.input,{signal:c.signal});setTimeout(()=>c.abort(),40);await assert.rejects(pending,/Limpeza.*nao comprovada/);}finally{f.close();}});
test("sinal ausente recusa execução antes de acessar Docker",async()=>{const f=fixture();try{await assert.rejects(f.runner.executeAsync(f.input),/Reserva/);assert.deepEqual(f.calls,[]);}finally{f.close();}});
test("recuperação assíncrona rejeita contêiner de outro worker",async()=>{const f=fixture({foreign:true});try{await assert.rejects(f.runner.reconcileOrphansAsync(new AbortController().signal),/nao pertence/);assert.ok(!f.calls.includes("rm"));}finally{f.close();}});
test("subprocesso Docker simulado é encerrado e remoção é verificada",async()=>{
 const {runCancellable}=require("../worker/cancellable-process.cjs");
 const f=fixture();const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-docker-child-"));const script=path.join(dir,"docker.cjs");
 fs.writeFileSync(script,`const fs=require('fs');const path=require('path');const dir=process.env.TEST_STATE_DIR;const action=process.argv[4];const state=path.join(dir,'container');if(action==='info')console.log(JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd'}));else if(action==='create'){fs.writeFileSync(state,'created');console.log('a'.repeat(64));}else if(action==='start'){fs.writeFileSync(path.join(dir,'started'),'yes');setTimeout(()=>fs.writeFileSync(path.join(dir,'late'),'bad'),1200);}else if(action==='rm'){try{fs.unlinkSync(state)}catch{};fs.writeFileSync(path.join(dir,'removed'),'yes');}else if(action==='container'){if(fs.existsSync(state))process.exit(0);console.error('No such object');process.exit(1);}else process.exit(2);`);
 const fsMock={realpathSync:fs.realpathSync,statSync:fs.statSync,readdirSync:fs.readdirSync,lstatSync:p=>p==="/run/user/1000/docker.sock"?{uid:1000,isSocket:()=>true}:fs.lstatSync(p)};
 const runner=createHardenedRunner({uid:1000,filesystem:fsMock,workerId:OWNER,assertLeader:()=>{},createId:()=>ID,
  asyncDocker:(_cmd,args,opts)=>runCancellable(process.execPath,[script,...args],{...opts,env:{...opts.env,TEST_STATE_DIR:dir}})});
 const controller=new AbortController();let beats=0;const tick=setInterval(()=>beats++,15);
 try {
  const pending=runner.executeAsync(f.input,{signal:controller.signal});
  const until=Date.now()+2000;while(!fs.existsSync(path.join(dir,'started'))&&Date.now()<until) await new Promise(r=>setTimeout(r,15));
  assert.equal(fs.existsSync(path.join(dir,'started')),true);
  controller.abort();await assert.rejects(pending,/cancelada/);
  assert.equal(fs.existsSync(path.join(dir,'removed')),true);assert.equal(fs.existsSync(path.join(dir,'container')),false);
  await new Promise(r=>setTimeout(r,1250));assert.equal(fs.existsSync(path.join(dir,'late')),false);assert.ok(beats>5);
 } finally {clearInterval(tick);f.close();fs.rmSync(dir,{recursive:true,force:true});}
});
