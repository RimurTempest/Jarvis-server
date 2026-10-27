"use strict";

const cp = require("node:child_process");

const command = cp.spawnSync(process.execPath, [
  "--test", "jarvis-bridge/test/phase12-contract.test.cjs"
], {
  cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
  maxBuffer: 120_000,
  env: { PATH: process.env.PATH, HOME: "/nonexistent", NODE_OPTIONS: "" }
});
if (command.stdout) process.stdout.write(command.stdout);
if (command.stderr) process.stderr.write(command.stderr);
if (command.error || command.signal || command.status !== 0) process.exitCode = 1;
