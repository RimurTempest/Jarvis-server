import test from "node:test";
import assert from "node:assert/strict";
import { resolveAndroidActionIntent } from "../android-action-intent.mjs";

test("maps ordinary Portuguese app requests to allowlisted packages", () => {
  assert.deepEqual(resolveAndroidActionIntent("Abra o WhatsApp"), {
    action: { type: "open_app", packageName: "com.whatsapp" },
    goal: "Abrir o aplicativo whatsapp no Android",
    requiresUserConfirmation: false,
  });
  assert.equal(resolveAndroidActionIntent("abre o YouTube").action.packageName, "com.google.android.youtube");
});

test("maps phone settings to the strict Android settings allowlist", () => {
  assert.equal(resolveAndroidActionIntent("abra o wi-fi").action.setting, "wifi");
  assert.equal(resolveAndroidActionIntent("abrir configurações de bluetooth").action.setting, "bluetooth");
  assert.equal(resolveAndroidActionIntent("abra as configurações de brilho").action.setting, "display");
});

test("phone calls always require explicit on-device confirmation", () => {
  const intent = resolveAndroidActionIntent("ligue para +55 81 99999-1234");
  assert.equal(intent.action.type, "dial_number");
  assert.equal(intent.requiresUserConfirmation, true);
  assert.equal(resolveAndroidActionIntent("ligue para mamãe"), null);
});

test("accepts only HTTP(S) URLs without credentials and copies bounded text", () => {
  assert.equal(resolveAndroidActionIntent("abra https://example.com").action.url, "https://example.com/");
  assert.equal(resolveAndroidActionIntent("abra javascript:alert(1)"), null);
  assert.equal(resolveAndroidActionIntent("copie este texto: olá mundo").action.text, "olá mundo");
});

test("does not reinterpret discussion as an immediate phone command", () => {
  assert.equal(resolveAndroidActionIntent("Quero que você aprenda a abrir o WhatsApp"), null);
  assert.equal(resolveAndroidActionIntent("Como posso abrir o WhatsApp?"), null);
  assert.equal(resolveAndroidActionIntent("abra o aplicativo que eu inventei"), null);
});
