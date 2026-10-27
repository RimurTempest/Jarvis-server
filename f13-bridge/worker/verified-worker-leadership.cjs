"use strict";

const fs = require("node:fs");

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function assertWorkerLeadership(env = process.env, filesystem = fs) {
  if (env.JARVIS_FLOCK_HELD !== "1" ||
      !UUID_PATTERN.test(String(env.JARVIS_WORKER_ID || ""))) {
    throw new Error("Worker sem instancia estavel e supervisao exclusiva.");
  }
  try {
    if (!filesystem.fstatSync(9).isFile()) {
      throw new Error("Descriptor de lock nao e arquivo regular.");
    }
  } catch {
    throw new Error("Worker nao possui descriptor do supervisor.");
  }
  // Exclusividade real decorre de flock no script supervisor Linux.
  // Esta verificacao apenas confirma que o processo foi iniciado pelo wrapper.
  return env.JARVIS_WORKER_ID;
}

module.exports = { assertWorkerLeadership };
