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

test("Android capability requests do not fall back to the server repository when Android source is unconfigured", { skip: !databaseUrl }, async (t) => {
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
      EXA_API_KEY: "test-exa-key",
      JARVIS_SELF_IMPROVEMENT_ENABLED: "true",
      JARVIS_GITHUB_TOKEN: "test-github-token-12345678901234567890",
      JARVIS_GITHUB_REPOSITORY: "RimurTempest/Jarvis-server",
      JARVIS_GITHUB_BASE_BRANCH: "main",
      JARVIS_ANDROID_REPOSITORY: "",
      JARVIS_ANDROID_BASE_BRANCH: "main",
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
    body: JSON.stringify({ goal: "Add the ability to send emails from the Android app." }),
  });
  assert.equal(created.status, 201);
  capabilityId = (await created.json()).capability.id;
  pool = new Pool({ connectionString: databaseUrl, max: 1 });

  const refused = await fetch(`${baseUrl}/api/capabilities/${capabilityId}/proposals`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(refused.status, 503);
  const refusal = await refused.json();
  assert.equal(refusal.queued, false);
  assert.equal(refusal.target, "android");
  assert.match(refusal.error, /JARVIS_ANDROID_REPOSITORY/);

  const status = await fetch(`${baseUrl}/api/capabilities/${capabilityId}/proposals`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).proposals, []);
});


test("self-improvement notifications return safe status metadata and require authentication", { skip: !databaseUrl }, async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiToken = "test-jarvis-notification-token";
  const runId = "11111111-1111-4111-8111-111111111111";
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
    if (pool) {
      if (capabilityId) {
        await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE id = $1", [runId]).catch(() => {});
        await pool.query("DELETE FROM jarvis_capabilities WHERE id = $1", [capabilityId]).catch(() => {});
      }
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
    body: JSON.stringify({ goal: "Add a safe Android email drafting capability." }),
  });
  assert.equal(created.status, 201);
  capabilityId = (await created.json()).capability.id;
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await pool.query("DELETE FROM jarvis_self_improvement_runs WHERE id = $1", [runId]);
  await pool.query(
    `INSERT INTO jarvis_self_improvement_runs
      (id, capability_id, target, state, repository, base_branch, pull_request_number, pull_request_url, proposal_summary,
       merge_commit_sha, runtime_revision, rollback_revision)
     VALUES ($1, $2, 'android', 'draft_pr_created', 'RimurTempest/Jarvis-server', 'main', 999,
       'https://github.com/RimurTempest/Jarvis-server/pull/999', 'Proposta de teste',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       'cccccccccccccccccccccccccccccccccccccccc')`,
    [runId, capabilityId],
  );

  const response = await fetch(`${baseUrl}/api/self-improvement/notifications?limit=10`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const notification = body.notifications.find((item) => item.id === runId);
  assert.ok(notification);
  assert.equal(notification.capabilityId, capabilityId);
  assert.equal(notification.state, "draft_pr_created");
  assert.equal(notification.notificationType, "proposal_ready_for_review");
  assert.equal(notification.summary, "Proposta de teste");
  assert.equal(notification.mergeCommitSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(notification.runtimeRevision, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(notification.rollbackRevision, "cccccccccccccccccccccccccccccccccccccccc");
  assert.equal(Object.hasOwn(notification, "token"), false);
  assert.equal(Object.hasOwn(notification, "githubToken"), false);

  const exactRun = await fetch(`${baseUrl}/api/self-improvement/notifications?runId=${runId}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(exactRun.status, 200);
  const exactBody = await exactRun.json();
  assert.equal(exactBody.notifications.length, 1);
  assert.equal(exactBody.notifications[0].id, runId);

  const invalidRunId = await fetch(`${baseUrl}/api/self-improvement/notifications?runId=not-a-uuid`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(invalidRunId.status, 400);

  const invalidLimit = await fetch(`${baseUrl}/api/self-improvement/notifications?limit=999`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(invalidLimit.status, 400);
  const unauthorized = await fetch(`${baseUrl}/api/self-improvement/notifications`);
  assert.equal(unauthorized.status, 401);
});

test("self-improvement readiness endpoint is authenticated and reports missing configuration without secrets", { skip: !databaseUrl }, async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiToken = "test-jarvis-readiness-token";
  const githubToken = "github-secret-test-token-1234567890";
  const exaKey = "exa-secret-test-key";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      JARVIS_API_TOKEN: apiToken,
      GROQ_API_KEY: "test-provider-key",
      OPENAI_API_KEY: "",
      EXA_API_KEY: exaKey,
      JARVIS_GITHUB_TOKEN: githubToken,
      JARVIS_SELF_IMPROVEMENT_ENABLED: "false",
      JARVIS_GITHUB_REPOSITORY: "",
      JARVIS_ANDROID_REPOSITORY: "",
      JARVIS_FULL_STACK_REPOSITORY: "",
    },
    stdio: "ignore",
  });

  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  });

  await waitForServer(baseUrl, child);
  const unauthorized = await fetch(`${baseUrl}/api/self-improvement/status`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/self-improvement/status`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.selfImprovement.ready, false);
  assert.equal(body.selfImprovement.checks.featureEnabled, false);
  assert.ok(body.selfImprovement.missingRequirements.includes("targetRepository"));
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(githubToken), false);
  assert.equal(serialized.includes(exaKey), false);
});

