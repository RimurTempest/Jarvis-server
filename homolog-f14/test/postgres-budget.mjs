import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createEvolutionStore,hashToken} from '../jarvis-capabilities/evolution-additive-store.mjs';
import {createBudgetLedger} from '../jarvis-capabilities/evolution-budget-ledger.mjs';
const url=process.env.JARVIS_TEST_DATABASE_URL;if(!url)throw Error('PostgreSQL temporário obrigatório.');
const parsed=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!/(test|homolog|temporar)/i.test(parsed.pathname))throw Error('Banco não é temporário local.');
const schema='jarvis_budget_'+randomBytes(6).toString('hex'),root=new pg.Pool({connectionString:url,max:1});let pool;
try {
 await root.query(`CREATE SCHEMA "${schema}"`);
 pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
 await pool.query('CREATE TABLE jarvis_android_devices (device_id TEXT PRIMARY KEY,token_hash BYTEA NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),last_seen_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ)');
 const store=createEvolutionStore(pool);await store.initialize();
 const ledger=createBudgetLedger(pool,{quoteForCall:({model})=>model==='unknown'?null:{maximumMicros:model==='high'?3_000_000:1_000_000,version:'test-only'},costFromUsage:({usage})=>usage.inputTokens});await ledger.initialize();
 const token='x'.repeat(43),model='simulated';
 const params=kind=>({kind,model,bodyBytes:100,maxOutputTokens:200,hasWebSearch:kind==='research'});
 async function task(){const t=await store.create('owner_one','Pedir desenvolvimento seguro',randomUUID());await store.authorize('owner_one',t.id);const claimed=await store.claim();assert.equal(claimed.id,t.id);return claimed;}
 async function reserve(t,kind,over={}){return ledger.reserve(t.id,t.leaseToken,{...params(kind),...over});}
 async function finish(r,cost=200_000){return ledger.settle(r.callId,r.receipt,{inputTokens:cost,outputTokens:5});}
 let assertions=0;
 const a=await task();
 await assert.rejects(reserve(a,'research',{model:'unknown'}),e=>e.status===403);assertions++;
 const research=await reserve(a,'research');assert.equal((await finish(research)).state,'settled');assertions++;
 const contenders=await Promise.allSettled(Array.from({length:8},()=>reserve(a,'generate')));const winners=contenders.filter(x=>x.status==='fulfilled');assert.equal(winners.length,1);assertions++;
 await finish(winners[0].value);await assert.rejects(reserve(a,'generate'),e=>e.status===409);assertions++;
 const repair1=await reserve(a,'repair');await finish(repair1);const repair2=await reserve(a,'repair');await finish(repair2);
 await assert.rejects(reserve(a,'repair'),e=>e.status===409);assertions++;
 const rows=await pool.query('SELECT count(*)::int AS n FROM jarvis_evolution_budget_calls WHERE request_id=$1',[a.id]);assert.equal(rows.rows[0].n,4);assertions++;
 await assert.rejects(finish(repair2),e=>e.status===409);assertions++;
 await store.report(a.id,a.leaseToken,{status:'blocked',summary:'fim do teste'});
 const b=await task(),high=await reserve(b,'research',{model:'high'});await finish(high,3_000_000);
 await assert.rejects(reserve(b,'generate',{model:'high'}),e=>e.status===409);assertions++;
 await store.report(b.id,b.leaseToken,{status:'blocked',summary:'fim'});
 const c=await task(),uncertain=await reserve(c,'research');assert.equal((await ledger.settle(uncertain.callId,uncertain.receipt,null)).state,'unknown');
 const stored=await pool.query('SELECT state,reserved_micros FROM jarvis_evolution_budget_calls WHERE id=$1',[uncertain.callId]);assert.equal(stored.rows[0].state,'unknown');assert.equal(Number(stored.rows[0].reserved_micros),1_000_000);assertions+=3;
 await assert.rejects(reserve(c,'generate'),e=>e.status===409);assertions++;
 await store.report(c.id,c.leaseToken,{status:'blocked',summary:'fim'});
 const d=await task(),deadline=await reserve(d,'research');await finish(deadline);
 await pool.query("UPDATE jarvis_evolution_budget SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",[d.id]);
 await assert.rejects(reserve(d,'generate'),e=>e.status===409);assertions++;
 await store.report(d.id,d.leaseToken,{status:'blocked',summary:'fim'});
 const e=await task(),r=await reserve(e,'research');await finish(r);
 await store.revokeDevelopment('owner_one',e.id);
 await assert.rejects(reserve(e,'generate'),err=>err.status===409);assertions++;
 const f=await task(),overspent=await reserve(f,'research');assert.equal((await finish(overspent,1_500_000)).state,'overrun');
 await assert.rejects(reserve(f,'generate'),err=>err.status===409);assertions+=2;
 console.log(JSON.stringify({status:'PASS',assertions,postgresReal:true,temporarySchema:true,providerCalls:false,production:false}));
} finally {if(pool)await pool.end();try{await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await root.end();}}
