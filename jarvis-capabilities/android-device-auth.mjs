import { timingSafeEqual } from "node:crypto";

/**
 * Validates dedicated Android-device credentials without performing I/O.
 * Callers must fail closed when the device-specific secret or ID is not configured.
 */
export function validateAndroidDeviceCredentials({
  authorization,
  deviceIdHeader,
  expectedToken,
  expectedDeviceId,
} = {}) {
  if (
    typeof expectedToken !== "string" ||
    expectedToken.length < 32 ||
    typeof expectedDeviceId !== "string" ||
    expectedDeviceId.trim().length === 0
  ) {
    return { ok: false, reason: "device_auth_not_configured" };
  }

  if (
    typeof deviceIdHeader !== "string" ||
    deviceIdHeader.length === 0 ||
    deviceIdHeader !== expectedDeviceId
  ) {
    return { ok: false, reason: "device_id_mismatch" };
  }

  if (typeof authorization !== "string") {
    return { ok: false, reason: "missing_credentials" };
  }

  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return { ok: false, reason: "invalid_authorization_format" };

  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "invalid_device_token" };
  }

  return { ok: true, reason: null };
}
