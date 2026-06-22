const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { WebSocketServer } = require("ws");

const chat = require("./chat");
const vscodeChat = require("./vscode-chat");
const settings = require("./settings");

let wss = null;
let port = null;
let token = null;
let vscodeActive = false;
let vscodeFocused = false;
let currentCatMode = { cat: false, mood: "normal" };
const authenticated = new Set();
let vscodeChatUnsub = null;
let settingsUnsub = null;
let onVscodeConnected = null;
let onVscodeDisconnected = null;
let appVersion = null;

// Vibe coding state
let vscodeWorkspace = null;
let latestDiagnostics = null;
let latestContext = null;
const recentActivities = []; // ring buffer, max 30

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

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  for (const ws of authenticated) {
    if (ws === exclude) continue;
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
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

  const type = msg.type;

  // Auth must come first
  if (!authenticated.has(ws)) {
    if (type === "auth" && msg.token === token) {
      authenticated.add(ws);
      sendTo(ws, { type: "auth:ok", version: appVersion });

      // Send VS Code's own conversation state (not Electron's)
      vscodeChat.init();
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

  const reqId = msg.reqId;

  switch (type) {
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
      vscodeWorkspace = (msg.workspaceFolders && msg.workspaceFolders[0]) || msg.primaryWorkspace || null;
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

    // Conversation lifecycle
    case "conversation:new":
      vscodeChat.startFresh();
      sendTo(ws, { type: "chat:history", history: [] });
      break;
    case "conversation:restore":
      vscodeChat.loadConversation();
      sendTo(ws, { type: "chat:history", history: vscodeChat.getHistory() });
      break;

    // Settings
    case "settings:get":
      if (reqId) sendTo(ws, { type: "settings:get:result", reqId, state: safeSettingsState() });
      break;
    case "settings:set":
      settings.set(msg.patch || {});
      if (reqId) sendTo(ws, { type: "settings:set:result", reqId, state: safeSettingsState() });
      break;

    // Window lifecycle
    case "vscode:active": {
      const wasActive = vscodeActive;
      vscodeActive = true;
      if (!wasActive && onVscodeConnected) onVscodeConnected();
      break;
    }
    case "vscode:inactive": {
      const wasActive = vscodeActive;
      vscodeActive = false;
      if (wasActive && onVscodeDisconnected) onVscodeDisconnected();
      break;
    }
    case "vscode:focus":
      vscodeFocused = Boolean(msg.focused);
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
  token = generateToken();

  wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: (info) => {
      const origin = (info.origin || "").toLowerCase();
      if (!origin) return true;
      if (origin.startsWith("vscode-webview://")) return true;
      if (origin === "file://") return true;
      if (origin.startsWith("http://127.0.0.1:")) return true;
      if (origin.startsWith("http://localhost:")) return true;
      return false;
    }
  });

  wss.on("listening", () => {
    port = wss.address().port;
    writePortFile();
    console.log("ws-server: listening on 127.0.0.1:" + port);
  });

  wss.on("error", (err) => {
    console.warn("ws-server: error", err);
    setTimeout(() => {
      if (wss) {
        try { wss.close(); } catch (_) { /* ignore */ }
      }
      authenticated.clear();
      token = generateToken();
      wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: (info) => {
      const origin = (info.origin || "").toLowerCase();
      if (!origin) return true;
      if (origin.startsWith("vscode-webview://")) return true;
      if (origin === "file://") return true;
      if (origin.startsWith("http://127.0.0.1:")) return true;
      if (origin.startsWith("http://localhost:")) return true;
      return false;
    }
  });
      wss.on("listening", () => {
        port = wss.address().port;
        writePortFile();
        console.log("ws-server: restarted on 127.0.0.1:" + port);
      });
      // Re-bind handlers on the new server
      wss.on("connection", handleConnection);
      wss.on("error", () => { /* swallow */ });
    }, 1000);
  });

  wss.on("connection", handleConnection);

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
}

function handleConnection(ws) {
  ws.on("message", (data) => {
    handleInbound(ws, data.toString());
  });

  ws.on("close", () => {
    authenticated.delete(ws);
    if (authenticated.size === 0 && vscodeActive) {
      vscodeActive = false;
      if (onVscodeDisconnected) onVscodeDisconnected();
    }
  });
}

function stop() {
  if (vscodeChatUnsub) { vscodeChatUnsub(); vscodeChatUnsub = null; }
  if (settingsUnsub) { settingsUnsub(); settingsUnsub = null; }
  if (wss) {
    for (const ws of authenticated) {
      try { ws.close(1000, "server stopping"); } catch (_) { /* ignore */ }
    }
    authenticated.clear();
    vscodeActive = false;
    try { wss.close(); } catch (_) { /* ignore */ }
    wss = null;
  }
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
function isVscodeActive() { return vscodeActive; }
function isVscodeFocused() { return vscodeFocused; }

function setCatMode(mode) {
  currentCatMode = mode || { cat: false, mood: "normal" };
  broadcast({ type: "desktop-pet:cat-mode", ...currentCatMode });
}

module.exports = {
  start, stop, getPort, isVscodeActive, isVscodeFocused, setCatMode, broadcast,
  getVscodeWorkspace: () => vscodeWorkspace,
  getLatestDiagnostics: () => latestDiagnostics,
  getLatestContext: () => latestContext,
  getRecentActivities: () => recentActivities.slice(),
};
