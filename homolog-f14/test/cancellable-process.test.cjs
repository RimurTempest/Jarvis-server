"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {runCancellable} = require("../worker/cancellable-process.cjs");

test("operação lenta não impede heartbeat e pode ser cancelada antes de commit simulado", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-cancel-"));
  const file=path.join(dir,"commit");
  const controller=new AbortController();let beats=0, cleaned=false;
  const tick=setInterval(()=>beats++,20);
  try {
    const pending=runCancellable(process.execPath,["-e",'setTimeout(()=>require("fs").writeFileSync(process.argv[1],"commit"),1200)',file],{
      signal:controller.signal,timeoutMs:3000,killGraceMs:40,cleanupOnCancel:async()=>{cleaned=true;}
    });
    setTimeout(()=>controller.abort(),160);
    const result=await pending;
    assert.equal(result.cancelled,true);assert.equal(result.reason,"cancelled");
    assert.equal(cleaned,true);assert.ok(beats>=3);
    await new Promise(r=>setTimeout(r,1250));
    assert.equal(fs.existsSync(file),false);
  } finally {clearInterval(tick);fs.rmSync(dir,{recursive:true,force:true});}
});
test("tempo limite interrompe subprocesso",async()=>{
  const r=await runCancellable(process.execPath,["-e","setTimeout(()=>{},2000)"],{timeoutMs:80,killGraceMs:40});
  assert.equal(r.cancelled,true);assert.equal(r.reason,"timeout");
});
test("recusa saída excessiva e não confirma sucesso",async()=>{
  const r=await runCancellable(process.execPath,["-e","process.stdout.write('x'.repeat(100000))"],{maxOutputBytes:500,timeoutMs:2000});
  assert.equal(r.cancelled,true);assert.equal(r.reason,"output_limit");assert.ok(r.stdout.length<=500);
});
test("falha na limpeza impede sucesso",async()=>{
  const c=new AbortController();setTimeout(()=>c.abort(),80);
  await assert.rejects(runCancellable(process.execPath,["-e","setTimeout(()=>{},2000)"],{signal:c.signal,cleanupOnCancel:()=>{throw Error("falha");}}),/Limpeza.*não comprovada/);
});
test("tarefa simples completa com sucesso",async()=>{
  const r=await runCancellable(process.execPath,["-e","process.stdout.write('ok')"],{timeoutMs:2000});
  assert.equal(r.status,0);assert.equal(r.stdout,"ok");assert.equal(r.cancelled,false);
});
test("cancelamento anterior à inicialização não executa o processo",async()=>{
  const c=new AbortController();c.abort();
  const r=await runCancellable("programa-inexistente",[],{signal:c.signal});
  assert.equal(r.cancelled,true);assert.equal(r.reason,"cancelled");
});
test("processo que ignora SIGTERM recebe SIGKILL",async()=>{
  if (process.platform === "win32") return;
  const c=new AbortController();
  const pending=runCancellable(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{signal:c.signal,killGraceMs:60,timeoutMs:3000});
  setTimeout(()=>c.abort(),200);
  const result=await pending;
  assert.equal(result.cancelled,true);assert.equal(result.signal,"SIGKILL");
});
test("cancelamento encerra o grupo e impede gravação de descendente",async()=>{
  if (process.platform === "win32") return;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-group-"));const file=path.join(dir,"late-write");
  const code=`const cp=require('child_process');cp.spawn(process.execPath,['-e','setTimeout(()=>require("fs").writeFileSync(process.argv[1],"late"),1200)',process.argv[1]],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const c=new AbortController();
  try {
    const pending=runCancellable(process.execPath,["-e",code,file],{signal:c.signal,timeoutMs:3000,killGraceMs:40});
    setTimeout(()=>c.abort(),200);
    const r=await pending;assert.equal(r.cancelled,true);
    await new Promise(r=>setTimeout(r,1250));assert.equal(fs.existsSync(file),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
