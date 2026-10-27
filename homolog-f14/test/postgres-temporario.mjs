#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createEvolutionStore } from "../jarvis-capabilities/evolution-additive-store.mjs";

async function main() {
  const raw = process.env.JARVIS_TEST_DATABASE_URL;
  if (!raw) throw new Error("Informe JARVIS_TEST_DATABASE_URL de um PostgreSQL descartável.");
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/(test|homolog|temporar)/i.test(database)) {
    throw new Error("Teste só aceita PostgreSQL local e banco explicitamente temporário.");
  }
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  const schema = `jarvis_phase11_${randomBytes(6).toString("hex")}`;
  const root = new Pool({connectionString:raw,max:1});
  let pool;
  let assertions = 0;
  try {
    await root.query(`CREATE SCHEMA "${schema}"`);
    const opts = {connectionString:raw,options:`-c search_path=${schema}`,max:3};
    pool = new Pool(opts);
    await pool.query(`CREATE TABLE jarvis_android_devices (
      device_id TEXT PRIMARY KEY,
      token_hash BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )`);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    await pool.query(
      "INSERT INTO jarvis_android_devices (device_id, token_hash, last_seen_at) VALUES ($1,$2,NOW())",
      ["poco-x5pro",hash]
    );
    const store = createEvolutionStore(pool);
    await store.initialize();
    const preserved = await pool.query(
      "SELECT device_id,token_hash FROM jarvis_android_devices WHERE device_id=$1",
      ["poco-x5pro"]
    );
    assert.equal(preserved.rowCount,1);
    assert.ok(Buffer.compare(preserved.rows[0].token_hash,hash)===0);
    assertions+=2;
    await assert.rejects(store.resolveOwner("poco-x5pro"),e=>e.status===403);
    assertions++;
    await store.bindDevice("poco-x5pro","owner_one");
    assert.equal(await store.resolveOwner("poco-x5pro"),"owner_one");
    assertions++;
    const idem=randomUUID();
    const request="Criar uma habilidade ainda não conhecida";
    const first=await store.create("owner_one",request,idem);
    const repeated=await store.create("owner_one",request,idem);
    assert.equal(first.id,repeated.id);
    assertions++;
    await assert.rejects(store.create("owner_one","outro objetivo",idem),e=>e.status===409);
    assertions++;
    assert.equal((await store.list("owner_two")).length,0);
    assertions++;
    assert.equal(await store.claim(),null);
    assertions++;
    await assert.rejects(store.authorize("owner_two",first.id),e=>e.status===404);
    assertions++;
    const approval=await store.authorize("owner_one",first.id);
    assert.equal(approval.developmentAuthorized,true);
    assertions++;
    const lease=await store.claim();
    assert.equal(lease.id,first.id);
    assertions++;
    assert.equal(await store.claim(),null);
    assertions++;
    const extended = await store.renewLease(first.id,lease.leaseToken);
    assert.equal(extended.id,first.id);
    assertions++;
    await assert.rejects(
      store.renewLease(first.id,"x".repeat(48)),e=>e.status===409
    );
    assertions++;
    await assert.rejects(store.report(first.id,"x".repeat(48),{
      status:"blocked",summary:"teste"
    }),e=>e.status===409);
    assertions++;
    const reported=await store.report(first.id,lease.leaseToken,{
      status:"blocked",summary:"Sem ambiente isolado para executar a habilidade."
    });
    assert.equal(reported.learned,false);
    assertions++;
    assert.equal(await store.claim(),null);
    assertions++;
    // Cenários adicionais de concorrência e invalidação executados em banco real.
    const next=await store.create("owner_one","Criar outra capacidade para teste",randomUUID());
    await store.authorize("owner_one",next.id);
    const claims=await Promise.all(Array.from({length:12},()=>store.claim()));
    const won=claims.filter(Boolean);
    assert.equal(won.length,1);
    assert.equal(won[0].id,next.id);
    assertions+=2;
    await pool.query("UPDATE jarvis_supervised_v11_requests SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1",[next.id]);
    await assert.rejects(store.renewLease(next.id,won[0].leaseToken),e=>e.status===409);
    const replacement=await store.claim();
    assert.equal(replacement.id,next.id);
    assert.notEqual(replacement.leaseToken,won[0].leaseToken);
    await assert.rejects(store.report(next.id,won[0].leaseToken,{status:"blocked",summary:"reserva antiga"}),e=>e.status===409);
    assertions+=4;
    await assert.rejects(store.revokeDevelopment("owner_two",next.id),e=>e.status===404);
    assert.equal((await store.revokeDevelopment("owner_one",next.id)).newlyRevoked,true);
    assert.equal((await store.revokeDevelopment("owner_one",next.id)).newlyRevoked,false);
    const events=await pool.query("SELECT event FROM jarvis_supervised_v11_audit WHERE request_id=$1 AND event='development_revoked'",[next.id]);
    assert.equal(events.rowCount,1);
    assertions+=4;
    await assert.rejects(store.renewLease(next.id,replacement.leaseToken),e=>e.status===409);
    await assert.rejects(store.report(next.id,replacement.leaseToken,{status:"needs_review",summary:"não autorizado",testsPassed:true,testsExecuted:true,commitSha:"a".repeat(40),branch:`work/evolution/${next.id}`}),e=>e.status===409);
    const row=await pool.query("SELECT state,report FROM jarvis_supervised_v11_requests WHERE id=$1",[next.id]);
    assert.equal(row.rows[0].state,"blocked");
    assert.equal(row.rows[0].report.learned,false);
    assertions+=4;
    // Revogação e conclusão disputam a mesma linha. Só uma pode vencer.
    for (let i=0;i<6;i++) {
      const race=await store.create("owner_one",`Capacidade teste corrida ${i}`,randomUUID());
      await store.authorize("owner_one",race.id);
      const reservation=await store.claim();
      assert.equal(reservation.id,race.id);
      const results=await Promise.allSettled([
        store.revokeDevelopment("owner_one",race.id),
        store.report(race.id,reservation.leaseToken,{status:"needs_review",summary:"proposta",testsPassed:true,testsExecuted:true,commitSha:"a".repeat(40),branch:`work/evolution/${race.id}`})
      ]);
      assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(results.filter(r=>r.status==="rejected").length,1);
      const state=await pool.query("SELECT state FROM jarvis_supervised_v11_requests WHERE id=$1",[race.id]);
      if (results[0].status==="fulfilled") assert.equal(state.rows[0].state,"blocked");
      else assert.equal(state.rows[0].state,"needs_review");
      assertions+=4;
    }
    await pool.end();
    pool=null;
    pool=new Pool(opts);
    const persisted=createEvolutionStore(pool);
    assert.equal((await persisted.list("owner_one")).length,8);
    assertions++;
    await pool.query(
      "UPDATE jarvis_android_devices SET revoked_at=NOW() WHERE device_id=$1",
      ["poco-x5pro"]
    );
    await assert.rejects(persisted.resolveOwner("poco-x5pro"),e=>e.status===403);
    assertions++;
    console.log(JSON.stringify({
      status:"PASS", assertions,
      postgresReal:true, temporarySchema:true,
      aiReal:false, androidPhysical:false,
      published:false, installed:false
    }));
  } finally {
    if(pool) await pool.end();
    try {await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}
    finally {await root.end()}
  }
}
main().catch(e=>{
  process.stderr.write(`TESTE POSTGRES FALHOU: ${e.message}\n`);
  process.exitCode=1;
});
