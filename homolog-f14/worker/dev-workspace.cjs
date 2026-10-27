"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { runCancellable } = require("./cancellable-process.cjs");

function fail(message) { throw new Error(message); }
function git(cwd, args) {
  const result = cp.spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      LANG: "C", GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1" }
  });
  if (result.error || result.status !== 0) {
    fail("Git recusou a operação: " +
      (result.error?.message || result.stderr?.trim() || "erro sem detalhes"));
  }
  return result.stdout.trim();
}
function taskId(value) {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    fail("A tarefa precisa de UUID válido.");
  }
  return value.toLowerCase();
}
function verifyRepo(repoPath) {
  const base = fs.realpathSync(repoPath);
  if (git(base, ["rev-parse", "--show-toplevel"]) !== base) {
    fail("O caminho precisa ser a raiz do repositório.");
  }
  if (git(base, ["status", "--porcelain"])) {
    fail("Repositório com mudanças locais; preserve-as antes de desenvolver.");
  }
  const branch = git(base, ["branch", "--show-current"]);
  if (!/^work\/[A-Za-z0-9/_-]+$/.test(branch)) {
    fail("A preparação requer branch work/*, nunca main.");
  }
  const sha = git(base, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(sha)) fail("Commit base inválido.");
  return { base, branch, sha };
}
function verifyWorkspaceDir(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail("A pasta de worktrees deve existir.");
  }
  const actual = fs.realpathSync(root);
  if (actual === "/" || actual === fs.realpathSync(require("node:os").homedir())) {
    fail("Raiz de worktrees não pode ser o diretório do sistema ou pessoal.");
  }
  return actual;
}

/**
 * Materializa somente um worktree Git local. Não gera alterações, commits,
 * PRs, builds, instalações ou mudanças remotas.
 */
function prepareWorkspace({ repoPath, worktreesDir, evolutionId, apply = false }) {
  const id = taskId(evolutionId);
  const repo = verifyRepo(repoPath);
  const workspaceRoot = verifyWorkspaceDir(worktreesDir);
  const branch = `work/evolution/${id}`;
  const target = path.join(workspaceRoot, `jarvis-evolution-${id}`);
  if (repo.base === workspaceRoot || repo.base.startsWith(workspaceRoot + path.sep)) {
    fail("A pasta de worktrees deve estar fora da raiz do repositório.");
  }
  if (fs.existsSync(target)) fail("Worktree já existe: operação não repetida.");
  const refs = git(repo.base, ["branch", "--list", branch]);
  if (refs) fail("Branch da tarefa já existe; não sobrescrever.");
  const manifest = { taskId: id, sourceBranch: repo.branch, baseCommit: repo.sha,
    branch, worktree: target, created: false, remoteTouched: false };
  if (!apply) return manifest;
  try {
    git(repo.base, ["worktree", "add", "--no-track", "-b", branch, target, repo.sha]);
    return { ...manifest, created: true };
  } catch (e) {
    if (fs.existsSync(target)) {
      try { git(repo.base, ["worktree", "remove", "--force", target]); } catch {}
    }
    throw e;
  }
}

// Async variants are for the supervised execution path. Synchronous variants
// remain for pre-claim checks and compatibility; do not call them mid-lease.
async function gitAsync(cwd, args, signal) {
  const result = await runCancellable("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, signal, timeoutMs:30000, maxOutputBytes:1000000,
    env: { PATH:process.env.PATH, HOME:process.env.HOME, LANG:"C",
      GIT_TERMINAL_PROMPT:"0", GIT_CONFIG_NOSYSTEM:"1", GIT_LFS_SKIP_SMUDGE:"1" }
  });
  if (result.cancelled || result.status !== 0) fail("Git interrompido ou recusado; tarefa bloqueada.");
  return result.stdout.trim();
}
async function verifyRepoAsync(repoPath, signal) {
  const base=fs.realpathSync(repoPath);
  if (await gitAsync(base,["rev-parse","--show-toplevel"],signal) !== base) fail("O caminho precisa ser a raiz do repositório.");
  if (await gitAsync(base,["status","--porcelain"],signal)) fail("Repositório com mudanças locais.");
  const branch=await gitAsync(base,["branch","--show-current"],signal);
  if (!/^work\/[A-Za-z0-9/_-]+$/.test(branch)) fail("A preparação requer branch work/*.");
  const sha=await gitAsync(base,["rev-parse","--verify","HEAD"],signal);
  if (!/^[a-f0-9]{40}$/.test(sha)) fail("Commit base inválido.");
  return {base,branch,sha};
}
async function prepareWorkspaceAsync({ repoPath, worktreesDir, evolutionId, apply=false, signal }) {
  const id=taskId(evolutionId),repo=await verifyRepoAsync(repoPath,signal);
  const root=verifyWorkspaceDir(worktreesDir),branch=`work/evolution/${id}`;
  const target=path.join(root,`jarvis-evolution-${id}`);
  if (repo.base===root || repo.base.startsWith(root+path.sep)) fail("Pasta de worktrees inválida.");
  if (fs.existsSync(target)) fail("Worktree já existe: operação não repetida.");
  if (await gitAsync(repo.base,["branch","--list",branch],signal)) fail("Branch da tarefa já existe.");
  const manifest={taskId:id,sourceBranch:repo.branch,baseCommit:repo.sha,branch,worktree:target,created:false,remoteTouched:false};
  if (!apply) return manifest;
  try {
    await gitAsync(repo.base,["worktree","add","--no-track","-b",branch,target,repo.sha],signal);
    return {...manifest,created:true};
  } catch(error) {
    // Cleanup is separate from an already-cancelled lease and remains bounded.
    if (fs.existsSync(target)) { try { await gitAsync(repo.base,["worktree","remove","--force",target]); } catch {} }
    throw error;
  }
}

if (require.main === module) {
  try {
    const [repoPath, worktreesDir, evolutionId, flag] = process.argv.slice(2);
    if (![3, 4].includes(process.argv.slice(2).length) ||
        (flag && flag !== "--apply")) {
      fail("Uso: node dev-workspace.cjs <repo> <pasta-worktrees> <uuid-tarefa> [--apply]");
    }
    const report = prepareWorkspace({
      repoPath, worktreesDir, evolutionId, apply: flag === "--apply"
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (e) {
    process.stderr.write("Preparação recusada: " + e.message + "\n");
    process.exitCode = 1;
  }
}
module.exports = { prepareWorkspace, verifyRepo, taskId, gitAsync, verifyRepoAsync, prepareWorkspaceAsync };
