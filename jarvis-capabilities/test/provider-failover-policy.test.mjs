import test from "node:test";
import assert from "node:assert/strict";
import { providerCooldownMs, orderProvidersByCooldown, mergeHistoricalContext, runProvidersSequentially } from "../provider-failover-policy.mjs";

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

test("prefers providers outside cooldown while preserving their configured order", () => {
  const providers = [{ name: "A" }, { name: "B" }, { name: "C" }];
  const cooldowns = new Map([["A", 500], ["B", 0]]);
  assert.deepEqual(orderProvidersByCooldown(providers, cooldowns, 100), [
    { name: "B" },
    { name: "C" },
    { name: "A" },
  ]);
});

test("keeps cooling providers as a final fallback when healthy providers fail", () => {
  const providers = [{ name: "A" }, { name: "B" }, { name: "C" }];
  const cooldowns = new Map([["A", 500], ["B", 0], ["C", 600]]);
  assert.deepEqual(orderProvidersByCooldown(providers, cooldowns, 100), [
    { name: "B" },
    { name: "A" },
    { name: "C" },
  ]);
});

test("preserves configured order if every provider is cooling down", () => {
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

test("serializes provider attempts after an empty response", async () => {
  const events = [];
  let activeAttempts = 0;
  let maxActiveAttempts = 0;
  const providers = [{ name: "A" }, { name: "B" }, { name: "C" }];

  const result = await runProvidersSequentially(providers, async (provider) => {
    activeAttempts += 1;
    maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
    events.push(`start:${provider.name}`);
    try {
      // A finishes with an empty response; B cannot start until A has settled.
      await Promise.resolve();
      events.push(`end:${provider.name}`);
      return provider.name === "A" ? "   " : "valid response";
    } finally {
      activeAttempts -= 1;
    }
  });

  assert.deepEqual(events, ["start:A", "end:A", "start:B", "end:B"]);
  assert.equal(maxActiveAttempts, 1);
  assert.deepEqual(result, { provider: { name: "B" }, text: "valid response" });
});

test("stops sequential fallback immediately when the client disconnects", async () => {
  const attempted = [];
  const providers = [{ name: "A" }, { name: "B" }];
  let disconnected = false;
  const result = await runProvidersSequentially(
    providers,
    async (provider) => {
      attempted.push(provider.name);
      disconnected = true;
      throw new Error("client disconnected");
    },
    () => assert.fail("must not record provider failure after disconnect"),
    () => disconnected
  );

  assert.deepEqual(attempted, ["A"]);
  assert.equal(result, null);
});
