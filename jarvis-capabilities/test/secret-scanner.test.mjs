import test from "node:test";
import assert from "node:assert/strict";
import { containsLikelySecret } from "../secret-scanner.mjs";

test("detects common credential assignments and known token formats", () => {
  assert.equal(containsLikelySecret('const mailPassword = "a-real-mail-password-123";'), true);
  assert.equal(containsLikelySecret('val apiKey = "live-api-key-very-long-123";'), true);
  assert.equal(containsLikelySecret('const accessToken = "this-is-a-real-access-token-123";'), true);
  assert.equal(containsLikelySecret('const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";'), true);
  assert.equal(containsLikelySecret("-----BEGIN PRIVATE KEY-----"), true);
});

test("does not flag environment lookups, documented placeholders, or ordinary source", () => {
  assert.equal(containsLikelySecret("const apiKey = process.env.API_KEY;"), false);
  assert.equal(containsLikelySecret('val token = "TEST-fake-token-for-unit-test";'), false);
  assert.equal(containsLikelySecret('const password = "REPLACE_ME";'), false);
  assert.equal(containsLikelySecret("export const safe = true;"), false);
  assert.equal(containsLikelySecret(null), false);
});

test("resets global regex state between calls", () => {
  const value = 'const password = "another-real-secret-value-123";';
  assert.equal(containsLikelySecret(value), true);
  assert.equal(containsLikelySecret("const password = process.env.PASSWORD;"), false);
  assert.equal(containsLikelySecret(value), true);
});
