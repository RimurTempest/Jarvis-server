import test from "node:test";
import assert from "node:assert/strict";
import { registerAndroidPairingPage } from "../android-pairing-page.mjs";

test("mobile pairing page is served with no-store and restrictive security headers", async () => {
  let registeredPath;
  let handler;
  const app = {
    get(path, callback) {
      registeredPath = path;
      handler = callback;
    },
  };

  registerAndroidPairingPage(app);
  assert.equal(registeredPath, "/android-pairing");
  assert.equal(typeof handler, "function");

  const headers = {};
  let statusCode = 0;
  let body = "";
  const response = {
    status(code) { statusCode = code; return this; },
    set(name, value) { headers[name.toLowerCase()] = value; return this; },
    send(value) { body = value; return this; },
  };

  handler({}, response);

  assert.equal(statusCode, 200);
  assert.equal(headers["cache-control"], "no-store, max-age=0");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.match(headers["content-security-policy"], /connect-src 'self'/);
  assert.match(body, /\/api\/android\/enrollment\/pairing-code/);
  assert.match(body, /type="password"/);
  assert.match(body, /credentials: "same-origin"/);
  assert.match(body, /tokenInput\.value = ""/);
  assert.doesNotMatch(body, /localStorage|sessionStorage|https?:\/\//i);
  assert.doesNotMatch(body, /<script[^>]+src=/i);
});

test("mobile pairing page rejects an invalid Express app", () => {
  assert.throws(() => registerAndroidPairingPage(null), /app Express inválido/);
});
