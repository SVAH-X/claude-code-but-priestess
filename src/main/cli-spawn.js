const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function isWindowsCommandScript(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command || ""));
}

// Characters cmd.exe interprets outside a quoted span.
const CMD_META_RE = /[&|<>^()]/;

// Quotes one argv token for the `cmd.exe /d /s /c "<line>"` that runs an npm
// .cmd shim. The token crosses three parsers, and each has its own rules:
//
// 1. cmd.exe parses the /c line: every `"` toggles its quote state, `^` only
//    escapes outside quotes (inside, `^` is a literal character), and the
//    carets are consumed.
// 2. The shim re-expands the token through `%*` and cmd.exe parses that line
//    again with the same rules, so a metacharacter that falls outside cmd's
//    quote state must be caret-escaped twice (`^^^&` -> `^&` -> `&`).
// 3. node.exe parses what is left with C-runtime rules: `"` is a literal
//    quote and backslashes only count in front of a quote.
//
// So an embedded `"` becomes `"` for node.exe — which still flips cmd's quote
// state, hence `quoted` lets the caller thread that state through a whole line
// (a token with an odd number of quotes leaves cmd inside quotes). The old
// `^"` form was wrong: the caret survives inside cmd's quotes, so node.exe
// received `model_reasoning_effort=^high^` for `-c model_reasoning_effort="high"`.
function quoteForCmd(value, { quoted = false } = {}) {
  const text = String(value ?? "");
  let out = "\"";
  let inQuotes = !quoted;
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === "\"") {
      // Double the run of backslashes and escape the quote for node.exe.
      out += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
      inQuotes = !inQuotes;
      continue;
    }
    out += "\\".repeat(backslashes);
    backslashes = 0;
    out += !inQuotes && CMD_META_RE.test(ch) ? `^^^${ch}` : ch;
  }
  // A trailing backslash would escape the closing quote for node.exe
  // (`"C:\"` parses as `C:"` and swallows the next token).
  out += "\\".repeat(backslashes * 2) + "\"";
  return out;
}

function cmdQuoteCount(value) {
  return (String(value ?? "").match(/"/g) || []).length;
}

function windowsCommandLine(command, args = []) {
  let quoted = false;
  return [command, ...args]
    .map((token) => {
      const text = quoteForCmd(token, { quoted });
      // 2 + embedded quotes: an odd embedded count flips cmd's state.
      if (cmdQuoteCount(token) % 2 === 1) quoted = !quoted;
      return text;
    })
    .join(" ");
}

function windowsCommandArgs(command, args = []) {
  return ["/d", "/s", "/c", `"${windowsCommandLine(command, args)}"`];
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

// Grace period between SIGTERM and SIGKILL off Windows: long enough for the
// CLI to flush its session file, short enough that Stop feels immediate.
const KILL_GRACE_MS = 3000;

function taskkillCommand(pid) {
  return {
    command: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    args: ["/pid", String(pid), "/T", "/F"]
  };
}

// Kills a CLI started by spawnCli together with its children. On Windows a
// .cmd shim runs as cmd.exe -> node.exe (-> codex.exe), and proc.kill() only
// terminates cmd.exe, leaving the real CLI running (and billing) as an orphan
// that still holds the stdio pipes and keeps streaming into the next turn.
// taskkill /T /F takes the whole tree down. Elsewhere: SIGTERM, then SIGKILL
// after KILL_GRACE_MS if the child ignored it (stuck I/O, defunct child).
//
// `sync` is for the quit/restart paths: app.exit() follows immediately, so the
// Windows taskkill must complete before we return (a fire-and-forget spawn
// would die with us). Off Windows the SIGTERM is delivered synchronously
// already; there is nothing to wait for.
//
// Also accepts the built-in backend's turn handle ({ kill() } without a pid):
// it simply gets kill() calls, which abort the HTTP request.
function killProcessTree(proc, { sync = false } = {}) {
  if (!proc) return;
  const fallback = () => {
    try { proc.kill(); } catch (_) { /* already gone */ }
  };
  if (process.platform === "win32" && proc.pid) {
    const { command, args } = taskkillCommand(proc.pid);
    const options = { shell: false, stdio: "ignore", windowsHide: true };
    if (sync) {
      let result = null;
      try {
        result = spawnSync(command, args, { ...options, timeout: 5000 });
      } catch (_) {
        result = null;
      }
      // If taskkill cannot start or fails, at least kill the direct child.
      if (!result || result.error || result.status !== 0) fallback();
      return;
    }
    try {
      const killer = spawn(command, args, options);
      killer.on("error", fallback);
      killer.on("exit", (code) => { if (code) fallback(); });
      return;
    } catch (_) {
      // Fall through to the plain kill below.
    }
  }
  try { proc.kill("SIGTERM"); } catch (_) { /* already gone */ }
  if (sync) return;
  const timer = setTimeout(() => {
    // Still running (exitCode/signalCode unset until 'exit')? Force it.
    if (proc.exitCode != null || proc.signalCode != null) return;
    try { proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  }, KILL_GRACE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = {
  KILL_GRACE_MS,
  killProcessTree,
  quoteForCmd,
  spawnCli,
  spawnCliSync,
  windowsCommandArgs,
  windowsCommandLine
};
