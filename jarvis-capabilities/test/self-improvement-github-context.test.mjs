import test from "node:test";
import assert from "node:assert/strict";
import { fetchSelfImprovementRepositoryContext } from "../self-improvement-github-context.mjs";

const revision = "a".repeat(40);
const source = "export const safe = true;\n";

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function fakeFetch({ truncated = false } = {}) {
  const calls = [];
  const tree = [
    { path: "server.js", type: "blob", size: 100 },
    { path: "package.json", type: "blob", size: 50 },
    { path: "jarvis-capabilities/example.mjs", type: "blob", size: 70 },
    { path: "jarvis-capabilities/test/example.test.mjs", type: "blob", size: 20 },
    { path: "app/src/main/java/com/senhor/jarvis/MainActivity.kt", type: "blob", size: 100 },
    { path: "app/src/main/AndroidManifest.xml", type: "blob", size: 90 },
    { path: "app/src/test/java/com/senhor/jarvis/ExampleUnitTest.kt", type: "blob", size: 40 },
    { path: "local.properties", type: "blob", size: 10 },
    { path: ".env.production", type: "blob", size: 10 },
    { path: "secrets/key.json", type: "blob", size: 10 },
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: revision } });
    if (url.endsWith(`/git/trees/${revision}?recursive=1`)) return response(200, { truncated, tree });
    if (url.includes("/contents/")) {
      const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      return response(200, { encoding: "base64", content: Buffer.from(path === "server.js" ? source : `// ${path}\n${source}`).toString("base64") });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

test("fetches bounded context from an exact base revision and excludes unsafe files", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await fetchSelfImprovementRepositoryContext({
    token: "x".repeat(40), repository: "example/repo", baseBranch: "main",
    goal: "Add an Android action capability", fetchImpl,
  });
  assert.equal(result.baseRevision, revision);
  assert.ok(result.contextFiles.some((file) => file.path === "server.js"));
  assert.equal(result.contextFiles.some((file) => file.path.includes(".env")), false);
  assert.equal(result.contextFiles.some((file) => file.path.includes("secrets/")), false);
  assert.equal(result.contextFiles.some((file) => file.path.includes(".test.mjs")), false);
  assert.ok(result.contextFiles.some((file) => file.path.endsWith("MainActivity.kt")));
  assert.ok(result.contextFiles.some((file) => file.path.endsWith("AndroidManifest.xml")));
  assert.ok(result.contextFiles.some((file) => file.path.endsWith("ExampleUnitTest.kt")));
  assert.equal(result.contextFiles.some((file) => file.path === "local.properties"), false);
  assert.ok(calls.every((call) => call.options.headers.Authorization === "Bearer " + "x".repeat(40)));
});

test("fails closed when GitHub reports a truncated repository tree", async () => {
  const { fetchImpl } = fakeFetch({ truncated: true });
  await assert.rejects(fetchSelfImprovementRepositoryContext({
    token: "x".repeat(40), repository: "example/repo", baseBranch: "main",
    goal: "Add an email capability", fetchImpl,
  }), /árvore do repositório está incompleta/i);
});

test("validates repository configuration before network access", async () => {
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(fetchSelfImprovementRepositoryContext({
    token: "short", repository: "example/repo", baseBranch: "main",
    goal: "Add an email capability", fetchImpl,
  }), /Token do GitHub/);
  await assert.rejects(fetchSelfImprovementRepositoryContext({
    token: "x".repeat(40), repository: "example/repo", baseBranch: "../main",
    goal: "Add an email capability", fetchImpl,
  }), /baseBranch/);
  assert.equal(calls.length, 0);
});

test("rejects a repository with no eligible source files", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: revision } });
    if (url.includes("/git/trees/")) return response(200, { truncated: false, tree: [{ path: ".env", type: "blob", size: 10 }] });
    throw new Error("No content should be fetched.");
  };
  await assert.rejects(fetchSelfImprovementRepositoryContext({
    token: "x".repeat(40), repository: "example/repo", baseBranch: "main",
    goal: "Add an email capability", fetchImpl,
  }), /Nenhum arquivo de código seguro/i);
});

test("refuses source files containing likely credentials before returning model context", async () => {
  const secretContent = 'const mailPassword = "real-mail-password-value-123";';
  const fetchImpl = async (url) => {
    if (url.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: revision } });
    if (url.includes("/git/trees/")) {
      return response(200, {
        truncated: false,
        tree: [{ path: "app/src/main/java/com/example/MailConfig.kt", type: "blob", size: secretContent.length }],
      });
    }
    if (url.includes("/contents/")) {
      return response(200, { encoding: "base64", content: Buffer.from(secretContent).toString("base64") });
    }
    throw new Error("Unexpected request.");
  };
  await assert.rejects(fetchSelfImprovementRepositoryContext({
    token: "x".repeat(40),
    repository: "example/repo",
    baseBranch: "main",
    goal: "Add an email capability",
    fetchImpl,
  }), /Possível segredo detectado/i);
});
