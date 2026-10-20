import test from "node:test";
import assert from "node:assert/strict";
import { providerCooldownMs, orderProvidersByCooldown, mergeHistoricalContext } from "../provider-failover-policy.mjs";

test("uses cooldowns appropriate to authentication, rate limits, and transient failures", () => {
  assert.equal(providerCooldownMs({ status: 401 }), 900000);
  assert.equal(providerCooldownMs({ status: 403 }), 900000);
  assert.equal(providerCooldownMs({ status: 429 }), 60000);
  assert.equal(providerCooldownMs({ status: 503 }), 20000);
  assert.equal(providerCooldownMs({ code: "ETIMEDOUT" }), 20000);
  assert.equal(providerCooldownMs({ code: "ECONNRESET" }), 20000);
  assert.equal(providerCooldownMs({ code: "UND_ERR_CONNECT_TIMEOUT" }), 20000);
});

test("does not cooldown ordinary client/model errors without a defined retry policy", () => {
  assert.equal(providerCooldownMs({ status: 400 }), 0);
  assert.equal(providerCooldownMs({ code: "EMPTY_RESPONSE" }), 0);
  assert.equal(providerCooldownMs(null), 0);
});

test("prefers providers outside cooldown while preserving configured order", () => {
  const providers = [{ name: "A" }, { name: "B" }, { name: "C" }];
  const cooldowns = new Map([["A", 500], ["B", 0]]);
  assert.deepEqual(orderProvidersByCooldown(providers, cooldowns, 100), [{ name: "B" }, { name: "C" }]);
});

test("retries the full provider list if every provider is cooling down", () => {
  const providers = [{ name: "A" }, { name: "B" }];
  const cooldowns = new Map([["A", 500], ["B", 600]]);
  assert.deepEqual(orderProvidersByCooldown(providers, cooldowns, 100), providers);
});

test("merges relevant older messages before recent history and removes exact duplicates", () => {
  const older = [
    { role: "user", content: "old relevant" },
    { role: "assistant", content: "already recent" },
  ];
  const recent = [
    { role: "assistant", content: "already recent" },
    { role: "user", content: "latest turn" },
  ];
  assert.deepEqual(mergeHistoricalContext(older, recent), [
    { role: "user", content: "old relevant" },
    { role: "assistant", content: "already recent" },
    { role: "user", content: "latest turn" },
  ]);
});
