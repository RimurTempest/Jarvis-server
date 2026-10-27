"use strict";

const { runIsolatedNodeTests } = require("./verified-sandbox.cjs");

const REQUEST_KEYS = new Set(["worktree", "target", "files", "signal"]);

function runVerifiedSandbox(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !REQUEST_KEYS.has(key))) {
    return Promise.resolve({
      executed: false, passed: false, functionalValidated: false,
      reason: "Contrato do bridge inseguro: argumentos externos recusados."
    });
  }
  return runIsolatedNodeTests({
    worktree: input.worktree,
    target: input.target,
    files: input.files,
    signal: input.signal
  });
}

module.exports = { runVerifiedSandbox };
