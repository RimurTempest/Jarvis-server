import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerAndroidActionRoutes } from "../android-action-routes.mjs";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
  };
}
function makeResponse() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const token = "device-token-value-with-at-least-32-characters";
const deviceId = "android-primary";
const headers = { authorization: `Bearer ${token}`, "x-jarvis-device-id": deviceId };
const tokenHash = createHash("sha256").update(token).digest();

function makePool({ authorized = true } = {}) {
  return {
    async query(sql) {
      if (sql.startsWith("SELECT token_hash")) return authorized ? { rowCount: 1, rows: [{ token_hash: tokenHash }] } : { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
}
async function runAuth(app, method, path, req, res) {
  const [auth] = app.routes.get(`${method} ${path}`);
  let nextCalled = false;
  await auth(req, res, () => { nextCalled = true; });
  return nextCalled;
}

test("registers enrollment, revocation, polling, and result endpoints without a public enqueue endpoint", () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool(), initializeDatabase: async () => {} });
  for (const route of [
    "POST /api/android/enrollment/pairing-code",
    "POST /api/android/enrollment/complete",
    "GET /api/android/enrollment/status",
    "POST /api/android/devices/:id/revoke",
    "GET /api/android/actions/next",
    "POST /api/android/actions/:id/result",
  ]) assert.ok(app.routes.has(route), route);
  assert.equal([...app.routes.keys()].some((key) => /enqueue/i.test(key)), false);
});

test("polling rejects an unknown or revoked device before reaching the handler", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool({ authorized: false }), initializeDatabase: async () => {} });
  const res = makeResponse();
  const nextCalled = await runAuth(app, "GET", "/api/android/actions/next", { headers }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("polling authenticates against the per-device registry and returns an empty queue", async () => {
  const app = makeApp();
  let initialized = false;
  registerAndroidActionRoutes(app, {
    pool: makePool(),
    initializeDatabase: async () => { initialized = true; },
    claimAction: async (_pool, options) => { assert.equal(options.deviceId, deviceId); return null; },
  });
  const req = { headers };
  const res = makeResponse();
  assert.equal(await runAuth(app, "GET", "/api/android/actions/next", req, res), true);
  await app.routes.get("GET /api/android/actions/next")[1](req, res);
  assert.equal(initialized, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { action: null });
});

test("enrollment admin endpoint rejects missing admin credentials", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool(), initializeDatabase: async () => {}, getEnv: () => ({ JARVIS_ANDROID_ENROLLMENT_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters" }) });
  const handler = app.routes.get("POST /api/android/enrollment/pairing-code")[0];
  const res = makeResponse();
  await handler({ headers: {}, ip: "127.0.0.1", body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Operação administrativa não autorizada." });
});

test("result endpoint validates lease token before calling queue repository", async () => {
  const app = makeApp();
  let completeCalled = false;
  registerAndroidActionRoutes(app, { pool: makePool(), initializeDatabase: async () => {}, completeAction: async () => { completeCalled = true; } });
  const req = { headers, params: { id: "action-01" }, body: { result: { ok: true } } };
  const res = makeResponse();
  assert.equal(await runAuth(app, "POST", "/api/android/actions/:id/result", req, res), true);
  await app.routes.get("POST /api/android/actions/:id/result")[1](req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(completeCalled, false);
});

test("queue failures do not leak internal error details", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool(), initializeDatabase: async () => {}, claimAction: async () => { throw new Error("database password leaked"); } });
  const req = { headers };
  const res = makeResponse();
  assert.equal(await runAuth(app, "GET", "/api/android/actions/next", req, res), true);
  await app.routes.get("GET /api/android/actions/next")[1](req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Não foi possível consultar a fila de ações." });
  assert.equal(JSON.stringify(res.body).includes("password"), false);
});


test("link status confirms the authenticated device and returns a current check timestamp", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool(), initializeDatabase: async () => {} });
  const req = { headers };
  const res = makeResponse();
  assert.equal(await runAuth(app, "GET", "/api/android/enrollment/status", req, res), true);
  await app.routes.get("GET /api/android/enrollment/status")[1](req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.deviceId, deviceId);
  assert.ok(Number.isFinite(Date.parse(res.body.checkedAt)));
});

test("link status never confirms a device rejected by the registry", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: makePool({ authorized: false }), initializeDatabase: async () => {} });
  const req = { headers };
  const res = makeResponse();
  const nextCalled = await runAuth(app, "GET", "/api/android/enrollment/status", req, res);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Dispositivo Android não autorizado." });
});
