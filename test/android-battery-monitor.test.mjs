import test from "node:test";
import assert from "node:assert";
import { validateBatteryNotificationAction, createBatteryMonitorEnvelope } from "../jarvis-capabilities/android-battery-monitor.mjs";

test("valida e cria envelope de monitoramento de bateria com sucesso", () => {
  const action = {
    type: "battery_notification",
    levelThreshold: 20,
    chargingState: false,
    title: "Bateria Fraca",
    message: "O nível da bateria está em 20%.",
  };
  const validated = validateBatteryNotificationAction(action);
  assert.strictEqual(validated.levelThreshold, 20);
  assert.strictEqual(validated.chargingState, false);

  const envelope = createBatteryMonitorEnvelope({
    id: "bat-test-1",
    capabilityId: "cap-battery",
    action,
  });
  assert.strictEqual(envelope.state, "pending");
  assert.strictEqual(envelope.action.levelThreshold, 20);
});

test("rejeita limites de bateria inválidos", () => {
  assert.throws(() => {
    validateBatteryNotificationAction({
      type: "battery_notification",
      levelThreshold: 150,
    });
  }, RangeError);
});
