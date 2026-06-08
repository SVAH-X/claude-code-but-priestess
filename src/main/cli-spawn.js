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

module.exports = {
  spawnCli,
  spawnCliSync
};
