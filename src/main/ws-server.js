const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { WebSocketServer } = require("ws");

const chat = require("./chat");
const vscodeChat = require("./vscode-chat");
const settings = require("./settings");
const {
  isAllowedWsOrigin,
  normalizeTerminalEvent,
  filterBridgeSettingsPatch,
  describeBadMessage,
} = require("./ws-policy");

let wss = null;
let port = null;
let token = null;
let currentCatMode = { cat: false, mood: "normal" };
// Authenticated sockets -> per-window state. Each VS Code window runs its own
// copy of the extension, so "is VS Code active", "is it focused" and "which
// workspace is the cwd" are derived across windows: any-active, any-focused,
// and the workspace of the focused window; with none focused, of the window
// that was focused (or, failing that, connected) most recently. `rank` is
// that recency, from a shared counter.
const clients = new Map();
let rankSeq = 0;
let vscodeChatUnsub = null;
let settingsUnsub = null;
let onVscodeConnected = null;
let onVscodeDisconnected = null;
let vscodeDisconnectTimer = null;
let restartTimer = null;
let appVersion = null;

// Vibe coding state
let latestDiagnostics = null;
let latestContext = null;
const recentActivities = []; // ring buffer, max 30
let latestTerminalEvent = null; // most recent failed build/test command, until proactive consumes it

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function portFilePath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "ws-port.json");
}

function writePortFile() {
  try {
    fs.writeFileSync(
      portFilePath(),
      JSON.stringify({ port, token, version: appVersion }),
      "utf8"
    );
  } catch (err) {
    console.warn("ws-server: failed to write port file", err);
  }
}

// The extension re-reads ws-port.json on every reconnect, so a stale file
// would keep it dialling a dead port with a dead token.
function removePortFile() {
  try { fs.unlinkSync(portFilePath()); } catch (_) { /* already gone */ }
}

function anyActive() {
  for (const c of clients.values()) if (c.active) return true;
  return false;
}

function anyFocused() {
  for (const c of clients.values()) if (c.focused) return true;
  return false;
}

// A window that currently has focus wins outright: a second window merely
// connecting (newer rank, not focused) must not steal the cwd from the one the
// Doctor is typing in. Rank only breaks ties within the same focus state.
function currentWorkspace() {
  let best = null;
  for (const c of clients.values()) {
    if (!c.workspace) continue;
    if (!best || (c.focused && !best.focused) || (c.focused === best.focused && c.rank > best.rank)) best = c;
  }
  return best ? best.workspace : null;
}

// Fires the connected/disconnected callbacks on aggregate transitions only:
// a second window coming or going must not flip the desktop pet.
function noteActiveChange(wasActive) {
  const active = anyActive();
  if (!wasActive && active) {
    clearTimeout(vscodeDisconnectTimer);
    vscodeDisconnectTimer = null;
    if (onVscodeConnected) onVscodeConnected();
  } else if (wasActive && !active && onVscodeDisconnected) {
    onVscodeDisconnected();
  }
}

function tokenMatches(candidate) {
  if (typeof candidate !== "string" || typeof token !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws === exclude) continue;
    if (ws.readyState === 1) {
      try { ws.send(data); } catch (_) { /* socket closed between check and send */ }
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch (_) { /* socket closing */ }
  }
}

// Build a user-visible message from selection-to-chat
function buildContextMessage(text, context) {
  if (!context || !context.activeFile) return text;
  const file = context.activeFile.split(/[\\/]/).pop();
  const sel = context.selection;
  let prefix = `【来自 ${file}`;
  if (sel) prefix += ` L${sel.startLine}-L${sel.endLine}`;
  prefix += `】\n`;
  return prefix + text;
}

