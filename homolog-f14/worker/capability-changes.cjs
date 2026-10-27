"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function allowed(relative, target) {
  if (typeof relative !== "string" || relative.length > 210 ||
      relative.includes("\0") || relative.includes("\\") ||
      path.posix.normalize(relative) !== relative ||
      relative.startsWith("/") || relative.split("/").some(p => !p || p === "." || p === ".."))
    return false;
  if (target === "android") {
    return /^app\/src\/main\/java\/com\/senhor\/jarvis\/[A-Za-z0-9_/-]+\.(kt|java)$/.test(relative);
  }
  if (target === "server") {
    return /^jarvis-bridge\/capabilities\/[A-Za-z0-9_/-]+\.(cjs|mjs|js)$/.test(relative);
  }
  return false;
}
function assertNoLinks(root, relative) {
  let at = fs.realpathSync(root);
  for (const item of relative.split("/")) {
    at = path.join(at, item);
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) {
      throw new Error("Links simbólicos não são permitidos no destino.");
    }
  }
}
function manifestFor(worktree, target, request) {
  if (!["android", "server"].includes(target)) throw new Error("Escopo inválido.");
  const git = cp.spawnSync("git", ["ls-files", "-z"], {
    cwd: worktree, encoding: "utf8", timeout: 15000, maxBuffer: 1_000_000
  });
  if (git.status !== 0) throw new Error("Não foi possível inventariar arquivos Git.");
  const keywords = String(request).toLowerCase().match(/[a-záàâãéêíóôõúç]{4,}/g) || [];
  const entries = git.stdout.split("\0").filter(f => allowed(f, target))
    .map(f => ({ path: f, score: keywords.filter(x => f.toLowerCase().includes(x)).length }))
    .sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
  const items = [];
  let size = 0;
  for (const f of entries) {
    assertNoLinks(worktree, f.path);
    const stat = fs.statSync(path.join(worktree, f.path));
    if (!stat.isFile() || stat.size > 26000 || size + stat.size > 80000) continue;
    const content = fs.readFileSync(path.join(worktree, f.path), "utf8");
    if (content.includes("\0")) continue;
    size += stat.size;
    items.push({ path: f.path, sha256: sha(content), content });
    if (items.length >= 15) break;
  }
  return items;
}
function prepareChanges(worktree, target, manifest, proposed) {
  if (!Array.isArray(proposed) || proposed.length < 1 || proposed.length > 4)
    throw new Error("Somente 1 a 4 arquivos permitidos.");
  const hashes = new Map(manifest.map(f => [f.path, f.sha256]));
  const seen = new Set();
  let sum = 0;
  return proposed.map(item => {
    const relative = item?.path;
    if (!allowed(relative, target) || seen.has(relative))
      throw new Error("Arquivo fora da área de capacidades ou duplicado.");
    seen.add(relative);
    if (typeof item.content !== "string" || !item.content.trim())
      throw new Error("Arquivo gerado vazio ou inválido.");
    const bytes = Buffer.byteLength(item.content);
    sum += bytes;
    if (bytes > 45000 || sum > 110000)
      throw new Error("Limite de tamanho excedido.");
    const full = path.join(worktree, relative);
    assertNoLinks(worktree, relative);
    const present = fs.existsSync(full);
    if (present) {
      if (!fs.statSync(full).isFile() ||
          !hashes.has(relative) ||
          item.beforeSha256 !== hashes.get(relative) ||
          sha(fs.readFileSync(full)) !== item.beforeSha256) {
        throw new Error("Arquivo original divergente ou fora do inventário.");
      }
    } else if (item.beforeSha256 !== null) {
      throw new Error("Arquivo novo deve declarar beforeSha256=null.");
    }
    if (item.content.includes("-----BEGIN PRIVATE KEY-----"))
      throw new Error("Material de chave privada proibido.");
    return { relative, full, content: item.content, sha256: sha(item.content), added: !present };
  });
}
function applyChanges(worktree, target, manifest, proposed) {
  const prepared = prepareChanges(worktree, target, manifest, proposed);
  for (const item of prepared) {
    fs.mkdirSync(path.dirname(item.full), { recursive: true, mode: 0o755 });
    assertNoLinks(worktree, item.relative);
    const tmp = `${item.full}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, item.content, { flag: "wx", mode: 0o644 });
      fs.renameSync(tmp, item.full);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  return prepared.map(({ relative, sha256, added }) => ({ path: relative, sha256, added }));
}
module.exports = { sha, allowed, manifestFor, prepareChanges, applyChanges };
