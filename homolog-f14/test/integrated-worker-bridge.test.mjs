import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { registerEvolutionBridge } from '../jarvis-capabilities/evolution-additive-bridge.mjs';
const require=createRequire(import.meta.url);
const {createPhase11Api}=require('../worker/phase11-api.cjs');
const {processAuthorizedOnce}=require('../worker/phase11-dispatcher.cjs');
const PERM = {publish:false, install:false, deploy:false};
const ownerToken='O'.repeat(48), runnerToken='R'.repeat(48), deviceToken='D'.repeat(48), chatToken='C'.repeat(48);
const env={JARVIS_EVOLUTION_BRIDGE_ENABLED:'1',JARVIS_EVOLUTION_SINGLE_OWNER:'1',JARVIS_EVOLUTION_OWNER_ID:'owner_test_1', JARVIS_EVOLUTION_ADMIN_TOKEN:ownerToken,JARVIS_EVOLUTION_RUNNER_TOKEN:runnerToken,JARVIS_API_TOKEN:chatToken};
const fail=(s,msg)=>Object.assign(new Error(msg),{status:s});
const provider={research:async()=>{throw Error('IA REAL PROIBIDA');},generate:async()=>{throw Error('GERACAO REAL PROIBIDA');}};
function fakeGood(id){return {taskId:id,applied:true,localTestsValidated:true,isolatedTests:{executed:true,passed:true},localCommitSha:'a'.repeat(40),branch:`work/evolution/${id}`,remoteTouched:false,installed:false,capabilityLearned:false,readyForRelease:false,summary:'Simulação; não houve implementação de habilidade'};}
function newState(){
  const tasks=new Map(), audit=[];let now=0;
  const leaseValidity=(task,token)=>task&&task.state==='claimed'&&!task.revoked&&task.token===token&&task.expiresAt>now;
  const store={
    initialize:async()=>{},bindDevice:async(d,o)=>({device_id:d,owner_id:o}),resolveOwner:async()=>env.JARVIS_EVOLUTION_OWNER_ID,
    create:async(o,request,clientRequestId)=>{const t={id:randomUUID(),owner_id:o,request_text:request,client_request_id:clientRequestId,state:'requested',authorized:false,attempts:0,revoked:false};tasks.set(t.id,t);audit.push('request');return t;},
    list:async o=>[...tasks.values()].filter(t=>t.owner_id===o),
    authorize:async(o,id)=>{const t=tasks.get(id);if(!t||t.owner_id!==o)throw fail(404,'missing');if(t.revoked)throw fail(409,'revoked');t.authorized=true;audit.push('authorize');return {id,developmentAuthorized:true,newlyAuthorized:true};},
    claim:async()=>{for(const t of tasks.values()){
       if(!t.authorized||t.revoked||t.state==='needs_review'||t.state==='blocked')continue;
       if(t.state==='claimed'&&t.expiresAt<=now){if(t.attempts>=3){t.state='blocked';audit.push('lease_exhausted');continue;}t.state='requested';}
       if(t.state!=='requested')continue;
       t.attempts++;t.state='claimed';t.token=randomBytes(32).toString('base64url');t.expiresAt=now+900_000;audit.push('claim');return{id:t.id,request:t.request_text,attempt:t.attempts,leaseToken:t.token};
    }return null;},
    renewLease:async(id,token)=>{const t=tasks.get(id);if(!leaseValidity(t,token))throw fail(409,'lease rejected');t.expiresAt=now+900_000;audit.push('renew');return{id,lease_expires_at:new Date(Date.now()+900_000).toISOString()};},
    report:async(id,token,outcome)=>{const t=tasks.get(id);if(!leaseValidity(t,token))throw fail(409,'lease rejected');if(!outcome||!['needs_review','blocked'].includes(outcome.status)||typeof outcome.summary!=='string'||!outcome.summary.trim())throw fail(422,'invalid outcome');if(outcome.status==='needs_review'&&(!(outcome.testsExecuted===true&&outcome.testsPassed===true)||!(/^[a-f0-9]{40}$/i.test(outcome.commitSha||''))||outcome.branch!==`work/evolution/${id}`))throw fail(422,'missing proof');t.state=outcome.status;t.token=null;t.outcome=outcome;audit.push('report');return{id,state:outcome.status,learned:false,installed:false};}
  };
  return{store,tasks,audit,advanceTime:ms=>now+=ms,revokeTask:id=>{const t=tasks.get(id);t.revoked=true;audit.push('revoke');}};
}
async function fixture(t){
  const routes=[]; const add=(method,pattern,fn)=>{const keys=[...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map(m=>m[1]);const reg=new RegExp('^'+pattern.replace(/:([A-Za-z0-9_]+)/g,'([^/]+)')+'$');routes.push({method,reg,keys,fn});};
  const app={post:(p,fn)=>add('POST',p,fn),get:(p,fn)=>add('GET',p,fn)};
  const state=newState();
  registerEvolutionBridge({app,pool:{},env,storeOverride:state.store,initializeLegacyRegistry:async()=>{},authenticateDevice:async()=>({ok:true})});
  const server=http.createServer(async(req,res)=>{
    res.status=n=>{res.statusCode=n;return res;};res.json=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));return res;};
    const url=new URL(req.url,'http://127.0.0.1');const route=routes.find(r=>r.method===req.method&&r.reg.test(url.pathname));if(!route){res.status(404).json({error:'not-found'});return;}
    const match=route.reg.exec(url.pathname);req.params=Object.fromEntries(route.keys.map((k,i)=>[k,match[i+1]]));
    let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>16000){res.status(413).json({error:'body too large'});return;}}
    try{req.body=raw?JSON.parse(raw):{};}catch{res.status(400).json({error:'invalid JSON'});return;}
    await route.fn(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const api=createPhase11Api({baseUrl,token:runnerToken,allowLocalHttp:true});
  const post=async(path,token,body={})=>{const r=await fetch(baseUrl+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Jarvis-Device-Id':'poco-fixture'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const create=async({authorize=true}={})=>{const r=await post('/api/android/evolution/requests',deviceToken,{request:'Pesquisar e desenvolver uma nova capacidade',clientRequestId:randomUUID()}); assert.equal(r.status,201);const id=r.body.task.id;
  if(authorize){const a=await post(`/api/evolution/owner/requests/${id}/authorize-development`,ownerToken,{});assert.equal(a.status,200);}return id;};
  const execute=async()=>processAuthorizedOnce({api,provider,repositories:{},worktreesDir:'/dev/null',execute:async({evolutionId,assertLease})=>{assertLease();return fakeGood(evolutionId);},heartbeatMs:1_000});
  return {...state,api,post,create,execute};
}

test('1: ponte real, cliente e dispatcher fixo: tarefa não autorizada fica invisível',async t=>{
  const f=await fixture(t);const id=await f.create({authorize:false});const r=await f.execute();assert.equal(r.status,'empty');assert.equal(f.tasks.get(id).state,'requested');assert.equal(f.audit.includes('claim'),false);
});
test('2: ciclo completo simulado claim -> renew -> report -> needs_review',async t=>{
  const f=await fixture(t);const id=await f.create();const r=await f.execute();assert.equal(r.taskId,id);assert.equal(r.status,'needs_review');assert.equal(r.reportAccepted,true);assert.equal(r.learned,false);assert.equal(r.installed,false);assert.equal(f.tasks.get(id).state,'needs_review');assert.deepEqual(f.audit.filter(x=>x==='report'),['report']);assert.equal(f.audit.filter(x=>x==='renew').length,2);
});
test('3: 12 workers concorrentes e exatamente uma finalização',async t=>{
  const f=await fixture(t);await f.create();const results=await Promise.all(Array.from({length:12},()=>f.execute()));assert.equal(results.filter(x=>x.status==='needs_review').length,1);assert.equal(results.filter(x=>x.status==='empty').length,11);assert.equal(f.audit.filter(x=>x==='report').length,1);
});
test('4: revogação administrativa após claim impede report e manutenção de lease',async t=>{
  const f=await fixture(t);const id=await f.create();await assert.rejects(processAuthorizedOnce({api:f.api,provider,repositories:{},worktreesDir:'/dev/null',execute:async()=>{f.revokeTask(id);return fakeGood(id);},heartbeatMs:1_000}),/Autorização de execução perdida/);assert.equal(f.audit.filter(x=>x==='report').length,0);assert.equal(f.tasks.get(id).revoked,true);
});
test('5: executor falhou -> blocked, sem habilidade publicada',async t=>{
  const f=await fixture(t);const id=await f.create();const result=await processAuthorizedOnce({api:f.api,provider,repositories:{},worktreesDir:'/dev/null',execute:async()=>{throw Error('Falha simulada de compilação');},heartbeatMs:1_000});assert.equal(result.status,'blocked');assert.equal(result.localExecutionFailed,true);assert.equal(f.tasks.get(id).state,'blocked');assert.equal(f.audit.filter(x=>x==='report').length,1);
});
test('6: relatório duplicado não gera auditoria extra',async t=>{
  const f=await fixture(t);await f.create();const lease=await f.api.claim();const outcome={status:'blocked',summary:'Falha simulada'};await f.api.report(lease.id,lease.leaseToken,outcome);await assert.rejects(f.api.report(lease.id,lease.leaseToken,outcome),/HTTP 409/);assert.equal(f.audit.filter(x=>x==='report').length,1);
});
test('7: reserva expirada e novo claim impedem worker antigo',async t=>{
  const f=await fixture(t);await f.create();const old=await f.api.claim();f.advanceTime(901_000);const fresh=await f.api.claim();assert.equal(fresh.id,old.id);assert.equal(fresh.attempt,2);await assert.rejects(f.api.renew(old.id,old.leaseToken),/HTTP 409/);await assert.rejects(f.api.report(old.id,old.leaseToken,{status:'blocked',summary:'antigo'}),/HTTP 409/);const valid=await f.api.report(fresh.id,fresh.leaseToken,{status:'blocked',summary:'novo'});assert.equal(valid.task.id,fresh.id);
});
test('8: revogação antes do claim recusa execução',async t=>{
  const f=await fixture(t);const id=await f.create();f.revokeTask(id);const r=await f.execute();assert.equal(r.status,'empty');assert.equal(f.audit.filter(x=>x==='report').length,0);
});
test('9: credenciais de proprietário e dispositivo não conseguem reivindicar',async t=>{
  const f=await fixture(t);const id=await f.create();const a=await f.post('/api/evolution/runner/claim',ownerToken);const b=await f.post('/api/evolution/runner/claim',deviceToken);assert.equal(a.status,401);assert.equal(b.status,401);const good=await f.api.claim();assert.equal(good.id,id);
});
test('10: terceira expiração bloqueia tarefa e impede quarta reivindicação',async t=>{
  const f=await fixture(t);const id=await f.create();for(let i=1;i<=3;i++){const lease=await f.api.claim();assert.equal(lease.attempt,i);f.advanceTime(901_000);}assert.equal(await f.api.claim(),null);assert.equal(f.tasks.get(id).state,'blocked');assert.equal(f.audit.filter(x=>x==='lease_exhausted').length,1);
});
