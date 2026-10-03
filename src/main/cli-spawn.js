const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function isWindowsCommandScript(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command || ""));
}

function quoteForCmd(value) {
  const text = String(value ?? "");
  return `"${text.replace(/(["^&|<>()])/g, "^$1")}"`;
}

function windowsCommandArgs(command, args = []) {
  const line = [quoteForCmd(command), ...args.map(quoteForCmd)].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

function spawnCli(command, args = [], options = {}) {
  if (isWindowsCommandScript(command)) {
    return spawn(process.env.ComSpec || "cmd.exe", windowsCommandArgs(command, args), {
      ...options,
      shell: false,
      // We've already built the fully-quoted `/c "..."` command line by hand;
      // without verbatim args Node re-escapes the quotes and cmd.exe can't parse
      // it (the bug that made spaced paths like C:\Program Files\... fail).
      windowsVerbatimArguments: true
    });
  }
  return spawn(command, args, { ...options, shell: false });
}

function spawnCliSync(command, args = [], options = {}) {
  if (isWindowsCommandScript(command)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", windowsCommandArgs(command, args), {
      ...options,
      shell: false,
      windowsVerbatimArguments: true
    });
  }
  return spawnSync(command, args, { ...options, shell: false });
}

// Kills a CLI started by spawnCli together with its children. On Windows a
// .cmd shim runs as cmd.exe -> node.exe (-> codex.exe), and proc.kill() only
// terminates cmd.exe, leaving the real CLI running (and billing) as an orphan
// that still holds the stdio pipes. taskkill /T /F takes the whole tree down.
function killProcessTree(proc) {
  if (!proc) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/pid", String(proc.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
      // If taskkill cannot start or fails, at least kill the direct child.
      const fallback = () => {
        try { proc.kill(); } catch (_) { /* already gone */ }
      };
      killer.on("error", fallback);
      killer.on("exit", (code) => { if (code) fallback(); });
      return;
    } catch (_) {
      // Fall through to the plain kill below.
    }
  }
  try { proc.kill(); } catch (_) { /* already gone */ }
}

module.exports = {
  killProcessTree,
  spawnCli,
  spawnCliSync
};
