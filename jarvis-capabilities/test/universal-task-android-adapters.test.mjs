import test from "node:test";
import assert from "node:assert/strict";
import { createAndroidUniversalAdapterRegistry } from "../universal-task-android-adapters.mjs";

const pool = {
  async query(sql, params) {
    assert.match(sql, /jarvis_action_queue/);
    return {
      rowCount: 1,
      rows: [{ state: "completed", result: { ok: true, message: "Ação confirmada.", userConfirmed: true }, requires_user_confirmation: true }],
    };
  },
};

test("registers only existing allowlisted Android action adapters", () => {
  const registry = createAndroidUniversalAdapterRegistry({
    pool,
    publicBaseUrl: "https://jarvis.example",
    enqueueAction: async () => ({ id: "action-01" }),
    waitAction: async () => ({ state: "completed", result: { ok: true }, requiresUserConfirmation: false }),
  });
  assert.deepEqual([...registry.keys()], [
    "android.open_app", "android.open_url", "android.dial_number", "android.open_settings", "android.copy_text",
  ]);
  assert.ok([...registry.values()].every((adapter) => adapter.target === "android"));
});

test("queues a structured action for the explicitly selected paired device and verifies persisted result", async () => {
  const enqueued = [];
  const registry = createAndroidUniversalAdapterRegistry({
    pool,
    publicBaseUrl: "https://jarvis.example",
    enqueueAction: async (_pool, input) => { enqueued.push(input); return { id: input.id }; },
    waitAction: async () => ({
      state: "completed",
      result: { ok: true, message: "Ligação aberta no discador.", userConfirmed: true },
      requiresUserConfirmation: true,
    }),
  });
  const adapter = registry.get("android.dial_number");
  const context = { deviceId: "android-primary", androidActionIds: new Map() };
  const task = { id: "11111111-1111-4111-8111-111111111111", capability_id: "22222222-2222-4222-8222-222222222222" };
  const step = { kind: "android.dial_number", parameters: { phoneNumber: "+5511999999999" } };
  const result = await adapter.execute({ task, step, context });
  assert.equal(result.status, "succeeded");
  assert.equal(enqueued[0].targetDeviceId, "android-primary");
  assert.deepEqual(enqueued[0].action, { type: "dial_number", phoneNumber: "+5511999999999" });
  assert.equal(context.androidActionIds.get(step), enqueued[0].id);
  const verification = await adapter.verify({ task, step, context });
  assert.equal(verification.status, "succeeded");
  assert.equal(verification.evidence, "https://jarvis.example/api/tasks/11111111-1111-4111-8111-111111111111");
});

test("refuses unsafe or missing public evidence URLs", () => {
  assert.throws(() => createAndroidUniversalAdapterRegistry({ pool, publicBaseUrl: "http://jarvis.example" }), /HTTPS/);
  assert.throws(() => createAndroidUniversalAdapterRegistry({ pool }), /HTTPS/);
});

test("does not claim success when the device result is not completed", async () => {
  const registry = createAndroidUniversalAdapterRegistry({
    pool,
    publicBaseUrl: "https://jarvis.example",
    enqueueAction: async () => ({ id: "action-02" }),
    waitAction: async () => ({ state: "failed", result: { ok: false }, requiresUserConfirmation: false }),
  });
  const result = await registry.get("android.open_settings").execute({
    task: { id: "task-02", capability_id: "capability-02" },
    step: { kind: "android.open_settings", parameters: { setting: "bluetooth" } },
    context: { deviceId: "android-primary" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.evidence, undefined);
});
