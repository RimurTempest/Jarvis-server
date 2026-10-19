import test from "node:test";
import assert from "node:assert/strict";
import { isDirectAndroidActionRequest, proposeAndroidAction } from "./android-action-proposal.mjs";

test("recognizes direct action requests in Portuguese", () => {
  assert.equal(isDirectAndroidActionRequest("Jarvis, abra as configurações de Bluetooth"), true);
  assert.equal(isDirectAndroidActionRequest("Por favor, ligue para +55 11 99999-0000"), true);
  assert.equal(isDirectAndroidActionRequest("Quero que você copie o texto: teste"), true);
});

test("does not classify explanations or learning requests as execution", () => {
  assert.equal(isDirectAndroidActionRequest("Como faço para abrir o Bluetooth?"), false);
  assert.equal(isDirectAndroidActionRequest("Aprenda a abrir aplicativos"), false);
  assert.equal(isDirectAndroidActionRequest("O que significa abrir uma URL?"), false);
  assert.equal(isDirectAndroidActionRequest("Quero que você não abra o Bluetooth"), false);
  assert.equal(isDirectAndroidActionRequest("Não quero que você abra o Bluetooth"), false);
  assert.equal(isDirectAndroidActionRequest("Não autorizo que você ligue para +55 11 99999-0000"), false);
  assert.equal(isDirectAndroidActionRequest("Nunca quero que você copie esse texto"), false);
});

test("does not call the model when the front gate rejects the message", async () => {
  let called = false;
  const provider = { model: "test", client: { chat: { completions: { create: async () => { called = true; return {}; } } } } };
  assert.equal(await proposeAndroidAction(provider, "Como faço para abrir o Bluetooth?"), null);
  assert.equal(called, false);
});

test("enforces the parser timeout through SDK request options, not the JSON body", async () => {
  let requestBody;
  let requestOptions;
  const provider = {
    model: "test",
    client: {
      chat: {
        completions: {
          create: async (body, options) => {
            requestBody = body;
            requestOptions = options;
            return { choices: [{ message: {} }] };
          },
        },
      },
    },
  };

  assert.equal(await proposeAndroidAction(provider, "Jarvis, abra as configurações de Bluetooth"), null);
  assert.equal(requestBody.timeout, undefined);
  assert.equal(requestOptions.timeout, 8000);
  assert.equal(requestOptions.maxRetries, 0);
});

test("validates model-proposed actions before returning them", async () => {
  const provider = {
    model: "test",
    client: { chat: { completions: { create: async () => ({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: "propose_android_action", arguments: JSON.stringify({
          action: { type: "open_settings", packageName: null, url: null, phoneNumber: null, setting: "bluetooth", text: null }
        }) }
      }] } }]
    }) } } }
  };
  assert.deepEqual(await proposeAndroidAction(provider, "Jarvis, abra as configurações de Bluetooth"), { type: "open_settings", setting: "bluetooth" });
});

test("rejects unsupported or malformed model proposals", async () => {
  const provider = {
    model: "test",
    client: { chat: { completions: { create: async () => ({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: "propose_android_action", arguments: JSON.stringify({
          action: { type: "run_shell", packageName: null, url: null, phoneNumber: null, setting: null, text: null }
        }) }
      }] } }]
    }) } } }
  };
  assert.equal(await proposeAndroidAction(provider, "Jarvis, abra o aplicativo"), null);
});

test("rejects package names and URLs invented by the model", async () => {
  const providerFor = (action) => ({
    model: "test",
    client: { chat: { completions: { create: async () => ({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "propose_android_action",
          arguments: JSON.stringify({ action: {
            type: action.type,
            packageName: action.packageName ?? null,
            url: action.url ?? null,
            phoneNumber: action.phoneNumber ?? null,
            setting: action.setting ?? null,
            text: action.text ?? null,
          } })
        }
      }] } }]
    }) } } }
  });

  assert.equal(await proposeAndroidAction(providerFor({
    type: "open_app", packageName: "com.whatsapp",
  }), "Jarvis, abra o WhatsApp"), null);

  assert.equal(await proposeAndroidAction(providerFor({
    type: "open_url", url: "https://google.com/",
  }), "Jarvis, abra o Google"), null);

  assert.equal(await proposeAndroidAction(providerFor({
    type: "dial_number", phoneNumber: "+5511999990000",
  }), "Jarvis, ligue para a loja"), null);

  assert.equal(await proposeAndroidAction(providerFor({
    type: "dial_number", phoneNumber: "11999990000",
  }), "Jarvis, ligue para +55 11 99999-0000"), null);
  assert.deepEqual(await proposeAndroidAction(providerFor({
    type: "dial_number", phoneNumber: "+55 11 99999-0000",
  }), "Jarvis, ligue para +55 11 99999-0000"), {
    type: "dial_number",
    phoneNumber: "+55 11 99999-0000",
    requiresUserConfirmation: true,
  });
});
