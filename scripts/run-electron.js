const { spawn } = require("node:child_process");
const path = require("node:path");

const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, "..")], {
  cwd: path.join(__dirname, ".."),
  env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

let shuttingDown = false;

function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.killed) {
    child.kill(signal);
  }
  setTimeout(() => process.exit(exitCodeForSignal(signal)), 1200).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(exitCodeForSignal(signal));
    return;
  }
  process.exit(code ?? 0);
});