function handleInbound(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    ws.close(4000, "invalid json");
    return;
  }

  const isAuthenticated = clients.has(ws);
  const problem = describeBadMessage(msg, isAuthenticated);
  if (problem) {
    if (isAuthenticated) console.warn("ws-server: dropping client, " + problem);
    ws.close(isAuthenticated ? 4000 : 4001, problem);
    return;
  }

  const type = msg.type;

  // Auth must come first
  if (!isAuthenticated) {
    if (tokenMatches(msg.token)) {
      clients.set(ws, { workspace: null, active: false, focused: false, rank: ++rankSeq });
      sendTo(ws, { type: "auth:ok", version: appVersion });

      // Send VS Code's own conversation state (not Electron's). It is loaded
      // once when this bridge starts; reconnecting must not overwrite a live
      // in-memory turn from disk.
      sendTo(ws, { type: "chat:history", history: vscodeChat.getHistory() });
      sendTo(ws, { type: "settings:state", state: safeSettingsState() });
      sendTo(ws, {
        type: "conversation:has-previous",
        hasPrevious: vscodeChat.hasPreviousConversation(),
      });

      const provider = chat.getProviderAvailability();
      sendTo(ws, {
        type: "chat:status",
        status: vscodeChat.isBusy() ? "running" : "idle",
        provider: provider.activeProvider,
        sessionId: vscodeChat.getSessionId(),
      });
      return;
    }
    ws.close(4001, "unauthorized");
    return;
  }

  const reqId = msg.reqId == null ? null : msg.reqId;
  const client = clients.get(ws);

  switch (type) {
    // Inline completion — lightweight, no history side effects. filePath is
    // only used for the sensitive-file / blacklist check, never in the prompt.
    case "chat:inline-complete":
      vscodeChat.complete(msg.prefix, msg.file, msg.language, msg.filePath).then((text) => {
        if (reqId) sendTo(ws, { type: "chat:inline-complete:result", reqId, text });
      }).catch(() => {
        if (reqId) sendTo(ws, { type: "chat:inline-complete:result", reqId, text: null });
      });
      break;

    // VS Code chat — routed to vscode-chat.js (independent session)
    case "chat:send": {
      const result = vscodeChat.send(msg.text, msg.context || null);
      if (reqId) sendTo(ws, { type: "chat:send:result", reqId, ...result });
      if (msg.context?.activeFile) {
        broadcast({ type: "chat:context-attached", context: msg.context });
      }
      break;
    }

    // Vibe coding: selection sent as a chat message
    case "vscode:selection-to-chat": {
      const wrapped = buildContextMessage(msg.text, msg.context);
      const result = vscodeChat.send(wrapped, msg.context || null);
      if (reqId) sendTo(ws, { type: "chat:send:result", reqId, ...result });
      if (msg.context?.activeFile) {
        broadcast({ type: "chat:context-attached", context: msg.context });
      }
      break;
    }

    // Vibe coding: workspace paths
    case "vscode:workspace":
      client.workspace = (msg.workspaceFolders && msg.workspaceFolders[0]) || msg.primaryWorkspace || null;
      break;

    // Vibe coding: editor context snapshot
    case "vscode:context":
      latestContext = msg.context || null;
      break;

    // Vibe coding: diagnostics snapshot
    case "vscode:diagnostics":
      latestDiagnostics = msg.diagnostics || null;
      break;

    // Vibe coding: activity events (save, task, git)
    case "vscode:activity":
      if (msg.activity && typeof msg.activity.kind === "string") {
        recentActivities.push(msg.activity);
        if (recentActivities.length > 30) recentActivities.shift();
      }
      break;
    // Vibe coding: a build/test command failed in the integrated terminal.
    case "vscode:terminal-event": {
      const evt = normalizeTerminalEvent(msg);
      if (evt) latestTerminalEvent = evt;
      break;
    }
    case "chat:cancel":
      vscodeChat.cancel();
      break;
    case "chat:clear":
      vscodeChat.clear();
      if (reqId) sendTo(ws, { type: "chat:clear:result", reqId, ok: true });
      break;
    case "chat:get-history":
      if (reqId) sendTo(ws, { type: "chat:get-history:result", reqId, history: vscodeChat.getHistory() });
      break;
    // Read-only snapshot of the shared VS Code conversation. A window uses it
    // to decide whether offering "restore / start fresh" is safe: never while
    // a turn is running or another window shares the same live conversation.
    // `clients` counts every authenticated socket, the asking one included.
    case "chat:state":
      if (reqId) {
        sendTo(ws, {
          type: "chat:state:result",
          reqId,
          busy: vscodeChat.isBusy(),
          clients: clients.size,
          hasPrevious: vscodeChat.hasPreviousConversation(),
          historyLength: vscodeChat.getHistory().length,
        });
      }
      break;

    // Conversation lifecycle
    case "conversation:new":
      vscodeChat.startFresh();
      if (reqId) sendTo(ws, { type: "conversation:new:result", reqId, ok: true });
      sendTo(ws, { type: "chat:history", history: [] });
      break;
    case "conversation:restore":
      vscodeChat.loadConversation();
      if (reqId) sendTo(ws, { type: "conversation:restore:result", reqId, ok: true });
      sendTo(ws, { type: "chat:history", history: vscodeChat.getHistory() });
      break;

    // Settings
    case "settings:get":
      if (reqId) sendTo(ws, { type: "settings:get:result", reqId, state: safeSettingsState() });
      break;
    case "settings:set": {
      const { accepted, rejected } = filterBridgeSettingsPatch(msg.patch);
      if (Object.keys(accepted).length > 0) settings.set(accepted);
      if (rejected.length > 0) {
        console.warn("ws-server: settings:set from the bridge rejected keys: " + rejected.join(", "));
      }
      if (reqId) {
        const reply = { type: "settings:set:result", reqId, ok: rejected.length === 0, state: safeSettingsState() };
        if (rejected.length > 0) {
          reply.rejected = rejected;
          reply.error = "这些设置不能从 VS Code 修改：" + rejected.join("、");
        }
        sendTo(ws, reply);
      }
      break;
    }

    // Window lifecycle (per window; callbacks fire on the aggregate)
    case "vscode:active": {
      const wasActive = anyActive();
      client.active = true;
      clearTimeout(vscodeDisconnectTimer);
      vscodeDisconnectTimer = null;
      noteActiveChange(wasActive);
      break;
    }
    case "vscode:inactive": {
      const wasActive = anyActive();
      client.active = false;
      noteActiveChange(wasActive);
      break;
    }
    case "vscode:focus":
      client.focused = Boolean(msg.focused);
      if (client.focused) client.rank = ++rankSeq;
      break;

    case "desktop-pet:cat-mode-get":
      if (reqId) {
        sendTo(ws, {
          type: "desktop-pet:cat-mode-get:result",
          reqId,
          ...currentCatMode,
        });
      }
      break;

    default:
      break;
  }
}

