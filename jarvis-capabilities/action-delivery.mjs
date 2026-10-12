import { timingSafeEqual } from "node:crypto";
import { normalizeAndroidActionResult } from "./android-action-protocol.mjs";

const MAX_DEVICE_ID = 120;
const MAX_LEASE_MS = 60_000;

function requiredString(value, field, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(`${field} deve ser um texto não vazio de até ${maxLength} caracteres.`);
  }
  return value.trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pure delivery policy for a server-owned action queue.
 * Persistence, authentication, and Android execution belong to separate layers.
 */
export function claimQueuedAction(envelope, { deviceId, leaseToken, now = new Date(), leaseMs = 30_000 }) {
  const cleanDeviceId = requiredString(deviceId, "deviceId", MAX_DEVICE_ID);
  const cleanLeaseToken = requiredString(leaseToken, "leaseToken", 256);
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new TypeError("now inválido.");
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) {
    throw new RangeError("leaseMs deve estar entre 1000 e 60000 ms.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("A ação deve ser um objeto.");
  }
  if (envelope.state !== "pending") throw new Error("Somente ações pendentes podem ser entregues.");
  const expiresAt = new Date(envelope.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
    return {
      ...envelope,
      state: "expired",
      completedAt: new Date(currentTime).toISOString(),
      result: { ok: false, message: "A ação expirou antes da entrega." },
      delivery: null,
    };
  }
  return {
    ...envelope,
    state: "delivered",
    delivery: {
      deviceId: cleanDeviceId,
      leaseToken: cleanLeaseToken,
      deliveredAt: new Date(currentTime).toISOString(),
      leaseExpiresAt: new Date(Math.min(currentTime + leaseMs, expiresAt)).toISOString(),
    },
    deliveryAttempts: Math.max(0, Number.isInteger(envelope.deliveryAttempts) ? envelope.deliveryAttempts : 0) + 1,
  };
}

export function acceptActionResult(envelope, { deviceId, leaseToken, result, now = new Date() }) {
  const cleanDeviceId = requiredString(deviceId, "deviceId", MAX_DEVICE_ID);
  const cleanLeaseToken = requiredString(leaseToken, "leaseToken", 256);
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new TypeError("now inválido.");
  if (!envelope || typeof envelope !== "object" || envelope.state !== "delivered" || !envelope.delivery) {
    throw new Error("A ação não está em entrega ativa.");
  }
  if (envelope.delivery.deviceId !== cleanDeviceId || !safeEqual(envelope.delivery.leaseToken, cleanLeaseToken)) {
    throw new Error("O dispositivo ou token de entrega não corresponde à sessão ativa.");
  }
  const leaseExpiresAt = new Date(envelope.delivery.leaseExpiresAt).getTime();
  const actionExpiresAt = new Date(envelope.expiresAt).getTime();
  if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(actionExpiresAt) ||
      leaseExpiresAt <= currentTime || actionExpiresAt <= currentTime) {
    return {
      ...envelope,
      state: "expired",
      completedAt: new Date(currentTime).toISOString(),
      result: { ok: false, message: "A entrega ou a ação expirou antes da confirmação." },
      delivery: null,
    };
  }
  const normalized = normalizeAndroidActionResult({ ...envelope, state: "pending" }, result);
  return { ...normalized, delivery: null };
}

/** A lease may be retried only after it expires; never silently reassign an active delivery. */
export function canRedeliverAction(envelope, now = new Date()) {
  if (!envelope || typeof envelope !== "object") return false;
  if (envelope.state === "pending") return new Date(envelope.expiresAt).getTime() > new Date(now).getTime();
  if (envelope.state !== "delivered" || !envelope.delivery) return false;
  const currentTime = new Date(now).getTime();
  return new Date(envelope.delivery.leaseExpiresAt).getTime() <= currentTime &&
    new Date(envelope.expiresAt).getTime() > currentTime;
}
