"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createHardenedRunner
} = require("../worker/verified-container.cjs");
const {
  stageForTests, runIsolatedNodeTests
} = require("../worker/verified-sandbox.cjs");
const { assertWorkerLeadership } = require("../worker/verified-worker-leadership.cjs");

const IMAGE = "node@sha256:" + "c".repeat(64);
const WORKER_ID = "aef0250f-12ad-47c7-a3ea-080cc9374af3";
const CONTAINER_ID = "a".repeat(64);
function fakeDocker(overrides = {}) {
  const calls = [];
  let leaderChecks = 0;
  const labels = {
    "br.jarvis.sandbox": "isolated",
    "br.jarvis.worker_id": WORKER_ID
  };
  const behavior = {
    listing: `${CONTAINER_ID}\n`, labels,
    failList: false, failRemove: false, failInspect: false, ...overrides
  };
  const spawn = (_program, args) => {
    calls.push(args);
    const operation = args[2];
    if (operation === "info") {
      return { status: 0, stdout: JSON.stringify({
        SecurityOptions: ["name=rootless"],
        CgroupVersion: "2", CgroupDriver: "systemd"
      }) };
    }
    if (operation === "ps") return behavior.failList
      ? { status: 1 } : { status: 0, stdout: behavior.listing };
    if (operation === "inspect") return behavior.failInspect
      ? { status: 1 } : { status: 0, stdout: JSON.stringify(behavior.labels) };
    if (operation === "rm") return behavior.failRemove
      ? { status: 1 } : { status: 0 };
    if (operation === "container") return {
      status: 1, stderr: "Error: No such object"
    };
    throw Error("unexpected Docker opcode " + operation);
  };
  const filesystem = {
    lstatSync(file) {
      assert.equal(file, "/run/user/1000/docker.sock");
      return { uid: 1000, isSocket: () => true };
    }
  };
  const runner = createHardenedRunner({
    spawn, filesystem, uid: 1000, workerId: WORKER_ID,
    assertLeader: () => {
      leaderChecks++;
      if (behavior.denyLeader) throw Error("singleton not held");
    }
  });
  return {
    runner, calls, leaderChecks: () => leaderChecks,
    operations: () => calls.map(x => x[2])
  };
}

test("orphan reconciliation removes only verified labelled containers", () => {
  const f = fakeDocker();
  const result = f.runner.reconcileOrphans();
  assert.equal(result.removed, 1);
  assert.equal(result.workerId, WORKER_ID);
  assert.deepEqual(f.operations(), ["info", "ps", "inspect", "rm", "container"]);
  assert.ok(f.calls[1].includes("label=br.jarvis.worker_id=" + WORKER_ID));
  assert.ok(f.leaderChecks() >= 2);
});
test("foreign-label orphan is never removed", () => {
  const f = fakeDocker({ labels: { "br.jarvis.worker_id": "other" } });
  assert.throws(() => f.runner.reconcileOrphans(), /nao pertence/);
  assert.ok(!f.operations().includes("rm"));
});
test("without exclusive leader reconciliation fails before Docker calls", () => {
  const f = fakeDocker({ denyLeader: true });
  assert.throws(() => f.runner.reconcileOrphans(), /singleton/);
  assert.deepEqual(f.operations(), []);
});
test("failure to list containers prevents worker startup", () => {
  const f = fakeDocker({ failList: true });
  assert.throws(() => f.runner.reconcileOrphans(), /listar/);
});
test("failed removal prevents worker startup", () => {
  const f = fakeDocker({ failRemove: true });
  assert.throws(() => f.runner.reconcileOrphans(), /nao comprovada/);
});
test("invalid container IDs are rejected before removal", () => {
  const f = fakeDocker({ listing: "123\n" });
  assert.throws(() => f.runner.reconcileOrphans(), /Lista/);
  assert.ok(!f.operations().includes("rm"));
});
test("missing stable identity prevents orphan reconciliation", () => {
  const r = createHardenedRunner({ uid: 1000 });
  assert.throws(() => r.reconcileOrphans(), /Identidade estavel/);
});
test("forged worker id rejected", () => {
  assert.throws(() => createHardenedRunner({
    uid: 1000, workerId: "not-valid"
  }), /invalida/);
});
test("missing supervisor descriptor is refused", () => {
  assert.throws(() => assertWorkerLeadership({
    JARVIS_FLOCK_HELD: "1", JARVIS_WORKER_ID: WORKER_ID
  }, {
    fstatSync() { throw new Error("EBADF"); }
  }), /descriptor/);
});