function start(callbacks) {
  if (callbacks) {
    onVscodeConnected = callbacks.onVscodeConnected || null;
    onVscodeDisconnected = callbacks.onVscodeDisconnected || null;
  }

  appVersion = require("electron").app.getVersion();
  listen("listening");

  // Bridge VS Code chat events to WS (NOT Electron chat events)
  vscodeChatUnsub = vscodeChat.subscribe((event) => {
    switch (event.kind) {
      case "history":
        broadcast({ type: "chat:history", history: event.history });
        break;
      case "chunk":
        broadcast({
          type: "chat:chunk",
          messageId: event.messageId,
          text: event.text,
        });
        break;
      case "status":
        broadcast({
          type: "chat:status",
          status: event.status,
          provider: event.provider,
          sessionId: event.sessionId,
          error: event.error,
          cancelled: event.cancelled,
        });
        break;
      case "tool":
        broadcast({
          type: "chat:tool",
          active: event.active,
          name: event.name,
          summary: event.summary,
        });
        break;
      case "mood":
        broadcast({ type: "chat:mood", mood: event.mood });
        break;
    }
  });

  // Bridge settings changes to WS
  settingsUnsub = settings.subscribe((_state) => {
    broadcast({ type: "settings:state", state: safeSettingsState() });
  });

  vscodeChat.init();
}

