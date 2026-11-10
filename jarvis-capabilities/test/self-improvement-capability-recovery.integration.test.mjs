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

async function waitForServer(url, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`JARVIS server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("JARVIS server did not become ready.");
}

function startServer(port, token) {
  return spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      JARVIS_API_TOKEN: token,
      GROQ_API_KEY: "test-provider-key",
      OPENAI_API_KEY: "",
      EXA_API_KEY: "",
      JARVIS_SELF_IMPROVEMENT_ENABLED: "false",
      JARVIS_GITHUB_TOKEN: "",
      JARVIS_GITHUB_REPOSITORY: "",
    },
    stdio: "ignore",
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 4000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

test("startup reconciliation blocks orphaned capabilities stuck in researching", { skip: !databaseUrl }, async (t) => {
  const port = await freePort();
  const token = "test-stale-capability-reconciliation-token";
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let child = startServer(port, token);
  let capabilityId = null;

  t.after(async () => {
    await stopServer(child);
    if (capabilityId) await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
    await pool.end();
  });

  await waitForServer(baseUrl, child);
  const created = await fetch(`${baseUrl}/api/capabilities`, {
    method: "POST",
    headers,
    body: JSON.stringify({ goal: "Recover a stale self-improvement capability." }),
  });
  assert.equal(created.status, 201);
  capabilityId = (await created.json()).capability.id;

  await pool.query(
    `UPDATE jarvis_capabilities
     SET state = 'researching',
         record = jsonb_set(
           jsonb_set(record, '{state}', '"researching"'::jsonb),
           '{updatedAt}', to_jsonb((NOW() - INTERVAL '20 minutes')::text)
         ),
         updated_at = NOW() - INTERVAL '20 minutes'
     WHERE id = $1`,
    [capabilityId],
  );
  await stopServer(child);

  child = startServer(port, token);
  await waitForServer(baseUrl, child);

  const deadline = Date.now() + 10000;
  let currentState = null;
  while (Date.now() < deadline) {
    const current = await pool.query("SELECT state, record FROM jarvis_capabilities WHERE id = $1", [capabilityId]);
    currentState = current.rows[0]?.state ?? null;
    if (currentState === "blocked") {
      assert.equal(current.rows[0].record.state, "blocked");
      assert.match(current.rows[0].record.validation.reason, /orphaned_researching/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(currentState, "blocked", "stale researching capability should be blocked during startup recovery");
});
