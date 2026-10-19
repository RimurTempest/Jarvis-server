import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  initializeActionQueue,
  enqueueAndroidAction,
  claimNextAndroidAction,
  completeAndroidAction,
} from "../postgres-action-queue.mjs";
import {
  initializeAndroidDeviceRegistry,
  createAndroidPairingCode,
  enrollAndroidDevice,
  authenticateAndroidDevice,
  revokeAndroidDevice,
} from "../android-device-registry.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL integration: schema migration, one-time enrollment, device-bound delivery and confirmation", {
  skip: !databaseUrl,
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const freshSchema = "jarvis_it_" + randomBytes(6).toString("hex");
  const legacySchema = "jarvis_legacy_" + randomBytes(6).toString("hex");
  let freshPool;
  let legacyPool;

  try {
    await adminPool.query('CREATE SCHEMA "' + freshSchema + '"');
    await adminPool.query('CREATE SCHEMA "' + legacySchema + '"');
    freshPool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=" + freshSchema,
    });
    legacyPool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=" + legacySchema,
    });

    await initializeAndroidDeviceRegistry(freshPool);
    await initializeActionQueue(freshPool);

    const pairing = await createAndroidPairingCode(freshPool);
    const device = await enrollAndroidDevice(freshPool, {
      code: pairing.code,
      deviceId: "integration-android",
    });
    assert.equal((await authenticateAndroidDevice(freshPool, {
      deviceId: device.deviceId,
      token: device.token,
    })).ok, true);
    await assert.rejects(
      () => enrollAndroidDevice(freshPool, {
        code: pairing.code,
        deviceId: "integration-second-device",
      }),
      (error) => error?.code === "PAIRING_CODE_INVALID",
    );

    const queued = await enqueueAndroidAction(freshPool, {
      id: "integration-action-1",
      capabilityId: "android-basic-actions",
      action: { type: "open_settings", setting: "bluetooth" },
      targetDeviceId: device.deviceId,
      expiresAt: new Date(Date.now() + 120_000),
    });
    assert.equal(queued.state, "pending");
    assert.equal(queued.requiresUserConfirmation, true);

    const claimed = await claimNextAndroidAction(freshPool, {
      deviceId: device.deviceId,
    });
    assert.equal(claimed.id, queued.id);
    assert.equal(claimed.delivery.deviceId, device.deviceId);
    assert.ok(claimed.delivery.leaseToken.length >= 32);

    const completed = await completeAndroidAction(freshPool, {
      id: queued.id,
      deviceId: device.deviceId,
      leaseToken: claimed.delivery.leaseToken,
      result: { ok: true, message: "opened after confirmation", userConfirmed: true },
    });
    assert.equal(completed.state, "completed");
    assert.equal(completed.result.userConfirmed, true);

    const wrongDeviceAction = await enqueueAndroidAction(freshPool, {
      id: "integration-action-2",
      capabilityId: "android-basic-actions",
      action: { type: "copy_text", text: "integration test" },
      targetDeviceId: "another-android",
      expiresAt: new Date(Date.now() + 120_000),
    });
    assert.equal(await claimNextAndroidAction(freshPool, {
      deviceId: device.deviceId,
    }), null);
    assert.equal(wrongDeviceAction.targetDeviceId, "another-android");

    assert.equal((await revokeAndroidDevice(freshPool, {
      deviceId: device.deviceId,
    })).revoked, true);
    assert.equal((await authenticateAndroidDevice(freshPool, {
      deviceId: device.deviceId,
      token: device.token,
    })).ok, false);

    await legacyPool.query(\`CREATE TABLE jarvis_action_queue (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'completed', 'failed', 'expired')),
      action JSONB NOT NULL,
      requires_user_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      delivered_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ,
      device_id TEXT,
      lease_token_hash BYTEA,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      result JSONB
    )\`);
    await legacyPool.query(
      "INSERT INTO jarvis_action_queue (id, capability_id, state, action, expires_at) VALUES ($1, $2, 'pending', $3::jsonb, $4)",
      ["legacy-pending", "android-basic-actions", JSON.stringify({ type: "copy_text", text: "old" }), new Date(Date.now() + 120_000)],
    );
    await initializeActionQueue(legacyPool);
    const migrated = await legacyPool.query(
      "SELECT state, target_device_id, requires_user_confirmation FROM jarvis_action_queue WHERE id = $1",
      ["legacy-pending"],
    );
    assert.equal(migrated.rows[0].state, "expired");
    assert.equal(migrated.rows[0].target_device_id, "legacy-unassigned");
    assert.equal(migrated.rows[0].requires_user_confirmation, false);
    const column = await legacyPool.query(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'jarvis_action_queue' AND column_name = 'target_device_id'",
      [legacySchema],
    );
    assert.equal(column.rows[0].is_nullable, "NO");
    const confirmationColumn = await legacyPool.query(
      "SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'jarvis_action_queue' AND column_name = 'requires_user_confirmation'",
      [legacySchema],
    );
    assert.match(confirmationColumn.rows[0].column_default, /true/i);
  } finally {
    await freshPool?.end();
    await legacyPool?.end();
    await adminPool.query('DROP SCHEMA IF EXISTS "' + freshSchema + '" CASCADE');
    await adminPool.query('DROP SCHEMA IF EXISTS "' + legacySchema + '" CASCADE');
    await adminPool.end();
  }
});
