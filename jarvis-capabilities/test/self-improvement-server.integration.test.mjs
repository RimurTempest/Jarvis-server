import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const { Pool } = pg;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`J.A.R.V.I.S. server exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`J.A.R.V.I.S. server did not become ready: ${lastError?.message || "timeout"}`);
}

test("server exposes authenticated proposal status and fails closed when pipeline is disabled", { skip: !databaseUrl }, async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiToken = "test-jarvis-api-token";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      JARVIS_API_TOKEN: apiToken,
      GROQ_API_KEY: "test-provider-key",
      OPENAI_API_KEY: "",
      EXA_API_KEY: "",
      JARVIS_SELF_IMPROVEMENT_ENABLED: "false",
      JARVIS_GITHUB_TOKEN: "",
      JARVIS_GITHUB_REPOSITORY: "",
      JARVIS_GITHUB_BASE_BRANCH: "main",
    },
    stdio: "ignore",
  });
  let pool;
  let capabilityId = null;
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    if (pool && capabilityId) {
      await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
      await pool.end();
    }
  });

  await waitForServer(baseUrl, child);
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const created = await fetch(`${baseUrl}/api/capabilities`, {
    method: "POST",
    headers,
    body: JSON.stringify({ goal: "Add a capability for drafting email messages." }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  capabilityId = createdBody.capability.id;
  pool = new Pool({ connectionString: databaseUrl, max: 1 });

  const disabled = await fetch(`${baseUrl}/api/capabilities/${capabilityId}/proposals`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(disabled.status, 503);
  assert.match((await disabled.json()).error, /não está habilitado/i);

  const status = await fetch(`${baseUrl}/api/capabilities/${capabilityId}/proposals`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).proposals, []);

  const unauthorized = await fetch(`${baseUrl}/api/capabilities/${capabilityId}/proposals`);
  assert.equal(unauthorized.status, 401);
});
