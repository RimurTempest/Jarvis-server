import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authenticateAndroidDevice, createAndroidPairingCode, enrollAndroidDevice, initializeAndroidDeviceRegistry, revokeAndroidDevice } from "../android-device-registry.mjs";

const digest = (value) => createHash("sha256").update(value).digest();

test("creates the device and one-time pairing tables", async () => {
  const sql = [];
  await initializeAndroidDeviceRegistry({ query: async (statement) => { sql.push(statement); return { rowCount: 0, rows: [] }; } });
  assert.equal(sql.length, 3);
  assert.ok(sql[0].includes("jarvis_android_devices"));
  assert.ok(sql[1].includes("jarvis_android_pairing_codes"));
});

test("pairing codes are short-lived and only their hash is stored", async () => {
  let inserted;
  const pool = { query: async (_sql, params) => { inserted = params; return { rowCount: 1, rows: [] }; } };
  const result = await createAndroidPairingCode(pool, { now: "2026-01-01T00:00:00.000Z" });
  assert.ok(result.code.length >= 30);
  assert.equal(result.expiresAt, "2026-01-01T00:05:00.000Z");
  assert.ok(Buffer.isBuffer(inserted[1]));
  assert.equal(inserted[1].equals(Buffer.from(result.code)), false);
  await assert.rejects(() => createAndroidPairingCode(pool, { ttlMs: 1 }), /ttlMs/);
});

test("enrollment consumes one code and returns a device-specific token", async () => {
  let codeHash;
  let consumed = false;
  let device;
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("INSERT INTO jarvis_android_pairing_codes")) codeHash = params[1];
      if (sql.startsWith("SELECT token_hash")) return device && !device.revoked ? { rowCount: 1, rows: [{ token_hash: device.token_hash }] } : { rowCount: 0, rows: [] };
      if (sql.startsWith("UPDATE jarvis_android_devices SET last_seen_at")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("UPDATE jarvis_android_devices SET revoked_at")) {
        const active = !!device && !device.revoked;
        if (device) device.revoked = true;
        return { rowCount: active ? 1 : 0, rows: active ? [{ device_id: params[1] }] : [] };
      }
      return { rowCount: 1, rows: [] };
    },
    async connect() {
      return {
        async query(sql, params) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
          if (sql.startsWith("UPDATE jarvis_android_pairing_codes")) {
            const valid = !consumed && codeHash && codeHash.equals(params[1]) && new Date("2026-01-01T00:05:00.000Z") > new Date(params[0]);
            if (valid) consumed = true;
            return { rowCount: valid ? 1 : 0, rows: valid ? [{ id: "pairing-id" }] : [] };
          }
          if (sql.startsWith("INSERT INTO jarvis_android_devices")) {
            device = { device_id: params[0], token_hash: params[1], revoked: false };
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {},
      };
    },
  };
  const pairing = await createAndroidPairingCode(pool, { now: "2026-01-01T00:00:00.000Z" });
  const enrolled = await enrollAndroidDevice(pool, { code: pairing.code, deviceId: "android-primary", now: "2026-01-01T00:01:00.000Z" });
  assert.equal(enrolled.deviceId, "android-primary");
  assert.ok(enrolled.token.length >= 40);
  assert.equal(device.token_hash.equals(digest(enrolled.token)), true);
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: enrolled.deviceId, token: enrolled.token, now: "2026-01-01T00:02:00.000Z" })).ok, true);
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: enrolled.deviceId, token: "wrong-token-with-enough-length-000" })).ok, false);
  assert.equal((await revokeAndroidDevice(pool, { deviceId: enrolled.deviceId, now: "2026-01-01T00:03:00.000Z" })).revoked, true);
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: enrolled.deviceId, token: enrolled.token })).ok, false);
});

test("rejects invalid device identifiers and malformed credentials", async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal((await authenticateAndroidDevice(pool, { deviceId: "../bad", token: "x".repeat(40) })).ok, false);
  await assert.rejects(() => revokeAndroidDevice(pool, { deviceId: "../bad" }), /deviceId/);
});
