import test from "node:test";
import assert from "node:assert/strict";
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
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const env = {
  JARVIS_ANDROID_DEVICE_TOKEN: "a".repeat(48),
  JARVIS_ANDROID_DEVICE_ID: "android-primary",
};
const headers = {
  authorization: `Bearer ${env.JARVIS_ANDROID_DEVICE_TOKEN}`,
  "x-jarvis-device-id": env.JARVIS_ANDROID_DEVICE_ID,
};

test("registers polling and result endpoints without exposing an enqueue endpoint", () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, { pool: {}, initializeDatabase: async () => {}, getEnv: () => env });
  assert.ok(app.routes.has("GET /api/android/actions/next"));
  assert.ok(app.routes.has("POST /api/android/actions/:id/result"));
  assert.equal([...app.routes.keys()].some((key) => /enqueue/i.test(key)), false);
});

test("polling rejects an unconfigured or unauthorized device before database access", async () => {
  const app = makeApp();
  let initialized = false;
  registerAndroidActionRoutes(app, {
    pool: {},
    initializeDatabase: async () => { initialized = true; },
    getEnv: () => ({}),
  });
  const [auth, handler] = app.routes.get("GET /api/android/actions/next");
  const res = makeResponse();
  let nextCalled = false;
  auth({ headers }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
  assert.equal(initialized, false);
  assert.equal(typeof handler, "function");
});

test("polling returns an empty result when no action is available", async () => {
  const app = makeApp();
  let initialized = false;
  registerAndroidActionRoutes(app, {
    pool: {},
    initializeDatabase: async () => { initialized = true; },
    getEnv: () => env,
    claimAction: async (_pool, options) => {
      assert.equal(options.deviceId, "android-primary");
      return null;
    },
  });
  const [auth, handler] = app.routes.get("GET /api/android/actions/next");
  const req = { headers };
  const res = makeResponse();
  await new Promise((resolve) => auth(req, res, resolve));
  await handler(req, res);
  assert.equal(initialized, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { action: null });
});

test("result endpoint requires a sufficiently long lease token and object result", async () => {
  const app = makeApp();
  let completeCalled = false;
  registerAndroidActionRoutes(app, {
    pool: {},
    initializeDatabase: async () => {},
    getEnv: () => env,
    completeAction: async () => { completeCalled = true; },
  });
  const [auth, handler] = app.routes.get("POST /api/android/actions/:id/result");
  const req = { headers, params: { id: "action-01" }, body: { result: { ok: true } } };
  const res = makeResponse();
  await new Promise((resolve) => auth(req, res, resolve));
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(completeCalled, false);
});

test("result endpoint passes the device-bound lease to the queue repository", async () => {
  const app = makeApp();
  let captured = null;
  registerAndroidActionRoutes(app, {
    pool: {},
    initializeDatabase: async () => {},
    getEnv: () => env,
    completeAction: async (_pool, args) => {
      captured = args;
      return { id: args.id, state: "completed", result: { ok: true } };
    },
  });
  const [auth, handler] = app.routes.get("POST /api/android/actions/:id/result");
  const req = {
    headers: { ...headers, "x-jarvis-lease-token": "l".repeat(43) },
    params: { id: "action-01" },
    body: { result: { ok: true, message: "done" } },
  };
  const res = makeResponse();
  await new Promise((resolve) => auth(req, res, resolve));
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(captured.id, "action-01");
  assert.equal(captured.deviceId, "android-primary");
  assert.equal(captured.leaseToken, "l".repeat(43));
  assert.deepEqual(captured.result, { ok: true, message: "done" });
  assert.equal(res.body.action.state, "completed");
});

test("queue failures do not leak internal error details", async () => {
  const app = makeApp();
  registerAndroidActionRoutes(app, {
    pool: {},
    initializeDatabase: async () => {},
    getEnv: () => env,
    claimAction: async () => { throw new Error("database password leaked"); },
  });
  const [auth, handler] = app.routes.get("GET /api/android/actions/next");
  const req = { headers };
  const res = makeResponse();
  await new Promise((resolve) => auth(req, res, resolve));
  await handler(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Não foi possível consultar a fila de ações." });
  assert.equal(JSON.stringify(res.body).includes("password"), false);
});
