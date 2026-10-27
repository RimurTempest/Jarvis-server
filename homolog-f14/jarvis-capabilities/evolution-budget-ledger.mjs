import { randomUUID, randomBytes, createHash } from "node:crypto";
import { validId, hashToken } from "./evolution-additive-store.mjs";

// Isolated prototype: quote/usage calculators must be trusted server code.
// This module does not itself invoke a provider or claim to cap provider billing.
const CAP_MICROUSD=5_000_000, MAX_CALLS=4, MAX_REPAIRS=2;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=x=>createHash("sha256").update(x,"utf8").digest();
const amount=(n)=>Number.isSafeInteger(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER;
const validLease=t=>typeof t==="string"&&/^[A-Za-z0-9_-]{40,100}$/.test(t);
const validReceipt=t=>typeof t==="string"&&/^[A-Za-z0-9_-]{40,100}$/.test(t);

export function createBudgetLedger(pool,{quoteForCall, costFromUsage}={}) {
  if(!pool?.connect||!pool?.query||typeof quoteForCall!=="function"||typeof costFromUsage!=="function") throw new TypeError("Pool e política confiável de preços obrigatórios.");
  async function tx(fn){const c=await pool.connect();try{await c.query("BEGIN");const v=await fn(c);await c.query("COMMIT");return v;}catch(e){try{await c.query("ROLLBACK")}catch{}throw e;}finally{c.release();}}
  async function initialize(){await pool.query(`
    CREATE TABLE IF NOT EXISTS jarvis_evolution_budget (
      request_id UUID PRIMARY KEY REFERENCES jarvis_supervised_v11_requests(id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()+INTERVAL '15 minutes')
    );
    CREATE TABLE IF NOT EXISTS jarvis_evolution_budget_calls (
      id UUID PRIMARY KEY, request_id UUID NOT NULL REFERENCES jarvis_evolution_budget(request_id),
      receipt_hash BYTEA NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('research','generate','repair')),
      model TEXT NOT NULL, quote_version TEXT NOT NULL, reserved_micros BIGINT NOT NULL CHECK(reserved_micros > 0),
      charged_micros BIGINT, input_tokens BIGINT, output_tokens BIGINT,
      state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown','overrun')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS jarvis_evolution_budget_calls_request_idx ON jarvis_evolution_budget_calls(request_id);
  `);}
  async function reserve(id,leaseToken,{kind,model,bodyBytes,maxOutputTokens,hasWebSearch}={}) {
    const requestId=validId(id);
    if(!validLease(leaseToken))throw fail(401,"Reserva de execução inválida.");
    if(!["research","generate","repair"].includes(kind)||typeof model!=="string"||model.length>80||
       !Number.isSafeInteger(bodyBytes)||bodyBytes<1||bodyBytes>120_000||
       !Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>24_000||typeof hasWebSearch!=="boolean") throw fail(422,"Parâmetros de orçamento inválidos.");
    const quote=quoteForCall({kind,model,bodyBytes,maxOutputTokens,hasWebSearch});
    if(!quote||!amount(quote.maximumMicros)||quote.maximumMicros===0||
       typeof quote.version!=="string"||!quote.version||quote.version.length>100) throw fail(403,"Custo máximo não comprovado; chamada bloqueada.");
    return tx(async c=>{
      const active=await c.query(`SELECT id FROM jarvis_supervised_v11_requests
         WHERE id=$1 AND state='claimed' AND development_authorized_at IS NOT NULL
           AND lease_hash=$2 AND lease_expires_at>clock_timestamp()
           AND lease_started_at>clock_timestamp()-INTERVAL '90 minutes' FOR UPDATE`,[requestId,hashToken(leaseToken)]);
      if(active.rowCount!==1)throw fail(409,"Reserva expirada ou revogada.");
      await c.query(`INSERT INTO jarvis_evolution_budget(request_id) VALUES($1) ON CONFLICT DO NOTHING`,[requestId]);
      const budget=await c.query(`SELECT expires_at, expires_at>clock_timestamp() AS active FROM jarvis_evolution_budget WHERE request_id=$1 FOR UPDATE`,[requestId]);
      if(!budget.rows[0].active)throw fail(409,"Prazo total de 15 minutos esgotado.");
      const previous=await c.query(`SELECT kind,state,reserved_micros,charged_micros FROM jarvis_evolution_budget_calls WHERE request_id=$1`,[requestId]);
      const rows=previous.rows;
      if(rows.some(r=>r.state==="reserved"))throw fail(409,"Uma tentativa já está em andamento ou não foi reconciliada.");
      if(rows.some(r=>r.state==="overrun"))throw fail(409,"Consumo excedeu a previsão; revisão necessária.");
      if(rows.length>=MAX_CALLS)throw fail(409,"Limite de quatro chamadas atingido.");
      if(kind==="research"&&rows.length!==0)throw fail(409,"Pesquisa já iniciada.");
      if(kind==="generate"&&(!rows.some(r=>r.kind==="research"&&r.state==="settled")||rows.some(r=>r.kind==="generate")))throw fail(409,"Geração exige pesquisa concluída e única.");
      if(kind==="repair"&&(!rows.some(r=>r.kind==="generate"&&r.state==="settled")||rows.filter(r=>r.kind==="repair").length>=MAX_REPAIRS))throw fail(409,"Limite de correções atingido ou geração não concluída.");
      const used=rows.reduce((sum,r)=>sum+Number(r.state==="settled"?r.charged_micros:r.reserved_micros),0);
      if(!amount(used)||used+quote.maximumMicros>CAP_MICROUSD)throw fail(409,"Teto de US$ 5 pode ser excedido.");
      const callId=randomUUID(),receipt=randomBytes(32).toString("base64url");
      await c.query(`INSERT INTO jarvis_evolution_budget_calls(id,request_id,receipt_hash,kind,model,quote_version,reserved_micros,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reserved')`,[callId,requestId,hash(receipt),kind,model,quote.version,quote.maximumMicros]);
      return {callId,receipt,reservedMicros:quote.maximumMicros,remainingMicros:CAP_MICROUSD-used-quote.maximumMicros,expiresAt:budget.rows[0].expires_at};
    });
  }
  async function settle(id,receipt,usage) {
    const callId=validId(id);if(!validReceipt(receipt))throw fail(401,"Recibo inválido.");
    return tx(async c=>{
      const found=await c.query(`SELECT * FROM jarvis_evolution_budget_calls WHERE id=$1 AND receipt_hash=$2 FOR UPDATE`,[callId,hash(receipt)]);
      const row=found.rows[0];if(!row)throw fail(404,"Tentativa não encontrada.");
      if(row.state!=="reserved")throw fail(409,"Tentativa já finalizada.");
      if(usage===null){await c.query(`UPDATE jarvis_evolution_budget_calls SET state='unknown',finished_at=clock_timestamp() WHERE id=$1`,[callId]);return {state:"unknown",chargedMicros:Number(row.reserved_micros)};}
      if(!usage||!Number.isSafeInteger(usage.inputTokens)||usage.inputTokens<0||!Number.isSafeInteger(usage.outputTokens)||usage.outputTokens<0)throw fail(422,"Uso do provedor inválido.");
      const charged=costFromUsage({model:row.model,kind:row.kind,quoteVersion:row.quote_version,usage});
      if(!amount(charged))throw fail(422,"Custo do provedor não verificável.");
      const state=charged>Number(row.reserved_micros)?"overrun":"settled";
      await c.query(`UPDATE jarvis_evolution_budget_calls SET state=$2,charged_micros=$3,input_tokens=$4,output_tokens=$5,finished_at=clock_timestamp() WHERE id=$1`,[callId,state,charged,usage.inputTokens,usage.outputTokens]);
      return {state,chargedMicros:charged};
    });
  }
  return {initialize,reserve,settle};
}
