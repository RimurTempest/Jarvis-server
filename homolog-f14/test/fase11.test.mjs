import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  registerEvolutionBridge, validateEvolutionSettings
} from "../jarvis-capabilities/evolution-additive-bridge.mjs";
import {
  EVOLUTION_SCHEMA, validRequest, validId, createEvolutionStore
} from "../jarvis-capabilities/evolution-additive-store.mjs";

const require = createRequire(import.meta.url);
const { patchServer } = require("../integrate-production-base.cjs");

const uuid = "4d192bbf-ef17-4bf3-9b92-cba0f9299904";
const admin = "a".repeat(48);
const runner = "r".repeat(48);
const deviceToken = "d".repeat(48);
const env = {
  JARVIS_EVOLUTION_BRIDGE_ENABLED: "1",
  JARVIS_EVOLUTION_SINGLE_OWNER: "1",
  JARVIS_EVOLUTION_OWNER_ID: "owner_one",
  JARVIS_EVOLUTION_ADMIN_TOKEN: admin,
  JARVIS_EVOLUTION_RUNNER_TOKEN: runner,
  JARVIS_API_TOKEN: "c".repeat(48)
};
function mockHarness({ authorizedDevice = true, revoked = false } = {}) {
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h)
  };
  const events = [];
  const store = {
    initialize: async () => events.push("initialize"),
    resolveOwner: async () => {
      if (!authorizedDevice) throw Object.assign(new Error("não vinculado"), { status: 403 });
      return "owner_one";
    },
    bindDevice: async id => ({device_id: id}),
    create: async (_, request, clientId) => {
      events.push(`create:${request}:${clientId}`);
      return { id: uuid, state: "requested", development_authorized_at: null };
    },
    list: async () => [{ id: uuid, state: "requested", development_authorized_at: null }],
    authorize: async () => ({id:uuid, developmentAuthorized:true,newlyAuthorized:true}),
    claim: async () => ({id:uuid, leaseToken:"x".repeat(48), request:"capacidade nova"}),
    report: async () => ({id:uuid,state:"needs_review"})
  };
  registerEvolutionBridge({
    app, pool: {}, env, storeOverride: store,
    initializeLegacyRegistry: async () => events.push("legacy"),
    authenticateDevice: async (_pool, {token}) =>
      ({ok: !revoked && token === deviceToken})
  });
  async function call(method, path, {
    headers = {}, body = {}, params = {}
  } = {}) {
    const route = routes.get(`${method} ${path}`);
    assert.ok(route, `Rota ausente ${method} ${path}`);
    let status = 200; let result = null; const responseHeaders = {};
    const res = {
      setHeader(key, value) { responseHeaders[key] = value; },
      status(value) { status = value; return this; },
      json(value) { result = value; return this; }
    };
    await route({ headers, body, params }, res);
    return {status, result, responseHeaders};
  }
  return {call, events};
}
test("a ponte só ativa com configuração explícita de proprietário único", () => {
  assert.throws(() => validateEvolutionSettings({...env, JARVIS_EVOLUTION_SINGLE_OWNER:"0"}));
  assert.throws(() => validateEvolutionSettings({...env, JARVIS_EVOLUTION_BRIDGE_ENABLED:"0"}));
  assert.equal(validateEvolutionSettings(env).ownerId,"owner_one");
});
test("tokens administrativos não podem reutilizar token do chat ou executor", () => {
  assert.throws(() => validateEvolutionSettings({...env,JARVIS_EVOLUTION_ADMIN_TOKEN: runner}));
  assert.throws(() => validateEvolutionSettings({...env,JARVIS_EVOLUTION_RUNNER_TOKEN:env.JARVIS_API_TOKEN}));
});
test("migração mantém o cadastro legado intacto", () => {
  assert.match(EVOLUTION_SCHEMA,/device_id TEXT PRIMARY KEY REFERENCES jarvis_android_devices\(device_id\)/);
  assert.doesNotMatch(EVOLUTION_SCHEMA,/CREATE TABLE IF NOT EXISTS jarvis_android_devices \(/);
  assert.match(EVOLUTION_SCHEMA,/development_authorized_at/);
  assert.match(EVOLUTION_SCHEMA,/UNIQUE \(owner_id, client_request_id\)/);
});
test("pedido livre aceita linguagem natural e rejeita credenciais", () => {
  assert.equal(validRequest("  encontre uma maneira nova de organizar tarefas  "),"encontre uma maneira nova de organizar tarefas");
  assert.throws(() => validRequest("  "));
  assert.throws(() => validRequest("x".repeat(4001)));
  assert.throws(() => validRequest("Authorization: Bearer private_token"));
  assert.equal(validId(uuid),uuid);
  assert.throws(() => validId("../../../secret"));
});
test("Android sem Bearer não consegue consultar a evolução", async () => {
  const h=mockHarness();
  const res=await h.call("GET","/api/android/evolution/requests");
  assert.equal(res.status,401);
  assert.match(res.result.error,/Credencial/);
});
test("token Android válido, porém dispositivo não associado, recebe 403", async () => {
  const h=mockHarness({authorizedDevice:false});
  const res=await h.call("GET","/api/android/evolution/requests",{
    headers:{authorization:`Bearer ${deviceToken}`,"x-jarvis-device-id":"poco-x5pro"}
  });
  assert.equal(res.status,403);
});
test("credencial revogada recebe 401", async () => {
  const h=mockHarness({revoked:true});
  const res=await h.call("GET","/api/android/evolution/requests",{
    headers:{authorization:`Bearer ${deviceToken}`,"x-jarvis-device-id":"poco-x5pro"}
  });
  assert.equal(res.status,401);
});
test("Android consulta tarefas conforme contrato Kotlin", async () => {
  const h=mockHarness();
  const res=await h.call("GET","/api/android/evolution/requests",{
    headers:{authorization:`Bearer ${deviceToken}`,"x-jarvis-device-id":"poco-x5pro"}
  });
  assert.equal(res.status,200);
  assert.ok(Array.isArray(res.result.tasks));
  assert.equal(res.result.tasks[0].state,"requested");
  assert.equal(res.result.tasks[0].development_authorized_at,null);
});
test("Android registra solicitação mas não autoriza desenvolvimento", async () => {
  const h=mockHarness();
  const res=await h.call("POST","/api/android/evolution/requests",{
    headers:{authorization:`Bearer ${deviceToken}`,"x-jarvis-device-id":"poco-x5pro"},
    body:{request:"capacidade livre",clientRequestId:uuid}
  });
  assert.equal(res.status,201);
  assert.equal(res.result.task.id,uuid);
  assert.equal(res.result.installed,false);
  assert.equal(res.result.approved,false);
  assert.ok(h.events.includes(`create:capacidade livre:${uuid}`));
});
test("vinculação exige admin, confirmação e atividade autenticada recente no banco", async () => {
  const h=mockHarness();
  const path="/api/evolution/owner/devices/bind";
  const withoutConfirm=await h.call("POST",path,{
    headers:{authorization:`Bearer ${admin}`},body:{deviceId:"poco-x5pro"}
  });
  assert.equal(withoutConfirm.status,422);
  const invalidAdmin=await h.call("POST",path,{
    headers:{authorization:`Bearer ${deviceToken}`},
    body:{deviceId:"poco-x5pro",confirmOwnerBinding:true}
  });
  assert.equal(invalidAdmin.status,401);
  const ok=await h.call("POST",path,{
    headers:{authorization:`Bearer ${admin}`},
    body:{deviceId:"poco-x5pro",confirmOwnerBinding:true}
  });
  assert.equal(ok.status,200);
  assert.equal(ok.result.ownerBound,true);
  assert.equal(ok.result.approvedDevelopment,false);
});

test("Android e executor não podem autorizar desenvolvimento", async () => {
  const h=mockHarness();
  const path="/api/evolution/owner/requests/:id/authorize-development";
  for(const token of [deviceToken,runner]) {
    const response=await h.call("POST",path,{
      headers:{authorization:`Bearer ${token}`}, params:{id:uuid}
    });
    assert.equal(response.status,401);
  }
  const response=await h.call("POST",path,{
    headers:{authorization:`Bearer ${admin}`},params:{id:uuid}
  });
  assert.equal(response.status,200);
  assert.equal(response.result.installed,false);
});
test("somente token de executor reivindica trabalho", async () => {
  const h=mockHarness();
  const path="/api/evolution/runner/claim";
  assert.equal((await h.call("POST",path,{
    headers:{authorization:`Bearer ${admin}`}
  })).status,401);
  const result=await h.call("POST",path,{
    headers:{authorization:`Bearer ${runner}`}
  });
  assert.equal(result.status,200);
  assert.equal(result.result.permissions.publish,false);
  assert.equal(result.result.permissions.install,false);
});
test("lease é reivindicado em UPDATE atômico e não usa credencial do chat", () => {
  const calls=[];
  const pool={
    query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}},
    connect:async()=>({query:async()=>({rows:[]}),release(){}})
  };
  return createEvolutionStore(pool).claim().then(result=>{
    assert.equal(result,null);
    const query=calls.find(({sql})=>sql.includes('FOR UPDATE SKIP LOCKED'))?.sql;
    assert.ok(query);
    assert.match(query,/FOR UPDATE SKIP LOCKED/);
    assert.match(query,/development_authorized_at IS NOT NULL/);
    assert.match(query,/lease_expires_at < NOW\(\)/);
    assert.match(query,/attempts < 3/);
  });
});
test("worker nunca pode marcar habilidade como aprendida apenas com relatório", async () => {
  const h=mockHarness();
  const path="/api/evolution/runner/requests/:id/report";
  const result=await h.call("POST",path,{
    headers:{authorization:`Bearer ${runner}`},
    params:{id:uuid},
    body:{leaseToken:"x".repeat(48),outcome:{
      status:"needs_review",summary:"verificações locais",testsExecuted:true,
      testsPassed:true,commitSha:"f".repeat(40),branch:`work/evolution/${uuid}`
    }}
  });
  assert.equal(result.status,200);
  assert.equal(result.result.learned,false);
  assert.equal(result.result.installed,false);
});
test("instalador recusa server.js sem suporte a dez provedores", () => {
  assert.throws(()=>patchServer("import express from 'express';"));
});
test("instalador preserva a configuração de provedores", () => {
  const input=[
    'import { initializeAndroidDeviceRegistry } from "./jarvis-capabilities/android-device-registry.mjs";',
    'const pool = process.env.DATABASE_URL ? new Pool({}) : null;',
    "const providers = [];",
    "const MAX_AI_PROVIDERS = 10;"
  ].join("\n");
  const result=patchServer(input);
  assert.match(result,/authenticateAndroidDevice/);
  assert.match(result,/registerEvolutionBridge/);
  assert.match(result,/const MAX_AI_PROVIDERS = 10/);
  assert.match(result,/const providers = \[\]/);
  assert.throws(()=>patchServer(result));
});

