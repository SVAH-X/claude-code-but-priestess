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


// Settings the VS Code bridge (extension or its webview) may change. The rest
// stays the tray's domain: chatProvider and the priestess* endpoint/key would
// redirect every turn to another backend, personaNotes/chatCwd/updateChannel
// are the Doctor's own, and "agent" mode spawns the CLI with
// --dangerously-skip-permissions behind a consent dialog the bridge can't show.
const isBool = (v) => typeof v === "boolean";
const isCooldownMinutes = (v) => Number.isFinite(v) && v >= 1 && v <= 60;
const BRIDGE_SETTINGS = {
  vibeCodingMode: (v) => v === "companion" || v === "advisor",
  theme: (v) => ["system", "light", "dark"].includes(v),
  vibeCodingDiagnostics: isBool,
  vibeCodingActivityNarration: isBool,
  diagnosticCheckCooldownMin: isCooldownMinutes,
  activityCheckCooldownMin: isCooldownMinutes,
  advisorFileBlacklist: (v) => typeof v === "string" && v.length <= 64 * 1024,
};

// Splits a settings:set patch into the keys the bridge may apply and the ones
// it must refuse (unknown, reserved, or carrying a value outside the bridge's
// range). The caller applies `accepted` and reports `rejected`.
function filterBridgeSettingsPatch(patch) {
  const accepted = {};
  const rejected = [];
  if (!isPlainObject(patch)) return { accepted, rejected };
  for (const [key, value] of Object.entries(patch)) {
    const allow = Object.prototype.hasOwnProperty.call(BRIDGE_SETTINGS, key) && BRIDGE_SETTINGS[key];
    if (allow && allow(value)) accepted[key] = value;
    else rejected.push(key);
  }
  return { accepted, rejected };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const optString = (v) => v == null || typeof v === "string";
const optObject = (v) => v == null || isPlainObject(v);
const chatSendShape = (m) => typeof m.text === "string" && optObject(m.context);

// Field shapes the handlers rely on. A message whose fields fail these checks
// is dropped and its socket closed: anything from a webview is untrusted and
// a TypeError inside the 'message' listener would otherwise take the main
// process down.
const MESSAGE_SHAPES = {
  "chat:inline-complete": (m) =>
    optString(m.prefix) && optString(m.file) && optString(m.language) && optString(m.filePath),
  "chat:send": chatSendShape,
  "vscode:selection-to-chat": chatSendShape,
  "vscode:workspace": (m) =>
    (m.workspaceFolders == null ||
      (Array.isArray(m.workspaceFolders) && m.workspaceFolders.every((f) => typeof f === "string"))) &&
    optString(m.primaryWorkspace),
  "vscode:context": (m) => optObject(m.context),
  "vscode:diagnostics": (m) => m.diagnostics == null || typeof m.diagnostics === "object",
  "vscode:activity": (m) => optObject(m.activity),
  "vscode:terminal-event": () => true, // normalizeTerminalEvent validates
  "settings:set": (m) => isPlainObject(m.patch),
  "vscode:focus": (m) => m.focused === undefined || isBool(m.focused),
};

// Returns null for a well-formed bridge message, otherwise a short reason the
// server logs and sends as the close reason. `authenticated` selects the
// pre-auth rule: before auth the only acceptable message is a string-token
// auth frame.
function describeBadMessage(msg, authenticated) {
  if (!isPlainObject(msg)) return "message must be an object";
  if (typeof msg.type !== "string" || !msg.type) return "missing type";
  if (!authenticated) {
    if (msg.type !== "auth") return "unauthorized";
    if (typeof msg.token !== "string") return "bad auth token";
    return null;
  }
  if (msg.reqId != null && typeof msg.reqId !== "string" && typeof msg.reqId !== "number") {
    return "bad reqId";
  }
  const shape = MESSAGE_SHAPES[msg.type];
  if (shape && !shape(msg)) return "malformed " + msg.type;
  return null;
}

module.exports = {
  VSCODE_WS_ORIGIN,
  isAllowedWsOrigin,
  normalizeTerminalEvent,
  filterBridgeSettingsPatch,
  describeBadMessage,
};
