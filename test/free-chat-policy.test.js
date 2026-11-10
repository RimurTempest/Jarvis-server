import test from "node:test";
import assert from "node:assert/strict";
import {
  freeChatPolicy, validateFreeChatMessage, reserveFreeChatDailyQuota,
  FREE_CHAT_DAILY_LIMIT, FREE_CHAT_MODEL,
} from "../jarvis-capabilities/free-chat-policy.mjs";

test("free chat is disabled by default even with a provider key", () => {
  assert.equal(freeChatPolicy({ GROQ_API_KEY: "a".repeat(40) }).enabled, false);
  assert.equal(freeChatPolicy({
    JARVIS_FREE_CHAT_ENABLED: "true", GROQ_API_KEY: "a".repeat(40),
  }).enabled, false);
  assert.equal(freeChatPolicy({
    JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN: "true", GROQ_API_KEY: "a".repeat(40),
  }).enabled, false);
});

test("free chat uses only explicit free attestation, fixed model, no tools", () => {
  const policy = freeChatPolicy({
    JARVIS_FREE_CHAT_ENABLED: "true",
    JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN: "true",
    GROQ_API_KEY: "a".repeat(40),
    JARVIS_ALLOW_PAID_OPENAI: "true", // no effect on this isolated path
  });
  assert.equal(policy.enabled, true);
  assert.equal(policy.model, FREE_CHAT_MODEL);
  assert.equal(policy.model, "openai/gpt-oss-20b");
  assert.equal(policy.noPaidFallback, true);
  assert.equal(policy.noTools, true);
  assert.equal(policy.noAutomaticActions, true);
  assert.equal(policy.noPersistence, true);
  assert.equal(policy.dailyLimit, 8);
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