test("idempotência: mesma chave e conteúdo retorna pedido existente", async () => {
  const prior={id:uuid,owner_id:"owner_one",request_text:"objetivo novo",client_request_id:uuid};
  const sql=[];
  const client={
    query:async (statement)=>{
      sql.push(statement);
      if (statement.includes("ON CONFLICT (owner_id, client_request_id) DO NOTHING"))
        return {rows:[],rowCount:0};
      if (statement.includes("SELECT * FROM jarvis_supervised_v11_requests"))
        return {rows:[prior],rowCount:1};
      return {rows:[],rowCount:0};
    }, release(){}
  };
  const store=createEvolutionStore({connect:async()=>client,query:async()=>({rows:[]})});
  const result=await store.create("owner_one","objetivo novo",uuid);
  assert.equal(result.id,uuid);
  assert.ok(sql.includes("COMMIT"));
});
test("idempotência: não reutiliza chave para pedido diferente", async () => {
  let rolledBack=false;
  const client={
    query:async (sql)=>{
      if(sql==="ROLLBACK"){rolledBack=true;return {rows:[]}};
      if(sql.includes("INSERT INTO jarvis_supervised_v11_requests"))return {rows:[]};
      if(sql.includes("SELECT * FROM jarvis_supervised_v11_requests"))
        return {rows:[{request_text:"pedido original"}]};
      return {rows:[]};
    },release(){}
  };
  const store=createEvolutionStore({connect:async()=>client,query:async()=>({rows:[]})});
  await assert.rejects(store.create("owner_one","pedido diferente",uuid),
    e=>e.status===409);
  assert.equal(rolledBack,true);
});
test("sem prova de testes isolados não aceita relatório de revisão", async () => {
  const store=createEvolutionStore({
    query:async()=>({rows:[]}),
    connect:async()=>({query:async()=>({rows:[]}),release(){}})
  });
  await assert.rejects(store.report(uuid,"z".repeat(48),{
    status:"needs_review",summary:"arquivo criado",
    testsExecuted:false,testsPassed:true,commitSha:"a".repeat(40),
    branch:`work/evolution/${uuid}`
  }),e=>e.status===422);
});
test("relatório de lease vencido falha sem confirmar habilidade", async () => {
  let rolledBack=false;
  const client={
    query:async (sql)=>{
      if (sql.includes("UPDATE jarvis_supervised_v11_requests"))return {rows:[]};
      if (sql==="ROLLBACK") rolledBack=true;
      return {rows:[]};
    },release(){}
  };
  const store=createEvolutionStore({
    query:async()=>({rows:[]}),connect:async()=>client
  });
  await assert.rejects(store.report(uuid,"z".repeat(48),{
    status:"blocked",summary:"sandbox indisponível"
  }),e=>e.status===409);
  assert.equal(rolledBack,true);
});
test("autorização filtra proprietário e bloqueia estado já em desenvolvimento",async()=>{
  const client={
    query:async (sql)=>{
      if(sql.includes("SELECT id, state, development_authorized_at"))
        return {rows:[{id:uuid,state:"claimed",development_authorized_at:new Date()}]};
      return {rows:[]};
    },release(){}
  };
  const store=createEvolutionStore({connect:async()=>client,query:async()=>({rows:[]})});
  await assert.rejects(store.authorize("owner_one",uuid),e=>e.status===409);
});

test("associação só aceita dispositivo com atividade autenticada recente", () => {
  const schema = EVOLUTION_SCHEMA;
  assert.match(schema,/REFERENCES jarvis_android_devices\(device_id\)/);
  const file = require("node:fs").readFileSync(
    new URL("../jarvis-capabilities/evolution-additive-store.mjs", import.meta.url),
    "utf8"
  );
  assert.match(file,/last_seen_at > NOW\(\) - INTERVAL '15 minutes'/);
  assert.doesNotMatch(schema,/ALTER TABLE jarvis_android_devices/);
});

test("instalador rejeita rota de evolução duplicada", () => {
  const input=[
    'import { initializeAndroidDeviceRegistry } from "./jarvis-capabilities/android-device-registry.mjs";',
    'const pool = process.env.DATABASE_URL ? new Pool({}) : null;',
    "const providers = [];",
    "const MAX_AI_PROVIDERS = 10;",
    `app.get("/api/android/evolution/requests", handler);`
  ].join("\n");
  assert.throws(()=>patchServer(input),/Rotas legadas/);
});
