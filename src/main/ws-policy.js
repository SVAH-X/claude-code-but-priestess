const VSCODE_WS_ORIGIN = "vscode-webview://prts";

function isAllowedWsOrigin(value) {
  const origin = String(value || "").toLowerCase();
  if (!origin) return false;
  if (origin.startsWith("vscode-webview://")) return true;
  if (origin === "file://") return true;
  if (origin.startsWith("http://127.0.0.1:")) return true;
  if (origin.startsWith("http://localhost:")) return true;
  return false;
}

// A failed build/test command reported by the VS Code extension. It ends up
// inside a silent proactive prompt, so only structured fields survive —
// never raw terminal output: a known kind, a non-zero integer exit code, a
// short command label from a restricted character set (the extension sends a
// canonical label such as "npm test", not the typed command line), and a
// timestamp that can't lie in the future.
const TERMINAL_EVENT_KINDS = new Set(["build-error", "test-fail"]);
const TERMINAL_COMMAND_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,47}$/;

function normalizeTerminalEvent(msg, now = Date.now()) {
  if (!msg || !TERMINAL_EVENT_KINDS.has(msg.kind)) return null;
  const exitCode = msg.exitCode;
  if (!Number.isInteger(exitCode) || exitCode === 0) return null;
  const command = typeof msg.command === "string" ? msg.command.trim() : "";
  if (!TERMINAL_COMMAND_LABEL.test(command)) return null;
  const ts = Number(msg.timestamp);
  const at = Number.isFinite(ts) && ts > 0 ? Math.min(ts, now) : now;
  return { kind: msg.kind, command, exitCode, at };
}

module.exports = { VSCODE_WS_ORIGIN, isAllowedWsOrigin, normalizeTerminalEvent };
