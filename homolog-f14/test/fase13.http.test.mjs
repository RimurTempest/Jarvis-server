import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { registerEvolutionBridge } from "../jarvis-capabilities/evolution-additive-bridge.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPhase11Api } = require("../worker/phase11-api.cjs");
const { createEvolutionStore } = await import("../jarvis-capabilities/evolution-additive-store.mjs");

const ownerToken = "A".repeat(48);
const runnerToken = "R".repeat(48);
const deviceToken = "D".repeat(48);
const chatToken = "C".repeat(48);
const deviceId = "poco-test-01";
const ownerId = "owner_test_01";
const env = {
  JARVIS_EVOLUTION_BRIDGE_ENABLED: "1",
  JARVIS_EVOLUTION_SINGLE_OWNER: "1",
  JARVIS_EVOLUTION_OWNER_ID: ownerId,
  JARVIS_EVOLUTION_ADMIN_TOKEN: ownerToken,
  JARVIS_EVOLUTION_RUNNER_TOKEN: runnerToken,
  JARVIS_API_TOKEN: chatToken
};
const error = (status, message) => Object.assign(new Error(message), {status});

function makeTestStore() {
  const tasks = new Map();
  let deviceBound = false;
  let deviceRevoked = false;
  let leaseSerial = 0;
  let claimedLease = null;
  const owner = () => ownerId;
  return {
    tasks,
    revoke: () => { deviceRevoked = true; },
    authenticateDevice: async (_pool, {deviceId: d, token}) => ({
      ok: d === deviceId && token === deviceToken && !deviceRevoked
    }),
    store: {
      initialize: async () => {},
      bindDevice: async (d, o) => {
        if (d !== deviceId || o !== owner()) throw error(403, "Vínculo inválido");
        deviceBound = true;
        return {device_id: d, owner_id: o};
      },
      resolveOwner: async d => {
        if (!deviceBound || d !== deviceId || deviceRevoked) throw error(403, "Não vinculado");
        return ownerId;
      },
      create: async (o, request, idem) => {
        if (o !== owner()) throw error(403, "Proprietário inválido");
        if (typeof request !== "string" || !request.trim()) throw error(422, "Pedido inválido");
        const existing = [...tasks.values()].find(x => x.clientRequestId === idem);
        if (existing) {
          if (existing.request_text !== request) throw error(409, "Idempotência em conflito");
          return existing;
        }
        const task = {id:randomUUID(),owner_id:o,request_text:request,
          clientRequestId:idem,state:"requested",developmentAuthorized:false};
        tasks.set(task.id, task);
        return task;
      },
      list: async o => [...tasks.values()].filter(x=>x.owner_id === o),
      authorize: async (o, id) => {
        const item = tasks.get(id);
        if (!item || item.owner_id !== o) throw error(404,"Não encontrado");
        item.developmentAuthorized = true;
        return {id,developmentAuthorized:true,newlyAuthorized:true};
      },
      claim: async () => {
        const item = [...tasks.values()].find(x=>x.developmentAuthorized && x.state==="requested");
        if (!item) return null;
        item.state = "claimed";
        claimedLease = "L".repeat(48);
        leaseSerial++;
        return {id:item.id,request:item.request_text,leaseToken:claimedLease,attempt:leaseSerial};
      },
      renewLease: async (id, token) => {
        if (token !== claimedLease || tasks.get(id)?.state !== "claimed")
          throw error(409,"Lease inválido");
        return {id,lease_expires_at:new Date(Date.now()+50000).toISOString()};
      },
      report: async (id, token, outcome) => {
        const item = tasks.get(id);
        if (!item || item.state !== "claimed" || token !== claimedLease)
          throw error(409,"Lease inválido");
        if (!["blocked","needs_review"].includes(outcome?.status))
          throw error(422,"Resultado inválido");
        item.state = outcome.status;
        return {id,state:item.state,installed:false,learned:false};
      }
    }
  };
}

// Mini-adaptador HTTP restrito aos testes: não substitui Express nem PostgreSQL.
function createHttpRoutes(appRoutes) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let entry, match;
    for (const r of appRoutes) {
      if (r.method !== req.method) continue;
      match = r.regex.exec(url.pathname);
      if (match) { entry = r; break; }
    }
    if (!entry) {
      res.writeHead(404, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:"Not Found"}));
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 64_000) { res.writeHead(413); res.end(); return; }
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { res.writeHead(400); res.end(); return; }
    req.body = body;
    req.params = Object.fromEntries(entry.keys.map((k,i)=>[k,match[i+1]]));
    res.status = n => {res.statusCode=n;return res;};
    res.json = object => {
      if (res.writableEnded) return res;
      res.setHeader("Content-Type","application/json");
      res.end(JSON.stringify(object));
      return res;
    };
    try {await entry.fn(req,res);}
    catch {if (!res.writableEnded) res.status(500).json({error:"Erro de teste"});}
  });
}

