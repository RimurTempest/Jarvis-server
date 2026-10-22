import test from "node:test";
import assert from "node:assert/strict";
import { createAndroidActionEnvelope } from "../android-action-protocol.mjs";
import { claimQueuedAction, acceptActionResult, canRedeliverAction } from "../action-delivery.mjs";

function makeEnvelope(overrides = {}) {
  return {
    ...createAndroidActionEnvelope({
      id: "action-01",
      capabilityId: "capability-01",
      action: { type: "copy_text", text: "hello" },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

test("claims a pending action with a device-bound, short-lived lease", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const claimed = claimQueuedAction(makeEnvelope({ expiresAt: "2026-01-01T12:05:00.000Z" }), {
    deviceId: "android-primary",
    leaseToken: "one-time-secret",
    now,
    leaseMs: 30_000,
  });
  assert.equal(claimed.state, "delivered");
  assert.equal(claimed.delivery.deviceId, "android-primary");
  assert.equal(claimed.delivery.leaseToken, "one-time-secret");
  assert.equal(claimed.delivery.leaseExpiresAt, "2026-01-01T12:00:30.000Z");
  assert.equal(claimed.deliveryAttempts, 1);
  assert.throws(() => claimQueuedAction(claimed, {
    deviceId: "android-primary", leaseToken: "another-token", now,
  }), /pendentes/);
});

test("expires actions before delivery and refuses invalid leases", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const expired = claimQueuedAction(makeEnvelope({ expiresAt: "2026-01-01T11:59:00.000Z" }), {
    deviceId: "android-primary", leaseToken: "token", now,
  });
  assert.equal(expired.state, "expired");
  assert.equal(canRedeliverAction(expired, now), false);
  assert.throws(() => claimQueuedAction(makeEnvelope(), {
    deviceId: "android-primary", leaseToken: "token", now, leaseMs: 120_000,
  }), /1000 e 60000/);
});

test("accepts a result only from the device and lease that received the action", () => {
  const now = new Date();
  const claimed = claimQueuedAction(makeEnvelope(), {
    deviceId: "android-primary", leaseToken: "one-time-secret", now,
  });
  assert.throws(() => acceptActionResult(claimed, {
    deviceId: "another-device", leaseToken: "one-time-secret", result: { ok: true },
  }), /não corresponde/);
  assert.throws(() => acceptActionResult(claimed, {
    deviceId: "android-primary", leaseToken: "wrong-secret", result: { ok: true },
  }), /não corresponde/);
  const completed = acceptActionResult(claimed, {
    deviceId: "android-primary", leaseToken: "one-time-secret",
    result: { ok: true, message: "copied", userConfirmed: true },
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.ok, true);
  assert.equal(completed.delivery, null);
  assert.throws(() => acceptActionResult(completed, {
    deviceId: "android-primary", leaseToken: "one-time-secret", result: { ok: true },
  }), /entrega ativa/);
});

test("keeps confirmation requirements for sensitive actions", () => {
  const envelope = createAndroidActionEnvelope({
    id: "action-02",
    capabilityId: "capability-01",
    action: { type: "dial_number", phoneNumber: "+55 11 1234-5678" },
  });
  const now = new Date();
  const claimed = claimQueuedAction(envelope, {
    deviceId: "android-primary", leaseToken: "call-lease", now,
  });
  assert.throws(() => acceptActionResult(claimed, {
    deviceId: "android-primary", leaseToken: "call-lease", result: { ok: true, message: "started" },
  }), /confirmação explícita/);
  const completed = acceptActionResult(claimed, {
    deviceId: "android-primary", leaseToken: "call-lease",
    result: { ok: true, message: "confirmed", userConfirmed: true },
  });
  assert.equal(completed.state, "completed");
});

test("allows redelivery only after the lease expires and before action expiry", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const claimed = claimQueuedAction(makeEnvelope({ expiresAt: "2026-01-01T12:05:00.000Z" }), {
    deviceId: "android-primary", leaseToken: "token", now, leaseMs: 1000,
  });
  assert.equal(canRedeliverAction(claimed, new Date("2026-01-01T12:00:00.500Z")), false);
  assert.equal(canRedeliverAction(claimed, new Date("2026-01-01T12:00:01.000Z")), true);
  assert.equal(canRedeliverAction(claimed, new Date("2026-01-01T12:06:00.000Z")), false);
});
