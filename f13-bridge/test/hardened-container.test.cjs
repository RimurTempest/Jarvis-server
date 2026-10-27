"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createHardenedRunner,
  assertOptions,
  fixedContainerArgs
} = require("../worker/verified-container.cjs");

const ID = "12345678-1234-4234-a234-123456789abc";
const IMAGE = "node@sha256:" + "a".repeat(64);

function fixture(overrides = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-docker-test-"));
  const root = path.join(top, "staging");
  const stage = path.join(root, "task");
  fs.mkdirSync(stage, { recursive: true });
  const calls = [];
  let inspected = 0;
  const opts = {
    dockerInfo: {
      SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
      CgroupVersion: "2",
      CgroupDriver: "systemd"
    },
    timeoutStart: false, failedCreate: false,
    cleanupNotVerified: false, badState: false,
    ...overrides
  };
  function spawn(_program, args) {
    calls.push(args);
    const action = args[2];
    if (action === "info") {
      return { status: 0, stdout: JSON.stringify(opts.dockerInfo), stderr: "" };
    }
    if (action === "create") {
      return opts.failedCreate
        ? { status: 125, stdout: "", stderr: "create failed" }
        : { status: 0, stdout: "a".repeat(64) + "\n", stderr: "" };
    }
    if (action === "start") {
      return opts.timeoutStart
        ? { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
        : { status: 0, stdout: "TAP version 13\n# tests 1\n# fail 0\n", stderr: "" };
    }
    if (action === "inspect" || action === "container") {
      inspected += 1;
      if (args[3] === "--format") {
        return {
          status: 0, stdout: JSON.stringify(opts.badState
            ? { Status: "running", ExitCode: 0, OOMKilled: false }
            : { Status: "exited", ExitCode: 0, OOMKilled: false }),
          stderr: ""
        };
      }
      return opts.cleanupNotVerified
        ? { status: 0, stdout: "a".repeat(64), stderr: "" }
        : { status: 1, stdout: "", stderr: "Error: No such object" };
    }
    if (action === "rm") return { status: 0, stdout: "", stderr: "" };
    throw new Error("Unexpected docker action: " + action);
  }
  const filesystem = {
    realpathSync: fs.realpathSync,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    lstatSync(p) {
      if (p === "/run/user/1000/docker.sock") return {
        uid: 1000, isSocket: () => true
      };
      return fs.lstatSync(p);
    }
  };
  const runner = createHardenedRunner({
    spawn, filesystem, uid: 1000, createId: () => ID
  });
  const input = {
    kind: "suite", stagingDir: stage, stagingRoot: root, image: IMAGE
  };
  return {
    input, calls, runner,
    cleanup: () => fs.rmSync(top, { recursive: true, force: true })
  };
}

test("runs fixed-profile sandbox and confirms deletion", () => {
  const f = fixture();
  try {
    const result = f.runner.execute(f.input);
    assert.equal(result.executed, true);
    assert.equal(result.passed, true);
    assert.equal(result.containerRemoved, true);
    assert.deepEqual(f.calls.map(c => c[2]),
      ["info", "create", "start", "inspect", "rm", "container"]);
    const create = f.calls[1];
    assert.ok(create.includes("--network=none"));
    assert.ok(create.includes("--read-only"));
    assert.ok(create.includes("--cap-drop=ALL"));
    assert.ok(create.includes("--security-opt=seccomp=builtin"));
    assert.ok(create.includes("--user=65534:65534"));
    assert.ok(create.includes("--memory=768m"));
    assert.ok(create.includes("--pids-limit=96"));
    assert.ok(!create.includes("--privileged"));
    assert.ok(!create.slice(3).some(v => String(v).includes("docker.sock")));
  } finally { f.cleanup(); }
});

test("rejects arbitrary dockerArgs and Docker mount injection", () => {
  assert.throws(() => assertOptions({
    kind: "suite", image: IMAGE, dockerArgs: ["--privileged"]
  }), /Opcoes/);
  const f = fixture();
  try {
    assert.throws(() => f.runner.execute({ ...f.input, dockerArgs: ["--privileged"] }), /Opcoes/);
  } finally { f.cleanup(); }
});

test("fails closed if rootless daemon is not confirmed", () => {
  const f = fixture({
    dockerInfo: {
      SecurityOptions: ["name=seccomp,profile=default"],
      CgroupVersion: "2", CgroupDriver: "systemd"
    }
  });
  try {
    assert.throws(() => f.runner.execute(f.input), /rootless\/cgroup/);
    assert.deepEqual(f.calls.map(c => c[2]), ["info"]);
  } finally { f.cleanup(); }
});

test("fails closed if cgroup driver does not enforce limits", () => {
  const f = fixture({
    dockerInfo: {
      SecurityOptions: ["name=rootless"],
      CgroupVersion: "2", CgroupDriver: "none"
    }
  });
  try {
    assert.throws(() => f.runner.execute(f.input), /rootless\/cgroup/);
  } finally { f.cleanup(); }
});

test("invalid image digest cannot reach docker", () => {
  const f = fixture();
  try {
    assert.throws(() => f.runner.execute({ ...f.input, image: "node:latest" }), /digest/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("timeout triggers forced removal plus absence check", () => {
  const f = fixture({ timeoutStart: true });
  try {
    assert.throws(() => f.runner.execute(f.input), /interrompida/);
    assert.deepEqual(f.calls.map(c => c[2]),
      ["info", "create", "start", "rm", "container"]);
  } finally { f.cleanup(); }
});

test("unverified removal blocks sandbox success", () => {
  const f = fixture({ cleanupNotVerified: true });
  try {
    assert.throws(() => f.runner.execute(f.input), /Limpeza.*nao comprovada/);
  } finally { f.cleanup(); }
});

test("failed create still attempts container cleanup", () => {
  const f = fixture({ failedCreate: true });
  try {
    assert.throws(() => f.runner.execute(f.input), /Criacao/);
    assert.deepEqual(f.calls.map(c => c[2]), ["info", "create", "rm", "container"]);
  } finally { f.cleanup(); }
});

test("refuses a running container and removes it", () => {
  const f = fixture({ badState: true });
  try {
    assert.throws(() => f.runner.execute(f.input), /nao terminou normalmente/);
    assert.ok(f.calls.some(c => c[2] === "rm"));
  } finally { f.cleanup(); }
});

test("rejects mount of entire repository outside staging root", () => {
  const f = fixture();
  try {
    assert.throws(() => f.runner.execute({
      ...f.input, stagingDir: path.dirname(f.input.stagingRoot)
    }), /Staging/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("rejects command or module path injection", () => {
  const f = fixture();
  try {
    assert.throws(() => f.runner.execute({
      ...f.input, kind: "smoke", modules: ["../../etc/passwd"]
    }), /modulos/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("smoke uses only internal node command and allowlisted modules", () => {
  const f = fixture();
  try {
    const a = f.runner.execute({
      ...f.input, kind: "smoke",
      modules: ["jarvis-bridge/capabilities/new-tool.cjs"]
    });
    assert.equal(a.containerRemoved, true);
    assert.ok(f.calls[1].includes("-e"));
  } finally { f.cleanup(); }
});

test("fixed profile is deterministic without caller security overrides", () => {
  const a = fixedContainerArgs("jarvis-sandbox-test", "/tmp/stage/task", IMAGE, "suite");
  assert.equal(a.at(-2), "node");
  assert.equal(a.at(-1), "jarvis-bridge/ci-test-backend.cjs");
  assert.ok(a.includes("--network=none"));
  assert.ok(!a.includes("--env"));
});


test("rejects secrets or symlinks inside staging", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.input.stagingDir, ".env"), "SECRET=not-for-container");
    assert.throws(() => f.runner.execute(f.input), /sensivel/);
    fs.unlinkSync(path.join(f.input.stagingDir, ".env"));
    fs.symlinkSync("/etc/passwd", path.join(f.input.stagingDir, "linked.js"));
    assert.throws(() => f.runner.execute(f.input), /simbolicos/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});