// Binds a fresh server with a fresh token. `verb` is only for the log line.
function listen(verb) {
  token = generateToken();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: (info) => isAllowedWsOrigin(info.origin)
  });
  wss = server;

  server.on("listening", () => {
    if (server !== wss) return;
    port = server.address().port;
    writePortFile();
    console.log("ws-server: " + verb + " on 127.0.0.1:" + port);
  });

  server.on("error", (err) => {
    if (server !== wss) return; // a superseded server's late error
    console.warn("ws-server: error", err);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restart, 1000);
  });

  server.on("connection", handleConnection);
}

// Closes every socket of the current server with a code the client treats as
// a normal reconnect, and drops the port file so the client reads the new
// one (new port, new token) instead of dialling the old pair.
function teardown(code, reason) {
  clearTimeout(restartTimer);
  restartTimer = null;
  if (!wss) return;
  for (const ws of wss.clients) {
    try { ws.close(code, reason); } catch (_) { /* ignore */ }
  }
  removePortFile();
  try { wss.close(); } catch (_) { /* ignore */ }
  wss = null;
  port = null;
}

// Replaces the listening server (after a wss 'error', or on demand). The old
// clients get 1012 "service restart" so the extension reconnects and re-reads
// ws-port.json; the per-window state follows their close events as usual.
function restart() {
  if (!wss) return; // stopped meanwhile
  teardown(1012, "service restart");
  listen("restarted");
}

function handleConnection(ws) {
  // Without a listener the ws library's own errors (e.g. "Max payload size
  // exceeded" for a > maxPayload frame, which it answers with 1009) are
  // rethrown and would take the main process down.
  ws.on("error", (err) => {
    console.warn("ws-server: client socket error: " + (err && err.message));
  });

  ws.on("message", (data) => {
    try {
      handleInbound(ws, data.toString());
    } catch (err) {
      console.warn("ws-server: message handler threw", err);
      try { ws.close(4002, "internal error"); } catch (_) { /* ignore */ }
    }
  });

  ws.on("close", () => {
    const wasActive = anyActive();
    clients.delete(ws);
    if (wasActive && !anyActive()) {
      // Debounce: a rapid reconnect (within 200ms) cancels the disconnect callback.
      clearTimeout(vscodeDisconnectTimer);
      vscodeDisconnectTimer = setTimeout(() => {
        vscodeDisconnectTimer = null;
        if (onVscodeDisconnected) onVscodeDisconnected();
      }, 200);
    }
  });
}

function stop() {
  if (vscodeChatUnsub) { vscodeChatUnsub(); vscodeChatUnsub = null; }
  if (settingsUnsub) { settingsUnsub(); settingsUnsub = null; }
  teardown(1000, "server stopping");
  clients.clear();
  clearTimeout(vscodeDisconnectTimer);
  vscodeDisconnectTimer = null;
  port = null;
  token = null;
}

// Returns a settings snapshot safe for broadcast to WS clients (redacts secrets).
function safeSettingsState() {
  const state = settings.getAll();
  // Redact API key — show only first & last 4 chars if set.
  if (state.priestessApiKey && state.priestessApiKey.length > 8) {
    state.priestessApiKey =
      state.priestessApiKey.slice(0, 4) + "…" + state.priestessApiKey.slice(-4);
  }
  return state;
}

function getPort() { return port; }
function isVscodeActive() { return anyActive(); }
function isVscodeFocused() { return anyFocused(); }

function setCatMode(mode) {
  currentCatMode = mode || { cat: false, mood: "normal" };
  broadcast({ type: "desktop-pet:cat-mode", ...currentCatMode });
}

module.exports = {
  start, stop, restart, getPort, isVscodeActive, isVscodeFocused, setCatMode, broadcast,
  getVscodeWorkspace: currentWorkspace,
  getLatestDiagnostics: () => latestDiagnostics,
  getLatestContext: () => latestContext,
  getRecentActivities: () => recentActivities.slice(),
  getLatestTerminalEvent: () => latestTerminalEvent,
  // Returns the pending terminal event and clears it, so one failure is
  // narrated at most once.
  takeTerminalEvent: () => {
    const evt = latestTerminalEvent;
    latestTerminalEvent = null;
    return evt;
  },
};
