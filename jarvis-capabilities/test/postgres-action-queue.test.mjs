import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  initializeActionQueue,
  enqueueAndroidAction,
  claimNextAndroidAction,
  completeAndroidAction,
} from "../postgres-action-queue.mjs";

function fakePool({ selectedRow = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id, capability_id, action, requires_user_confirmation, expires_at, delivery_attempts")) {
        return { rowCount: selectedRow ? 1 : 0, rows: selectedRow ? [{ ...selectedRow }] : [] };
      }
      if (normalized.startsWith("UPDATE jarvis_action_queue SET state = 'delivered'")) {
        return { rowCount: 1, rows: [{
          id: selectedRow.id,
          capability_id: selectedRow.capability_id,
          action: selectedRow.action,
          requires_user_confirmation: selectedRow.requires_user_confirmation,
          expires_at: selectedRow.expires_at,
          delivery_attempts: (selectedRow.delivery_attempts || 0) + 1,
        }] };
      }
      if (normalized.startsWith("SELECT id, capability_id, action, requires_user_confirmation, expires_at, state, device_id")) {
        const row = selectedRow ? {
          ...selectedRow,
          state: "delivered",
          device_id: "android-primary",
          lease_token_hash: createHash("sha256").update("known-token").digest(),
          lease_expires_at: new Date(Date.now() + 30_000),
        } : null;
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (normalized.startsWith("INSERT INTO jarvis_action_queue")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rowCount: 1, rows: [] };
    },
    async connect() { return client; },
  };
}

test("initializes the queue table and indexes", async () => {
  const pool = fakePool();
  await initializeActionQueue(pool);
  assert.ok(pool.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS jarvis_action_queue")));
  assert.ok(pool.calls.some((call) => call.sql.includes("UPDATE jarvis_action_queue") && call.sql.includes("target_device_id IS NULL") && call.sql.includes("state = 'expired'")));
  assert.ok(pool.calls.some((call) => call.sql.includes("target_device_id = 'legacy-unassigned'")));
  assert.ok(pool.calls.some((call) => call.sql.includes("ALTER TABLE jarvis_action_queue ALTER COLUMN target_device_id SET NOT NULL")));
  assert.ok(pool.calls.some((call) => call.sql.includes("ALTER TABLE jarvis_action_queue ALTER COLUMN requires_user_confirmation SET DEFAULT TRUE")));
  assert.ok(pool.calls.some((call) => call.sql.includes("UPDATE jarvis_action_queue SET requires_user_confirmation = TRUE")));
  assert.ok(pool.calls.some((call) => call.sql.includes("idx_jarvis_action_queue_pending")));
  assert.ok(pool.calls.some((call) => call.sql.includes("idx_jarvis_action_queue_lease")));
});

test("enqueues only structured allowlisted action data", async () => {
  const pool = fakePool();
  const result = await enqueueAndroidAction(pool, {
    id: "action-01",
    capabilityId: "capability-01",
    action: { type: "copy_text", text: "hello" },
    targetDeviceId: "android-primary",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(result.state, "pending");
  assert.equal(result.action.text, "hello");
  assert.equal(result.targetDeviceId, "android-primary");
  assert.equal(result.requiresUserConfirmation, true);
  assert.equal(pool.calls.length, 1);
  await assert.rejects(() => enqueueAndroidAction(pool, {
    id: "action-02",
    capabilityId: "capability-01",
    action: { type: "shell", command: "dangerous" },
    targetDeviceId: "android-primary",
  }), /não permitido/);
});

test("claims pending actions in a transaction and returns a lease token", async () => {
  const pool = fakePool({
    selectedRow: {
      id: "action-01",
      capability_id: "capability-01",
      action: { type: "copy_text", text: "hello" },
      requires_user_confirmation: true,
      expires_at: new Date(Date.now() + 120_000),
      delivery_attempts: 0,
    },
  });
  const claimed = await claimNextAndroidAction(pool, { deviceId: "android-primary" });
  assert.equal(claimed.state, "delivered");
  assert.equal(claimed.delivery.deviceId, "android-primary");
  assert.equal(typeof claimed.delivery.leaseToken, "string");
  assert.ok(pool.calls.some((call) => call.sql === "BEGIN"));
  assert.ok(pool.calls.some((call) => call.sql.includes("target_device_id = $2") && call.params[1] === "android-primary"));
  assert.ok(pool.calls.some((call) => call.sql.includes("LIMIT 1 FOR UPDATE SKIP LOCKED")));
  assert.ok(pool.calls.some((call) => call.sql === "COMMIT"));
});

test("accepts results only with the active device lease and preserves confirmation", async () => {
  const pool = fakePool({
    selectedRow: {
      id: "action-01",
      capability_id: "capability-01",
      action: { type: "copy_text", text: "hello" },
      requires_user_confirmation: true,
      expires_at: new Date(Date.now() + 120_000),
    },
  });
  await assert.rejects(() => completeAndroidAction(pool, {
    id: "action-01",
    deviceId: "android-primary",
    leaseToken: "known-token",
    result: { ok: true, message: "copied" },
  }), /confirmação explícita/);
  const completed = await completeAndroidAction(pool, {
    id: "action-01",
    deviceId: "android-primary",
    leaseToken: "known-token",
    result: { ok: true, message: "copied", userConfirmed: true },
  });
  assert.equal(completed.state, "completed");
  assert.ok(pool.calls.some((call) => call.sql.includes("lease_token_hash = NULL")));
  await assert.rejects(() => completeAndroidAction(pool, {
    id: "action-01",
    deviceId: "other-device",
    leaseToken: "known-token",
    result: { ok: true },
  }), /não corresponde/);
});