async function startBridge(t) {
  const routes = [];
  const add = (method, pattern, fn) => {
    const keys = [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map(x=>x[1]);
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")
      .replace(/:([A-Za-z0-9_]+)/g,"([^/]+)");
    routes.push({method, regex:new RegExp(`^${escaped}$`),keys,fn});
  };
  const app = {get:(p,fn)=>add("GET",p,fn), post:(p,fn)=>add("POST",p,fn)};
  const state = makeTestStore();
  registerEvolutionBridge({
    app, pool: {}, env, storeOverride: state.store,
    initializeLegacyRegistry:async()=>{},
    authenticateDevice:state.authenticateDevice
  });
  const server = createHttpRoutes(routes);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>await new Promise((resolve,reject)=>
    server.close(err=>err?reject(err):resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (method,path,token,body,headers={}) => {
    const r=await fetch(`${origin}${path}`,{
      method,headers:{
        ...(token?{Authorization:`Bearer ${token}`}:{ }),
        ...headers,
        "Content-Type":"application/json"
      },...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    return {status:r.status,body:await r.json()};
  };
  return {state,request,origin};
}

test("HTTP real: sem vínculo dispositivo não consulta nem registra",async t=>{
  const {request}=await startBridge(t);
  const headers={"X-Jarvis-Device-Id":deviceId};
  const r=await request("GET","/api/android/evolution/requests",deviceToken,undefined,headers);
  assert.equal(r.status,403);
  const created=await request("POST","/api/android/evolution/requests",deviceToken,
    {request:"capacidade inédita",clientRequestId:randomUUID()},headers);
  assert.equal(created.status,403);
});

test("HTTP real: registro idempotente, sem autorizar desenvolvimento",async t=>{
  const {request}=await startBridge(t);
  const headers={"X-Jarvis-Device-Id":deviceId};
  const bind=await request("POST","/api/evolution/owner/devices/bind",ownerToken,
    {deviceId,confirmOwnerBinding:true});
  assert.equal(bind.status,200);
  const idem=randomUUID();
  const body={request:"nova capacidade genérica",clientRequestId:idem};
  const first=await request("POST","/api/android/evolution/requests",deviceToken,body,headers);
  const retry=await request("POST","/api/android/evolution/requests",deviceToken,body,headers);
  assert.equal(first.status,201);
  assert.equal(retry.body.task.id,first.body.task.id);
  const pending=await request("POST","/api/evolution/runner/claim",runnerToken,{});
  assert.equal(pending.status,200);
  assert.equal(pending.body.task,null);
  const wrong=await request("POST","/api/android/evolution/requests",deviceToken,
    {request:"outro pedido",clientRequestId:idem},headers);
  assert.equal(wrong.status,409);
});

test("HTTP real: autorização separada, lease, relatório, sem aprender",async t=>{
  const {request,origin}=await startBridge(t);
  const headers={"X-Jarvis-Device-Id":deviceId};
  await request("POST","/api/evolution/owner/devices/bind",ownerToken,
    {deviceId,confirmOwnerBinding:true});
  const created=await request("POST","/api/android/evolution/requests",deviceToken,
    {request:"capacidade inédita",clientRequestId:randomUUID()},headers);
  const id=created.body.task.id;
  const forbidden=await request("POST",`/api/evolution/owner/requests/${id}/authorize-development`,
    deviceToken,{});
  assert.equal(forbidden.status,401);
  const owner=await request("POST",`/api/evolution/owner/requests/${id}/authorize-development`,
    ownerToken,{});
  assert.equal(owner.status,200);
  const api=createPhase11Api({
    baseUrl:origin, token:runnerToken, allowLocalHttp:true
  });
  const claimed=await api.claim();
  assert.equal(claimed.id,id);
  assert.equal(claimed.request,"capacidade inédita");
  const renew=await api.renew(id,claimed.leaseToken);
  assert.equal(renew.id,id);
  const result=await api.report(id,claimed.leaseToken,{
    status:"blocked", summary:"Aguardando ambiente isolado e IA real.",
    testsExecuted:false,testsPassed:false
  });
  assert.equal(result.task.state,"blocked");
  assert.equal(result.learned,false);
  assert.equal(result.installed,false);
  const anotherClaim=await api.claim();
  assert.equal(anotherClaim,null);
});

test("HTTP real: revogação impede acesso ao histórico",async t=>{
  const {request,state}=await startBridge(t);
  const headers={"X-Jarvis-Device-Id":deviceId};
  await request("POST","/api/evolution/owner/devices/bind",ownerToken,
    {deviceId,confirmOwnerBinding:true});
  assert.equal((await request("GET","/api/android/evolution/requests",deviceToken,
    undefined,headers)).status,200);
  state.revoke();
  assert.equal((await request("GET","/api/android/evolution/requests",deviceToken,
    undefined,headers)).status,401);
  assert.equal((await request("GET","/api/android/evolution/requests",chatToken,
    undefined,headers)).status,401);
});

test("consultas SQL impedem tarefas exauridas de permanecer claimed",async()=>{
  const calls=[];
  const fakePool={
    query:async(sql,params)=>{calls.push({sql,params});return {rows:[]}},
    connect:async()=>({query:async()=>({rows:[]}),release(){}})
  };
  assert.equal(await createEvolutionStore(fakePool).claim(),null);
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/attempts >= 3/);
  assert.match(calls[0].sql,/lease_expires_at <= NOW\(\)/);
  assert.match(calls[0].sql,/state = 'blocked'/);
  assert.match(calls[0].sql,/lease_exhausted/);
  assert.match(calls[1].sql,/FOR UPDATE SKIP LOCKED/);
});
