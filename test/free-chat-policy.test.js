import test from "node:test";
import assert from "node:assert/strict";
import {
  freeChatPolicy, approvedFreeChatProviders, chooseFreeChatProvider,
  validateFreeChatMessage, reserveFreeChatDailyQuota, FREE_CHAT_DAILY_LIMIT,
} from "../jarvis-capabilities/free-chat-policy.mjs";

const candidate = (name, model, host) => ({
  name, model,
  client: {
    baseURL: "https://" + host + "/v1",
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "ok" } }] }) } },
  },
});
const allSeven = [
  candidate("HuggingFace", "example/model", "router.huggingface.co"),
  candidate("NVIDIA", "model-v1", "integrate.api.nvidia.com"),
  candidate("ZAI", "glm-test", "api.z.ai"),
  candidate("OpenRouter", "example/model:free", "openrouter.ai"),
  candidate("Cloudflare", "cf/test", "api.cloudflare.com"),
  candidate("Groq", "openai/gpt-oss-20b", "api.groq.com"),
  candidate("Gemini", "gemini-test", "generativelanguage.googleapis.com"),
];
const approvals = JSON.stringify(allSeven.map((x) => ({ provider: x.name, model: x.model })));
const allowedEnv = {
  JARVIS_FREE_CHAT_ENABLED: "true",
  JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN: "true",
  JARVIS_FREE_CHAT_APPROVED_MODELS_JSON: approvals,
};

test("disabled by default with all seven provider clients already configured", () => {
  assert.equal(freeChatPolicy({}, allSeven).enabled, false);
  assert.equal(freeChatPolicy({ JARVIS_FREE_CHAT_ENABLED: "true" }, allSeven).enabled, false);
  assert.equal(freeChatPolicy({
    ...allowedEnv, JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN: "false",
  }, allSeven).enabled, false);
  assert.equal(freeChatPolicy({
    ...allowedEnv, JARVIS_FREE_CHAT_APPROVED_MODELS_JSON: undefined,
  }, allSeven).enabled, false);
});

test("seven different existing provider model pairs work without new API keys", () => {
  const policy = freeChatPolicy(allowedEnv, allSeven);
  assert.equal(policy.enabled, true);
  assert.equal(policy.freeOnly, true);
  assert.equal(policy.requiresExplicitModelApproval, true);
  assert.equal(policy.providerCount, 7);
  assert.equal(policy.providers[0].name, "HuggingFace");
  assert.equal(policy.providers[6].name, "Gemini");
  assert.equal(policy.noPaidFallback, true);
  assert.equal(policy.noTools, true);
  assert.equal(policy.noAutomaticActions, true);
  assert.equal(policy.noPersistence, true);
  assert.equal(policy.dailyLimit, 8);
  assert.equal(chooseFreeChatProvider(allowedEnv, allSeven, 1).name, "HuggingFace");
  assert.equal(chooseFreeChatProvider(allowedEnv, allSeven, 6).name, "Groq");
  assert.equal(chooseFreeChatProvider(allowedEnv, allSeven, 8).name, "HuggingFace");
});

test("only provider+model approvals match, not provider names alone", () => {
  const bad = { ...allowedEnv, JARVIS_FREE_CHAT_APPROVED_MODELS_JSON: JSON.stringify([
    { provider: "Groq", model: "some-other-model" },
  ]) };
  assert.equal(freeChatPolicy(bad, allSeven).enabled, false);
  assert.equal(approvedFreeChatProviders(bad, allSeven).length, 0);
  assert.equal(chooseFreeChatProvider(bad, allSeven, 1), null);
});

test("dangerous or misconfigured endpoints and OpenRouter paid models fail closed", () => {
  const paidOpenAI = candidate("OpenAI", "gpt-4.1", "api.openai.com");
  const spoofedGroq = candidate("Groq", "openai/gpt-oss-20b", "api.openai.com");
  const paidOpenRouter = candidate("OpenRouter", "anthropic/claude-sonnet", "openrouter.ai");
  for (const [configured, approved] of [
    [[paidOpenAI], [{ provider: "OpenAI", model: "gpt-4.1" }]],
    [[spoofedGroq], [{ provider: "Groq", model: "openai/gpt-oss-20b" }]],
    [[paidOpenRouter], [{ provider: "OpenRouter", model: "anthropic/claude-sonnet" }]],
  ]) {
    const env = {
      ...allowedEnv,
      JARVIS_FREE_CHAT_APPROVED_MODELS_JSON: JSON.stringify(approved),
    };
    assert.equal(freeChatPolicy(env, configured).enabled, false);
  }
});

test("malformed approval list disables the entire feature, not just one entry", () => {
  const examples = [
    "not-json",
    "[]",
    JSON.stringify([{}, { provider: "Groq", model: "openai/gpt-oss-20b" }]),
    JSON.stringify([{ provider: "Groq", model: "openai/gpt-oss-20b" }, { provider: "OpenAI", model: "gpt-4.1" }]),
  ];
  for (const list of examples) {
    assert.equal(freeChatPolicy({
      ...allowedEnv, JARVIS_FREE_CHAT_APPROVED_MODELS_JSON: list,
    }, allSeven).enabled, false);
  }
});

test("fail closed on arbitrary or oversized messages", () => {
  for (const input of [null, "", " ".repeat(5), 100, "x".repeat(701), "x\u0000y"]) {
    assert.throws(() => validateFreeChatMessage(input), TypeError);
  }
  assert.equal(validateFreeChatMessage("  Olá, JARVIS!  "), "Olá, JARVIS!");
});

test("Postgres quota uses atomic upsert and rejects all after the limit", async () => {
  let usage = 0;
  let ddlCalls = 0;
  const pool = {
    query: async (sql, values) => {
      if (sql.startsWith("CREATE TABLE")) {
        ddlCalls++;
        return { rowCount: 0, rows: [] };
      }
      assert.match(sql, /ON CONFLICT \(device_id, day_utc\)/);
      assert.match(sql, /request_count < \$2/);
      assert.equal(values[0], "phone-id");
      assert.equal(values[1], FREE_CHAT_DAILY_LIMIT);
      if (usage >= FREE_CHAT_DAILY_LIMIT) return { rowCount: 0, rows: [] };
      usage++;
      return { rowCount: 1, rows: [{ request_count: usage }] };
    },
  };
  for (let i = 1; i <= FREE_CHAT_DAILY_LIMIT; i++) {
    const result = await reserveFreeChatDailyQuota(pool, "phone-id");
    assert.equal(result.accepted, true);
    assert.equal(result.used, i);
  }
  assert.equal((await reserveFreeChatDailyQuota(pool, "phone-id")).accepted, false);
  assert.ok(ddlCalls === 1);
});

test("quota requires validated device and a database", async () => {
  await assert.rejects(reserveFreeChatDailyQuota(null, "phone-id"), TypeError);
  await assert.rejects(reserveFreeChatDailyQuota({ query() {} }, "../bad-id"), TypeError);
});