function fixture() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stage-test-"));
  const repo = path.join(top, "repo");
  const root = path.join(top, "stages");
  const file = "jarvis-bridge/capabilities/new-capability.cjs";
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o711);
  fs.writeFileSync(path.join(repo, file), "module.exports={test:true};\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=never-copy\n");
  return {
    repo, root, file,
    close: () => fs.rmSync(top, { recursive: true, force: true })
  };
}
test("staging includes only trusted harness and generated modules", () => {
  const f = fixture();
  try {
    const st = stageForTests({
      worktree: f.repo, files: [{ path: f.file }],
      stagingRoot: f.root,
      trustedRoot: path.resolve(__dirname, "../trusted-harness")
    });
    assert.ok(st.stage.startsWith(f.root + path.sep));
    assert.ok(fs.existsSync(path.join(st.stage, f.file)));
    assert.ok(fs.existsSync(path.join(st.stage, "jarvis-bridge/ci-test-backend.cjs")));
    assert.equal(fs.existsSync(path.join(st.stage, ".env")), false);
    assert.equal(fs.readdirSync(st.stage).join(","), "jarvis-bridge");
    fs.rmSync(st.stage, { recursive: true, force: true });
  } finally { f.close(); }
});
test("symlinked generated module fails before staging completes", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.repo, f.file));
    fs.symlinkSync("/etc/passwd", path.join(f.repo, f.file));
    assert.throws(() => stageForTests({
      worktree: f.repo, files: [{ path: f.file }],
      stagingRoot: f.root,
      trustedRoot: path.resolve(__dirname, "../trusted-harness")
    }), /link/);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});
test("hard-linked generated source is refused", () => {
  const f = fixture();
  try {
    fs.linkSync(path.join(f.repo, f.file), path.join(f.repo, "other.js"));
    assert.throws(() => stageForTests({
      worktree: f.repo, files: [{ path: f.file }],
      stagingRoot: f.root,
      trustedRoot: path.resolve(__dirname, "../trusted-harness")
    }), /Arquivo do staging/);
  } finally { f.close(); }
});
test("entire worktree cannot be staging root", () => {
  const f = fixture();
  try {
    assert.throws(() => stageForTests({
      worktree: f.repo, files: [{ path: f.file }],
      stagingRoot: f.repo,
      trustedRoot: path.resolve(__dirname, "../trusted-harness")
    }), /nao isolada/);
  } finally { f.close(); }
});
test("structural passes cannot be reported as functional passes", async () => {
  const f = fixture();
  let n = 0;
  try {
    const result = await runIsolatedNodeTests({
      worktree: f.repo, target: "server", files: [{ path: f.file }],
      image: IMAGE, stagingRoot: f.root,
      signal: new AbortController().signal,
      runnerFactory: () => ({
        async executeAsync(request) {
          n++;
          assert.equal(request.stagingRoot, f.root);
          assert.ok(fs.existsSync(request.stagingDir));
          return request.kind === "suite"
            ? { executed: true, passed: true, containerRemoved: true,
                stdout: "TAP version 13\n# tests 5\n# fail 0\n" }
            : { executed: true, passed: true, containerRemoved: true,
                stdout: "JARVIS_MODULE_SMOKE=1\n" };
        }
      })
    });
    assert.equal(n, 2);
    assert.equal(result.structuralPassed, true);
    assert.equal(result.functionalValidated, false);
    assert.equal(result.passed, false);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});
test("test container creation failure is blocked and staging cleaned", async () => {
  const f = fixture();
  try {
    const result = await runIsolatedNodeTests({
      worktree: f.repo, target: "server", files: [{ path: f.file }],
      image: IMAGE, stagingRoot: f.root,
      signal: new AbortController().signal,
      runnerFactory: () => ({
        async executeAsync() { throw new Error("container cleanup not confirmed"); }
      })
    });
    assert.equal(result.passed, false);
    assert.equal(result.executed, false);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});


test("multiple orphan ids are split individually and all removed", () => {
  const second = "b".repeat(64);
  const f = fakeDocker({ listing: `${CONTAINER_ID}\n${second}\n` });
  const result = f.runner.reconcileOrphans();
  assert.equal(result.removed, 2);
  assert.equal(f.operations().filter(op => op === "rm").length, 2);
  assert.equal(f.operations().filter(op => op === "container").length, 2);
});
