"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { createPhase11Api } = require("../worker/phase11-api.cjs");
const { processAuthorizedOnce, reportOutcome, safeSummary } =
  require("../worker/phase11-dispatcher.cjs");

const ID = "12345678-1234-4234-8234-123456789abc";
const TOKEN = "A".repeat(48);
const SECRET = "B".repeat(48);
const REQUEST = "Desenvolver capacidade inédita sem especificar implementação";
const permissions = Object.freeze({ publish: false, install: false, deploy: false });

async function startFixture(options = {}) {
  const state = {
    now: 0, attempts: 0, status: options.empty ? "empty" : "authorized",
    revoked: false, token: null, expiresAt: null,
    renewCount: 0, reports: [], audit: []
  };
  const server = http.createServer(async (req, res) => {
    function reply(status, body) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    }
    if (req.method !== "POST") return reply(405, { error: "method" });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply(401, { error: "unauthorized" });
    }
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk.toString("utf8");
        if (raw.length > 16000) return reply(413, { error: "size" });
      }
    } catch { return reply(400, { error: "body" }); }
    let body;
    try { body = JSON.parse(raw || "{}"); }
    catch { return reply(400, { error: "json" }); }
    const prefix = "/api/evolution/runner/";
    if (!req.url.startsWith(prefix)) return reply(404, { error: "not-found" });
    if (req.url === prefix + "claim") {
      if (options.missingPermissions) {
        return reply(200, { task: null });
      }
      if (options.redirectClaim) {
        res.writeHead(302, { location: "https://example.org/" });
        return res.end();
      }
      if (state.status === "claimed" && state.expiresAt <= state.now) {
        state.status = state.attempts >= 3 ? "blocked" : "authorized";
        state.token = null;
        state.expiresAt = null;
        state.audit.push(state.status === "blocked" ? "attempts_exhausted" : "lease_expired");
      }
      if (state.status !== "authorized" || state.revoked) {
        return reply(200, { permissions, task: null });
      }
      state.attempts++;
      state.token = crypto.randomBytes(32).toString("base64url");
      state.expiresAt = state.now + 15 * 60 * 1000;
      state.status = "claimed";
      state.audit.push("claim");
      return reply(200, {
        permissions,
        task: { id: options.invalidId ? "INVALID" : ID, request: REQUEST,
          leaseToken: state.token, attempt: state.attempts }
      });
    }
    const match = req.url.match(/^\/api\/evolution\/runner\/requests\/([^/]+)\/(renew|report)$/);
    if (!match || match[1] !== ID) return reply(404, { error: "not-found" });
    if (state.status !== "claimed" || state.revoked ||
        state.expiresAt <= state.now || body.leaseToken !== state.token) {
      return reply(409, { error: "inactive-lease" });
    }
    if (match[2] === "renew") {
      state.renewCount++;
      state.expiresAt = state.now + 15 * 60 * 1000;
      state.audit.push("renew");
      return reply(200, { permissions, lease: { id: ID, expiresAt: state.expiresAt } });
    }
    if (!body.outcome || !["needs_review", "blocked"].includes(body.outcome.status)) {
      return reply(422, { error: "invalid-outcome" });
    }
    state.status = "reported";
    state.reports.push(body.outcome);
    state.audit.push("report");
    return reply(200, {
      task: { id: ID, state: "needs_review" },
      learned: false, installed: false, published: false
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  return {
    state, baseUrl,
    api: createPhase11Api({ baseUrl, token: TOKEN, allowLocalHttp: true }),
    close: async () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}

async function fixtureTest(name, run, options = {}) {
  await test(name, async () => {
    const f = await startFixture(options);
    try { await run(f); }
    finally { await f.close(); }
  });
}

const fakeProvider = {
  research: async () => { throw new Error("IA real não deve ser invocada neste teste"); },
  generate: async () => { throw new Error("Geração de código não deve acontecer neste teste"); }
};
function simulatedSuccess(id) {
  return {
    taskId: id,
    applied: true,
    localTestsValidated: true,
    isolatedTests: { executed: true, passed: true },
    localCommitSha: "a".repeat(40),
    branch: `work/evolution/${id}`,
    remoteTouched: false, installed: false,
    capabilityLearned: false, readyForRelease: false,
    summary: "SUCESSO SIMULADO: nenhuma habilidade foi realmente desenvolvida."
  };
}

(async () => {
  await fixtureTest("01 cliente original: fila vazia devolve null", async f => {
    assert.equal(await f.api.claim(), null);
  }, { empty: true });

  await fixtureTest("02 cliente original: claim autorizado", async f => {
    const task = await f.api.claim();
    assert.equal(task.id, ID);
    assert.equal(task.request, REQUEST);
    assert.equal(task.attempt, 1);
    assert.match(task.leaseToken, /^[A-Za-z0-9_-]{40,100}$/);
  });

  await fixtureTest("03 cliente original: token do worker inválido rejeitado", async f => {
    const bad = createPhase11Api({ baseUrl: f.baseUrl, token: SECRET, allowLocalHttp: true });
    await assert.rejects(bad.claim(), /HTTP 401/);
  });

  await fixtureTest("04 cliente original: política de permissão obrigatória", async f => {
    await assert.rejects(f.api.claim(), /restrições do executor/);
  }, { missingPermissions: true });

  await fixtureTest("05 cliente original: claim concorrente tem só um vencedor", async f => {
    const results = await Promise.all(Array.from({ length: 12 }, () => f.api.claim()));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.state.attempts, 1);
  });

  await fixtureTest("06 cliente original: renew exige token atual", async f => {
    const t = await f.api.claim();
    await assert.rejects(f.api.renew(t.id, SECRET), /HTTP 409/);
    assert.equal(f.state.renewCount, 0);
  });

  await fixtureTest("07 cliente original: renew prolonga reserva", async f => {
    const t = await f.api.claim();
    f.state.now = 10 * 60 * 1000;
    const renewed = await f.api.renew(t.id, t.leaseToken);
    assert.equal(renewed.id, t.id);
    assert.equal(f.state.expiresAt, 25 * 60 * 1000);
    assert.equal(f.state.renewCount, 1);
  });

  await fixtureTest("08 cliente original: report pede revisão e não aprende", async f => {
    const t = await f.api.claim();
    const result = await f.api.report(t.id, t.leaseToken, {
      status: "needs_review", summary: "simulado",
      testsExecuted: true, testsPassed: true
    });
    assert.equal(result.learned, false);
    assert.equal(result.installed, false);
    assert.equal(result.published, false);
    assert.equal(f.state.reports.length, 1);
  });

  await fixtureTest("09 revogação simulada impede renew e report", async f => {
    const t = await f.api.claim();
    f.state.revoked = true;
    await assert.rejects(f.api.renew(t.id, t.leaseToken), /HTTP 409/);
    await assert.rejects(f.api.report(t.id, t.leaseToken, {
      status: "blocked"
    }), /HTTP 409/);
  });

  await fixtureTest("10 token expirado não renova nem relata", async f => {
    const t = await f.api.claim();
    f.state.now += 16 * 60 * 1000;
    await assert.rejects(f.api.renew(t.id, t.leaseToken), /HTTP 409/);
    await assert.rejects(f.api.report(t.id, t.leaseToken, { status: "blocked" }), /HTTP 409/);
  });

  await fixtureTest("11 terceira expiração bloqueia tarefa no simulador", async f => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const task = await f.api.claim();
      assert.equal(task.attempt, attempt);
      f.state.now += 16 * 60 * 1000;
    }
    assert.equal(await f.api.claim(), null);
    assert.equal(f.state.status, "blocked");
    assert.ok(f.state.audit.includes("attempts_exhausted"));
  });

  await fixtureTest("12 report com UUID diferente falha", async f => {
    const t = await f.api.claim();
    await assert.rejects(f.api.report(
      "00000000-0000-4000-8000-000000000000", t.leaseToken,
      { status: "blocked" }), /HTTP 404/);
  });

  await fixtureTest("13 report duplicado é rejeitado", async f => {
    const t = await f.api.claim();
    await f.api.report(t.id, t.leaseToken, { status: "blocked" });
    await assert.rejects(f.api.report(t.id, t.leaseToken, {
      status: "blocked"
    }), /HTTP 409/);
    assert.equal(f.state.reports.length, 1);
  });

  await fixtureTest("14 URL HTTP externo não é aceita", async () => {
    assert.throws(() => createPhase11Api({
      baseUrl: "http://example.org/", token: TOKEN, allowLocalHttp: true
    }), /HTTPS/);
  });

  await fixtureTest("15 redirect não é seguido", async f => {
    await assert.rejects(f.api.claim(), /HTTP 302/);
  }, { redirectClaim: true });

  await fixtureTest("16 UUID inválido no claim é rejeitado", async f => {
    await assert.rejects(f.api.claim(), /UUID válido/);
  }, { invalidId: true });

  await fixtureTest("17 dispatcher original: percurso integrado com execução simulada", async f => {
    let calls = 0;
    const result = await processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      repositories: {},
      worktreesDir: "/tmp/nao-utilizada",
      execute: async ({ evolutionId, api, assertLease }) => {
        calls++;
        assertLease();
        const ctx = await api.context(evolutionId);
        assert.equal(ctx.task.state, "requested");
        await api.advance(evolutionId, "researching");
        await api.advance(evolutionId, "planned");
        return simulatedSuccess(evolutionId);
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.reportAccepted, true);
    assert.equal(result.learned, false);
    assert.equal(result.installed, false);
    assert.equal(result.published, false);
    assert.equal(f.state.reports[0].status, "needs_review");
  });

  await fixtureTest("18 dispatcher original: tarefa vazia não executa", async f => {
    let calls = 0;
    const result = await processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      execute: async () => { calls++; throw new Error("nunca"); }
    });
    assert.equal(result.status, "empty");
    assert.equal(calls, 0);
  }, { empty: true });

  await fixtureTest("19 dispatcher: sem testes comprovados resulta em blocked", async f => {
    const result = await processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId),
        isolatedTests: { executed: false, passed: false }
      })
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.localExecutionFailed, true);
    assert.equal(f.state.reports[0].status, "blocked");
    assert.equal(f.state.reports[0].testsPassed, false);
  });

  await fixtureTest("20 dispatcher: reserva revogada durante execução não relata", async f => {
    await assert.rejects(processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      execute: async ({ evolutionId }) => {
        f.state.revoked = true;
        return simulatedSuccess(evolutionId);
      }
    }), /Autorização de execução perdida/);
    assert.equal(f.state.reports.length, 0);
  });

  await fixtureTest("21 dispatcher: heartbeat usa renew do cliente original", async f => {
    const result = await processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      heartbeatMs: 1000,
      execute: async ({ evolutionId }) => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        return simulatedSuccess(evolutionId);
      }
    });
    assert.equal(result.status, "needs_review");
    assert.ok(f.state.renewCount >= 1);
  });

  await fixtureTest("22 dispatcher: não inicia execução se lease revogado entre claim e início", async f => {
    let executed = 0;
    const api = {
      claim: async () => {
        const task = await f.api.claim();
        f.state.revoked = true;
        return task;
      },
      renew: f.api.renew,
      report: f.api.report
    };
    await assert.rejects(processAuthorizedOnce({
      api, provider: fakeProvider,
      execute: async () => {
        executed++;
        throw new Error("Execução proibida");
      }
    }), /Autorização de execução perdida/);
    assert.equal(executed, 0);
    assert.equal(f.state.reports.length, 0);
  });

  await fixtureTest("23 dispatcher: lease expirado antes de executar é bloqueado", async f => {
    let executed = 0;
    const api = {
      claim: async () => {
        const task = await f.api.claim();
        f.state.now += 16 * 60 * 1000;
        return task;
      },
      renew: f.api.renew,
      report: f.api.report
    };
    await assert.rejects(processAuthorizedOnce({
      api, provider: fakeProvider,
      execute: async () => {
        executed++;
        throw new Error("Execução proibida");
      }
    }), /Autorização de execução perdida/);
    assert.equal(executed, 0);
    assert.equal(f.state.reports.length, 0);
  });

  await fixtureTest("24 dispatcher: revalida lease antes de relatar", async f => {
    const result = await processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      execute: async ({ evolutionId }) => simulatedSuccess(evolutionId)
    });
    assert.equal(result.status, "needs_review");
    assert.equal(f.state.renewCount, 2);
    assert.deepEqual(f.state.audit, ["claim", "renew", "renew", "report"]);
  });

  await fixtureTest("25 dispatcher: não relatar se lease expirou durante trabalho", async f => {
    await assert.rejects(processAuthorizedOnce({
      api: f.api,
      provider: fakeProvider,
      execute: async ({ evolutionId }) => {
        f.state.now += 16 * 60 * 1000;
        return simulatedSuccess(evolutionId);
      }
    }), /Autorização de execução perdida/);
    assert.equal(f.state.reports.length, 0);
  });

  await fixtureTest("26 dispatcher: rejeita heartbeat maior que limite seguro", async f => {
    await assert.rejects(processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      heartbeatMs: 15 * 60 * 1000
    }), /Intervalo de renovação inválido/);
    assert.equal(f.state.attempts, 0);
  });

  await fixtureTest("27 dispatcher: heartbeat mínimo válido não rejeitado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider, heartbeatMs: 1000,
      execute: async ({ evolutionId }) => simulatedSuccess(evolutionId)
    });
    assert.equal(result.reportAccepted, true);
  });

  await fixtureTest("28 resultado sem applied:true não é considerado válido", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => {
        const output = simulatedSuccess(evolutionId);
        delete output.applied;
        return output;
      }
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.localExecutionFailed, true);
    assert.equal(f.state.reports[0].testsPassed, false);
  });

  await fixtureTest("29 resultado com branch incorreta é bloqueado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId), branch: "main"
      })
    });
    assert.equal(result.status, "blocked");
  });

  await fixtureTest("30 resultado com alteração remota é bloqueado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId), remoteTouched: true
      })
    });
    assert.equal(result.status, "blocked");
  });

  await fixtureTest("31 resultado com instalação afirmada é bloqueado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId), installed: true
      })
    });
    assert.equal(result.status, "blocked");
  });

  await fixtureTest("32 resultado com flag de habilidade aprendida é bloqueado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId), capabilityLearned: true
      })
    });
    assert.equal(result.status, "blocked");
  });

  await fixtureTest("33 sanitização do resumo impede caracteres de controle", async () => {
    assert.equal(safeSummary("  segredo\n\rOK\t"), "segredo  OK");
    assert.equal(safeSummary("x".repeat(800)).length, 750);
    assert.equal(safeSummary(null).length > 0, true);
  });

  await fixtureTest("34 resultado apenas estrutural não comprova teste isolado", async f => {
    const result = await processAuthorizedOnce({
      api: f.api, provider: fakeProvider,
      execute: async ({ evolutionId }) => ({
        ...simulatedSuccess(evolutionId),
        isolatedTests: { executed: true, passed: false }
      })
    });
    assert.equal(result.status, "blocked");
    assert.equal(f.state.reports[0].testsPassed, false);
  });

  await fixtureTest("35 URL com credenciais embutidas é recusada", async () => {
    assert.throws(() => createPhase11Api({
      baseUrl: "https://user:password@example.com/",
      token: TOKEN
    }), /sem caminho ou credenciais/);
  });

  await fixtureTest("36 conexão HTTPS fora do loopback é obrigatória", async () => {
    assert.throws(() => createPhase11Api({
      baseUrl: "http://192.168.0.12/",
      token: TOKEN, allowLocalHttp: true
    }), /HTTPS/);
  });

  await fixtureTest("37 relatório exige todas as evidências explícitas", async () => {
    const candidate = simulatedSuccess(ID);
    assert.equal(reportOutcome(ID, candidate).status, "needs_review");
    assert.throws(() => reportOutcome(ID, { ...candidate, localCommitSha: "bad" }),
      /não comprova/);
    assert.throws(() => reportOutcome(ID, { ...candidate, applied: undefined }),
      /não comprova/);
  });
})().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
