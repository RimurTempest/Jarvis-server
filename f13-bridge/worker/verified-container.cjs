"use strict";

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCancellable } = require("./cancellable-process.cjs");

const IMAGE_PATTERN = /^node@sha256:[a-f0-9]{64}$/;
const MODULE_PATTERN = /^jarvis-bridge\/capabilities\/[A-Za-z0-9_/-]+\.(?:cjs|mjs|js)$/;
const ALLOWED_KEYS = new Set(["kind", "stagingDir", "stagingRoot", "image", "modules"]);
const ROOTLESS_LABEL = "br.jarvis.sandbox=isolated";
const MODULE_SMOKE = [
  '"use strict";',
  'const path=require("node:path");',
  'const {pathToFileURL}=require("node:url");',
  '(async()=>{',
  'const files=process.argv.slice(1);',
  'if(!files.length)throw Error("Sem modulos");',
  'for(const file of files){',
  'if(!/^jarvis-bridge\\/capabilities\\/[A-Za-z0-9_/-]+\\.(cjs|mjs|js)$/.test(file)||file.includes(".."))throw Error("Modulo invalido");',
  'await import(pathToFileURL(path.resolve(file)).href);',
  '}',
  'console.log("JARVIS_MODULE_SMOKE="+files.length);',
  '})().catch(()=>{process.exitCode=1;});'
].join("\n");

function assertOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !ALLOWED_KEYS.has(k))) {
    throw new Error("Opcoes nao permitidas: somente perfil fixo.");
  }
  const { kind, image, modules } = input;
  if (kind !== "suite" && kind !== "smoke") throw new Error("Tipo de teste nao permitido.");
  if (typeof image !== "string" || !IMAGE_PATTERN.test(image)) {
    throw new Error("A imagem precisa estar fixada por digest sha256.");
  }
  if (kind === "smoke") {
    if (!Array.isArray(modules) || modules.length < 1 || modules.length > 6 ||
        new Set(modules).size !== modules.length ||
        modules.some(m => typeof m !== "string" || !MODULE_PATTERN.test(m) ||
          m.includes("..") || m.includes("//"))) {
      throw new Error("Lista de modulos rejeitada.");
    }
  } else if (modules !== undefined) {
    throw new Error("Lista de modulos nao aceita neste tipo de teste.");
  }
}

function assertStaging(input, filesystem) {
  const root = filesystem.realpathSync(input.stagingRoot);
  const stage = filesystem.realpathSync(input.stagingDir);
  if (!filesystem.statSync(root).isDirectory() ||
      !filesystem.statSync(stage).isDirectory() ||
      !stage.startsWith(root + path.sep) ||
      stage === "/" || /[,=\r\n\0]/.test(stage)) {
    throw new Error("Staging de testes invalido: worktree completa nao permitida.");
  }
  let count = 0;
  let totalBytes = 0;
  const stack = [stage];
  while (stack.length) {
    const folder = stack.pop();
    for (const entry of filesystem.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.name.startsWith(".") ||
          /(^|[-_])(secret|token|credential|private|keystore|password)([-_.]|$)/i.test(entry.name)) {
        throw new Error("Staging contem arquivo ou nome sensivel.");
      }
      if (entry.isSymbolicLink()) {
        throw new Error("Staging nao aceita links simbolicos.");
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const s = filesystem.statSync(full);
        totalBytes += s.size;
        if (!/\.(?:js|cjs|mjs|json|txt)$/.test(entry.name) ||
            s.size > 2_000_000 || totalBytes > 8_000_000) {
          throw new Error("Staging contem arquivo nao permitido ou excessivo.");
        }
      } else {
        throw new Error("Staging contem arquivo especial.");
      }
      if (++count > 200) throw new Error("Staging excede o limite de entradas.");
    }
  }
  return stage;
}

function fixedContainerArgs(name, staged, image, kind, modules = [], workerId = null) {
  const command = kind === "suite"
    ? ["node", "jarvis-bridge/ci-test-backend.cjs"]
    : ["node", "-e", MODULE_SMOKE, ...modules];
  return [
    "create", "--name", name, "--pull=never", "--label", ROOTLESS_LABEL,
    ...(workerId ? ["--label", `br.jarvis.worker_id=${workerId}`] : []),
    "--network=none", "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--security-opt=seccomp=builtin",
    "--pids-limit=96", "--memory=768m", "--memory-swap=768m", "--cpus=1",
    "--read-only", "--user=65534:65534",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--mount", `type=bind,source=${staged},target=/workspace,readonly`,
    "--workdir", "/workspace", image, ...command
  ];
}

