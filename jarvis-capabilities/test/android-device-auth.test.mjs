import test from "node:test";
import assert from "node:assert/strict";
import { validateAndroidDeviceCredentials } from "../android-device-auth.mjs";

const expectedToken = "test-device-secret-that-is-at-least-32-characters";
const expectedDeviceId = "jarvis-android-primary";

function validate(overrides = {}) {
  return validateAndroidDeviceCredentials({
    authorization: `Bearer ${expectedToken}`,
    deviceIdHeader: expectedDeviceId,
    expectedToken,
    expectedDeviceId,
    ...overrides,
  });
}

test("accepts matching device ID and dedicated bearer token", () => {
  assert.deepEqual(validate(), { ok: true, reason: null });
});

test("fails closed when device credentials are not configured or token is too short", () => {
  assert.equal(validate({ expectedToken: undefined }).reason, "device_auth_not_configured");
  assert.equal(validate({ expectedToken: "short" }).reason, "device_auth_not_configured");
  assert.equal(validate({ expectedDeviceId: "" }).reason, "device_auth_not_configured");
});

test("rejects missing or malformed authorization", () => {
  assert.equal(validate({ authorization: undefined }).reason, "missing_credentials");
  assert.equal(validate({ authorization: "Basic abc" }).reason, "invalid_authorization_format");
  assert.equal(validate({ authorization: `Bearer ${expectedToken} extra` }).reason, "invalid_authorization_format");
});

test("rejects incorrect token without timingSafeEqual length errors", () => {
  assert.equal(validate({ authorization: "Bearer wrong" }).reason, "invalid_device_token");
  assert.equal(validate({ authorization: `Bearer ${expectedToken}x` }).reason, "invalid_device_token");
});

test("rejects a different, missing, or empty device ID", () => {
  assert.equal(validate({ deviceIdHeader: "another-device" }).reason, "device_id_mismatch");
  assert.equal(validate({ deviceIdHeader: undefined }).reason, "device_id_mismatch");
  assert.equal(validate({ deviceIdHeader: "" }).reason, "device_id_mismatch");
});

test("does not accept a correct token for the wrong configured device", () => {
  assert.equal(validate({ expectedDeviceId: "other-device" }).reason, "device_id_mismatch");
});
