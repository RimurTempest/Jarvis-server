import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAndroidAction,
  createAndroidActionEnvelope,
  normalizeAndroidActionResult,
} from "../android-action-protocol.mjs";

test("accepts only structured allowlisted actions", () => {
  assert.deepEqual(validateAndroidAction({ type: "open_app", packageName: "com.example.app" }), {
    type: "open_app", packageName: "com.example.app",
  });
  assert.equal(validateAndroidAction({ type: "open_url", url: "https://example.com/path" }).type, "open_url");
  assert.equal(validateAndroidAction({ type: "open_settings", setting: "wifi" }).setting, "wifi");
  assert.equal(validateAndroidAction({ type: "copy_text", text: "hello" }).text, "hello");
});

test("rejects arbitrary code, shell commands, and unsafe URL schemes", () => {
  assert.throws(() => validateAndroidAction({ type: "shell", command: "rm -rf /" }), /não permitido/);
  assert.throws(() => validateAndroidAction({ type: "open_url", url: "javascript:alert(1)" }), /HTTP\(S\)/);
  assert.throws(() => validateAndroidAction({ type: "open_url", url: "https://user:pass@example.com" }), /HTTP\(S\)/);
  assert.throws(() => validateAndroidAction({ type: "open_settings", setting: "factory_reset" }), /não permitida/);
});

test("requires explicit device confirmation for every queued action", () => {
  const envelope = createAndroidActionEnvelope({
    id: "action-01",
    capabilityId: "capability-01",
    action: { type: "dial_number", phoneNumber: "+55 11 1234-5678" },
  });
  assert.equal(envelope.state, "pending");
  assert.equal(envelope.requiresUserConfirmation, true);
  const copyEnvelope = createAndroidActionEnvelope({ id: "action-copy-confirm", capabilityId: "capability-01", action: { type: "copy_text", text: "hello" } });
  assert.equal(copyEnvelope.requiresUserConfirmation, true);
  assert.throws(() => normalizeAndroidActionResult(copyEnvelope, { ok: true, message: "copied" }), /confirmação explícita/);
  assert.throws(() => normalizeAndroidActionResult(envelope, { ok: true, message: "started" }), /confirmação explícita/);
  const completed = normalizeAndroidActionResult(envelope, {
    ok: true, message: "dialer opened", userConfirmed: true,
  });
  assert.equal(completed.state, "completed");
});

test("rejects invalid action envelopes and malformed results", () => {
  assert.throws(() => createAndroidActionEnvelope({
    id: "../unsafe", capabilityId: "capability-01", action: { type: "copy_text", text: "hi" },
  }), /caracteres inválidos/);
  const envelope = createAndroidActionEnvelope({
    id: "action-02", capabilityId: "capability-01", action: { type: "copy_text", text: "hi" },
  });
  assert.throws(() => normalizeAndroidActionResult(envelope, { message: "missing boolean" }), /booleano/);
});

test("rejects expired and excessively long-lived action requests", () => {
  assert.throws(() => createAndroidActionEnvelope({
    id: "action-03", capabilityId: "capability-01", action: { type: "copy_text", text: "hi" },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }), /próximos 10 minutos/);
  const expired = {
    id: "action-04", capabilityId: "capability-01", state: "pending",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  assert.equal(normalizeAndroidActionResult(expired, { ok: true }).state, "expired");
});