function createHardenedRunner({
  spawn = cp.spawnSync,
  asyncDocker = runCancellable,
  filesystem = fs,
  uid = process.getuid?.(),
  createId = () => crypto.randomUUID(),
  workerId = null,
  assertLeader = () => { throw new Error("Exclusividade do worker nao comprovada."); }
} = {}) {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("Worker deve executar como usuario nao-root.");
  }
  if (workerId !== null &&
      (typeof workerId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workerId))) {
    throw new Error("Identidade estavel de worker invalida.");
  }
  const socket = `/run/user/${uid}/docker.sock`;
  const dockerEnv = Object.freeze({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    DOCKER_CONFIG: "/nonexistent",
    DOCKER_HOST: `unix://${socket}`
  });

  function docker(args, timeout = 15000) {
    try {
      return spawn("docker", ["-H", `unix://${socket}`, ...args], {
        encoding: "utf8", timeout, maxBuffer: 100000,
        env: { ...dockerEnv }
      });
    } catch {
      return { status: null, error: new Error("Docker indisponivel.") };
    }
  }

  function checkRootless() {
    const st = filesystem.lstatSync(socket);
    if (!st.isSocket() || st.uid !== uid) {
      throw new Error("Socket rootless nao verificado.");
    }
    const status = docker(["info", "--format", "{{json .}}"]);
    if (status.error || status.status !== 0) {
      throw new Error("Daemon rootless indisponivel.");
    }
    let info;
    try { info = JSON.parse(status.stdout); } catch {
      throw new Error("Docker info invalido.");
    }
    const securityOptions = info?.SecurityOptions;
    if (!Array.isArray(securityOptions) ||
        !securityOptions.some(v => /^name=rootless$|^rootless$/.test(String(v))) ||
        String(info.CgroupVersion) !== "2" || info.CgroupDriver !== "systemd") {
      throw new Error("Isolamento rootless/cgroup nao comprovado.");
    }
  }

  function verifyGone(name) {
    const check = docker(["container", "inspect", name], 10000);
    return !check.error && check.status !== 0 &&
      /no such (object|container)/i.test(String(check.stderr || ""));
  }

  function execute(input) {
    assertOptions(input);
    if (workerId) assertLeader();
    const staged = assertStaging(input, filesystem);
    checkRootless();

    const uuid = createId();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
      throw new Error("Identificador de container invalido.");
    }
    const name = `jarvis-sandbox-${uuid.toLowerCase()}`;
    let executionResult = null;
    let caught = null;
    let cleanupError = null;
    try {
      const created = docker(fixedContainerArgs(
        name, staged, input.image, input.kind, input.modules, workerId
      ), 20000);
      if (created.error || created.status !== 0 ||
          !/^[a-f0-9]{64}\s*$/.test(String(created.stdout || ""))) {
        throw new Error("Criacao do container nao confirmada.");
      }

      const started = docker(["start", "--attach", name], 45000);
      if (started.error || started.signal || started.status === null ||
          started.status === undefined) {
        throw new Error("Execucao interrompida ou excedeu o tempo.");
      }
      const inspected = docker(["inspect", "--format", "{{json .State}}", name]);
      if (inspected.error || inspected.status !== 0) {
        throw new Error("Estado final do container indisponivel.");
      }
      let state;
      try { state = JSON.parse(inspected.stdout); } catch {
        throw new Error("Estado final do container invalido.");
      }
      if (state.Status !== "exited" || !Number.isInteger(state.ExitCode) ||
          state.OOMKilled === true) {
        throw new Error("Container nao terminou normalmente.");
      }
      executionResult = {
        executed: true, passed: state.ExitCode === 0 && started.status === 0,
        exitCode: state.ExitCode, stdout: String(started.stdout || "").slice(-4000),
        stderr: String(started.stderr || "").slice(-1000), containerRemoved: false
      };
    } catch (error) {
      caught = error;
    } finally {
      const rm = docker(["rm", "--force", "--volumes", name], 15000);
      if (rm.error || !verifyGone(name)) {
        cleanupError = new Error("Limpeza do container nao comprovada: bloquear o worker.");
      }
    }
    if (cleanupError) throw cleanupError;
    if (caught) throw caught;
    return { ...executionResult, containerRemoved: true };
  }
  function reconcileOrphans() {
    if (!workerId) throw new Error("Identidade estavel obrigatoria para reconciliar orfaos.");
    assertLeader();
    checkRootless();
    const listed = docker([
      "ps", "--all", "--quiet", "--no-trunc",
      "--filter", `label=${ROOTLESS_LABEL}`,
      "--filter", `label=br.jarvis.worker_id=${workerId}`
    ], 15000);
    if (listed.error || listed.status !== 0) {
      throw new Error("Falha ao listar containers orfaos; worker bloqueado.");
    }
    const ids = String(listed.stdout || "").trim()
      ? String(listed.stdout).trim().split(/\s+/) : [];
    if (ids.length > 100 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
        new Set(ids).size !== ids.length) {
      throw new Error("Lista de containers para reconciliacao invalida.");
    }
    for (const id of ids) {
      assertLeader();
      const inspected = docker(["inspect", "--format", "{{json .Config.Labels}}", id], 10000);
      if (inspected.error || inspected.status !== 0) {
        throw new Error("Nao foi possivel confirmar propriedade do container.");
      }
      let labels;
      try { labels = JSON.parse(inspected.stdout); } catch {
        throw new Error("Rotulos do container invalidos.");
      }
      if (labels?.["br.jarvis.sandbox"] !== "isolated" ||
          labels?.["br.jarvis.worker_id"] !== workerId) {
        throw new Error("Container nao pertence a este worker; recuperacao bloqueada.");
      }
      const removed = docker(["rm", "--force", "--volumes", id], 15000);
      if (removed.error || removed.status !== 0 || !verifyGone(id)) {
        throw new Error("Recuperacao de orfao nao comprovada; worker bloqueado.");
      }
    }
    return { inspected: ids.length, removed: ids.length, workerId };
  }
  async function dockerAsync(args, timeout = 15000, signal) {
    try {
      return await asyncDocker("docker", ["-H", `unix://${socket}`, ...args], {
        env: { ...dockerEnv }, timeoutMs: timeout, maxOutputBytes: 100000, signal
      });
    } catch (error) { return { status: null, error }; }
  }
  function ensureActive(signal) {
    if (!signal || typeof signal.addEventListener !== "function" || signal.aborted) {
      throw new Error("Reserva ausente ou cancelada; execucao bloqueada.");
    }
  }
  async function checkRootlessAsync(signal) {
    ensureActive(signal);
    const st = filesystem.lstatSync(socket);
    if (!st.isSocket() || st.uid !== uid) throw new Error("Socket rootless nao verificado.");
    const result = await dockerAsync(["info", "--format", "{{json .}}"], 15000, signal);
    ensureActive(signal);
    if (result.error || result.cancelled || result.status !== 0) throw new Error("Daemon rootless indisponivel.");
    let info;
    try { info = JSON.parse(result.stdout); } catch { throw new Error("Docker info invalido."); }
    if (!Array.isArray(info?.SecurityOptions) ||
        !info.SecurityOptions.some(v => /^name=rootless$|^rootless$/.test(String(v))) ||
        String(info.CgroupVersion) !== "2" || info.CgroupDriver !== "systemd") {
      throw new Error("Isolamento rootless/cgroup nao comprovado.");
    }
  }
  async function verifyGoneAsync(name) {
    const result = await dockerAsync(["container", "inspect", name], 10000);
    return !result.error && !result.cancelled && result.status !== 0 &&
      /no such (object|container)/i.test(String(result.stderr || ""));
  }
  async function executeAsync(input, { signal } = {}) {
    ensureActive(signal); assertOptions(input);
    if (workerId) assertLeader();
    const staged = assertStaging(input, filesystem);
    await checkRootlessAsync(signal);
    ensureActive(signal);
    const uuid = createId();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
      throw new Error("Identificador de container invalido.");
    }
    const name = `jarvis-sandbox-${uuid.toLowerCase()}`;
    let executionResult = null, caught = null, cleanupError = null;
    try {
      // Creation is bounded but not interrupted mid-request: an interrupted
      // daemon request can finish later and create an orphan. If it times out,
      // the outcome is indeterminate and the worker must remain blocked.
      const created = await dockerAsync(fixedContainerArgs(name, staged, input.image, input.kind, input.modules, workerId), 20000);
      if (created.error || created.cancelled || created.status !== 0 ||
          !/^[a-f0-9]{64}\s*$/.test(String(created.stdout || ""))) {
        throw new Error("Criacao do container nao confirmada; reconciliacao obrigatoria.");
      }
      ensureActive(signal);
      const started = await dockerAsync(["start", "--attach", name], 45000, signal);
      ensureActive(signal);
      if (started.error || started.cancelled || started.signal || started.status == null) {
        throw new Error("Execucao interrompida ou excedeu o tempo.");
      }
      const inspected = await dockerAsync(["inspect", "--format", "{{json .State}}", name], 15000, signal);
      ensureActive(signal);
      if (inspected.error || inspected.cancelled || inspected.status !== 0) throw new Error("Estado final indisponivel.");
      let state;
      try { state = JSON.parse(inspected.stdout); } catch { throw new Error("Estado final invalido."); }
      if (state.Status !== "exited" || !Number.isInteger(state.ExitCode) || state.OOMKilled === true) {
        throw new Error("Container nao terminou normalmente.");
      }
      executionResult = { executed:true, passed:state.ExitCode === 0 && started.status === 0,
        exitCode:state.ExitCode, stdout:String(started.stdout || "").slice(-4000),
        stderr:String(started.stderr || "").slice(-1000), containerRemoved:false };
    } catch (error) { caught = error; }
    finally {
      // Cleanup has its own timeout and is never cancelled by the lost lease.
      const removed = await dockerAsync(["rm", "--force", "--volumes", name], 15000);
      if (removed.error || removed.cancelled || !(await verifyGoneAsync(name))) {
        cleanupError = new Error("Limpeza do container nao comprovada: bloquear o worker.");
      }
    }
    if (cleanupError) throw cleanupError;
    if (caught) throw caught;
    ensureActive(signal);
    return { ...executionResult, containerRemoved:true };
  }
  async function reconcileOrphansAsync(signal) {
    ensureActive(signal);
    if (!workerId) throw new Error("Identidade estavel obrigatoria para reconciliar orfaos.");
    assertLeader(); await checkRootlessAsync(signal);
    const listed = await dockerAsync(["ps", "--all", "--quiet", "--no-trunc",
      "--filter", `label=${ROOTLESS_LABEL}`, "--filter", `label=br.jarvis.worker_id=${workerId}`],15000,signal);
    ensureActive(signal);
    if (listed.error || listed.cancelled || listed.status !== 0) throw new Error("Falha ao listar containers orfaos.");
    const ids = String(listed.stdout || "").trim() ? String(listed.stdout).trim().split(/\s+/) : [];
    if (ids.length > 100 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("Lista de containers invalida.");
    for (const id of ids) {
      ensureActive(signal); assertLeader();
      const inspected = await dockerAsync(["inspect", "--format", "{{json .Config.Labels}}", id],10000,signal);
      ensureActive(signal);
      if (inspected.error || inspected.cancelled || inspected.status !== 0) throw new Error("Propriedade do container nao comprovada.");
      let labels;
      try { labels = JSON.parse(inspected.stdout); } catch { throw new Error("Rotulos invalidos."); }
      if (labels?.["br.jarvis.sandbox"] !== "isolated" || labels?.["br.jarvis.worker_id"] !== workerId) throw new Error("Container nao pertence ao worker.");
      // A cleanup already started must finish even if the reservation is revoked.
      const removed = await dockerAsync(["rm", "--force", "--volumes", id],15000);
      if (removed.error || removed.cancelled || removed.status !== 0 || !(await verifyGoneAsync(id))) throw new Error("Recuperacao de orfao nao comprovada.");
    }
    ensureActive(signal);
    return { inspected:ids.length, removed:ids.length, workerId };
  }
  return { execute, executeAsync, checkRootless, reconcileOrphans, reconcileOrphansAsync };
}

module.exports = {
  createHardenedRunner,
  assertOptions,
  fixedContainerArgs
};
