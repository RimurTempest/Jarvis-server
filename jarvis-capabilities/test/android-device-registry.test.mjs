import test from "node:test";
import assert from "node:assert/strict";
import { authenticateAndroidDevice, createAndroidPairingCode, enrollAndroidDevice, initializeAndroidDeviceRegistry, revokeAndroidDevice } from "../android-device-registry.mjs";

test("initializes registry tables and indexes", async () => {
  const statements = [];
  await initializeAndroidDeviceRegistry({ query: async (sql) => { statements.push(sql); return { rowCount: 0, rows: [] }; } });
  assert.equal(statements.length, 3);
  assert.ok(statements[0].includes("jarvis_android_devices"));
  assert.ok(statements[1].includes("jarvis_android_pairing_codes"));
  assert.ok(statements[2].includes("idx_jarvis_android_pairing_expiry"));
});

test("pairing code is high entropy, expires, and only its hash is persisted", async () => {
  let saved;
  const pool = { query: async (_sql, params) => { saved = params; return { rowCount: 1, rows: [] }; } };
  const result = await createAndroidPairingCode(pool, { now: "2026-01-01T00:00:00.000Z", id: "1234567890abcdef" });
  assert.ok(result.code.length >= 30);
  assert.equal(result.expiresAt, "2026-01-01T00:05:00.000Z");
  assert.ok(Buffer.isBuffer(saved[1]));
  assert.notEqual(saved[1].toString("utf8"), result.code);
});

test("rejects unsafe pairing TTL and device identifiers", async () => {
  await assert.rejects(() => createAndroidPairingCode({ query: async () => ({}) }, { ttlMs: 1 }), /ttlMs/);
  const pool = { connect: async () => { throw new Error("should not connect"); } };
  await assert.rejects(() => enrollAndroidDevice(pool, { code: "a".repeat(30), deviceId: "../bad" }), /deviceId/);
});

test("authentication fails closed for missing, revoked, and mismatched credentials", async () => {
  const pool = { query: async (sql) => sql.startsWith("SELECT") ? { rowCount: 0, rows: [] } : { rowCount: 0, rows: [] } };
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: "android-one", token: "x".repeat(40) })).ok, false);
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: "../bad", token: "x".repeat(40) })).reason, "invalid_device_id");
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: "android-one", token: "short" })).reason, "invalid_token");
});

test("revocation is explicit and reports whether an active device was revoked", async () => {
  const pool = { query: async () => ({ rowCount: 1, rows: [{ device_id: "android-one" }] }) };
  assert.deepEqual(await revokeAndroidDevice(pool, { deviceId: "android-one" }), { revoked: true, deviceId: "android-one" });
});
