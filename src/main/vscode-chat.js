// Independent chat session for the VS Code extension.
//
// Maintains its own conversation history and CLI subprocess so VS Code
// chats are completely isolated from the Electron popover.  Directives
// ([[mood:X]], [[skill:X ARG]]) and stream parsing are handled here.
// Long-term memory (MEMORY.md, archive, summary) is still shared — both
// conversation surfaces feed the same persona memory files.
//
// Reuses chat.js for provider CLI invocation building and directive
// stripping, persona.js for prompt construction, cli-spawn.js for
// subprocess spawning, and skills.js for skill execution.

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { app } = require("electron");

const chat = require("./chat");
const persona = require("./persona");
const settings = require("./settings");
const skills = require("./skills");
const { spawnCli } = require("./cli-spawn");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let history = [];
let subscribers = [];
let currentProcess = null;
let currentProvider = null;
let messageIdCounter = 0;
let midTurn = false;
let outboundQueue = [];
let vscodeSessionIds = {};
let conversationFile = null;

// Per-turn streaming state
let pendingAssistantText = "";
let currentAssistantId = null;
let currentToolName = null;
let pendingDirectiveBuffer = "";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function conversationPath() {
  return path.join(app.getPath("userData"), "vscode-conversation.json");
}

function saveConversation() {
  try {
    const data = {
      history: history.filter(
        (m) => m.role === "user" || m.role === "assistant"
      ),
      sessionIds: vscodeSessionIds,
    };
    fs.writeFileSync(conversationPath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn("vscode-chat: failed to save conversation", err);
  }
}

function loadConversation() {
  try {
    const raw = fs.readFileSync(conversationPath(), "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.history)) {
      history = data.history.map((m) => ({ ...m, id: m.id || nextId() }));
    }
    if (data && data.sessionIds) {
      vscodeSessionIds = data.sessionIds || {};
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Subscriber bus
// ---------------------------------------------------------------------------

function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}

function emit(event) {
  for (const fn of subscribers) {
    try { fn(event); } catch (_) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

function nextId() {
  return "vscode-" + Date.now() + "-" + ++messageIdCounter;
}

function pushUser(text, context) {
  const entry = { id: nextId(), role: "user", text, ts: Date.now() };
  if (context) entry.context = context;
  history.push(entry);
  emit({ kind: "history", history: history.slice() });
  saveConversation();
  return entry;
}

function beginAssistant() {
  currentAssistantId = nextId();
  pendingAssistantText = "";
  pendingDirectiveBuffer = "";
  history.push({
    id: currentAssistantId,
    role: "assistant",
    text: "",
    ts: Date.now(),
  });
}

function appendAssistant(raw) {
  pendingDirectiveBuffer += raw;
  pendingAssistantText += raw;
  // Strip directives from streaming text for clean display
  const clean = stripPartialDirectives(raw);
  // Check for complete directive tags in the buffer
  checkDirectives();
  if (clean) {
    const entry = history[history.length - 1];
    if (entry && entry.id === currentAssistantId) {
      entry.text += clean;
    }
    emit({ kind: "chunk", messageId: currentAssistantId, text: clean });
  }
}

function stripPartialDirectives(text) {
  // Remove complete [[mood:X]] tags (strict and lenient single-bracket).
  // Also handles full-width colon (：) the way chat.js does.
  let out = text.replace(/\[\[\s*mood\s*[:：]\s*([a-z]+)\s*\]\]/gi, "");
  out = out.replace(/\[\[\s*mood\s*[:：]\s*([a-z]+)\s*\](?=[^\]])/gi, "");
  // Remove [[skill:NAME ARG]] — skill name allows a-z_ only, arg is rest.
  out = out.replace(/\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/gi, "");
  // Remove [[silent]]
  out = out.replace(/\[\[\s*silent\s*\]\]/gi, "");
  // Remove [[observe:…]]
  out = out.replace(/\[\[\s*observe\s*[:：]\s*[^\]]*\s*\]\]/gi, "");
  // Strip trailing partial directive (e.g. "[[mood:ha", "[[mood：开") from display.
  // Handles both ASCII : and full-width ：colons.
  const partialRe = /\[\[\s*(?:mood|skill|observe|silent)[^\]]{0,40}$/;
  const partialMatch = out.match(partialRe);
  if (partialMatch) {
    out = out.slice(0, out.length - partialMatch[0].length);
  }
  return out;
}

function checkDirectives() {
  // Extract and handle complete [[mood:X]] tags
  let match;
  const moodRe = /\[\[mood:([a-z]+)\]\]/gi;
  while ((match = moodRe.exec(pendingDirectiveBuffer)) !== null) {
    emit({ kind: "mood", mood: match[1] });
  }

  // Extract and handle complete [[skill:NAME ARG]] tags
  // Guard on skillsEnabled, matching chat.js behaviour.
  if (settings.get("skillsEnabled") === false) return;
  const skillRe = /\[\[skill:([a-z_]+) ([^\]]+)\]\]/gi;
  while ((match = skillRe.exec(pendingDirectiveBuffer)) !== null) {
    skills.runSkill(match[1], match[2]).then((result) => {
      if (result.receipt) {
        history.push({
          id: nextId(),
          role: "tool",
          summary: result.receipt,
          ts: Date.now(),
        });
        emit({ kind: "history", history: history.slice() });
        saveConversation();
      }
    });
  }
}

function finalizeAssistant() {
  // Strip all remaining directive tags
  const clean = chat.stripDirectiveTags(pendingAssistantText);
  const entry = history[history.length - 1];
  if (entry && entry.id === currentAssistantId) {
    entry.text = clean || pendingAssistantText || "(empty)";
  }
  emit({ kind: "history", history: history.slice() });
  saveConversation();

  // Archive to shared memory
  try {
    persona.ensureConversationArchiveFile();
    const line = JSON.stringify({
      role: "assistant",
      text: clean,
      ts: Date.now(),
    });
    fs.appendFileSync(persona.conversationArchivePath(), line + "\n", "utf8");
  } catch (_) { /* best effort */ }

  pendingAssistantText = "";
  pendingDirectiveBuffer = "";
  currentAssistantId = null;
}

function pushTool(name, summary) {
  history.push({
    id: nextId(),
    role: "tool",
    name,
    summary,
    ts: Date.now(),
  });
  emit({ kind: "history", history: history.slice() });
  saveConversation();
}

// ---------------------------------------------------------------------------
// Stream parsing
// ---------------------------------------------------------------------------

function handleClaudeLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  if (event.type === "system" && event.subtype === "init") {
    vscodeSessionIds.claude = event.session_id;
    saveConversation();
    return;
  }

  if (event.type === "stream_event") {
    const inner = event.event;
    if (inner?.type === "content_block_start") {
      const block = inner.content_block;
      if (block?.type === "tool_use") {
        currentToolName = block.name;
        emit({ kind: "tool", active: true, name: block.name });
      } else if (block?.type === "text") {
        emit({ kind: "tool", active: false });
      }
    } else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      appendAssistant(inner.delta.text || "");
    }
    return;
  }

  if (event.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_use") {
        const summary = block.name + (block.input ? " " + JSON.stringify(block.input).slice(0, 60) : "");
        pushTool(block.name, summary);
      }
    }
    return;
  }

  if (event.type === "user") {
    // tool_result — we could attach output but keeping it simple for now
    return;
  }

  if (event.type === "result") {
    vscodeSessionIds.claude = event.session_id;
    emit({ kind: "tool", active: false });
    finalizeAssistant();
    return;
  }
}

function handleCodexLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  // Codex emits a variety of event shapes; handle the common ones
  if (event.type === "session") {
    vscodeSessionIds.codex = event.session_id || event.id;
    saveConversation();
    return;
  }

  const delta =
    event.delta !== undefined ? String(event.delta) :
    event.text !== undefined ? String(event.text) :
    event.item?.delta !== undefined ? String(event.item.delta) :
    event.item?.text !== undefined ? String(event.item.text) :
    "";

  if (delta) {
    appendAssistant(delta);
  }

  if (event.type === "tool_use" || event.type === "tool_start") {
    currentToolName = event.name || event.item?.name;
    emit({ kind: "tool", active: true, name: currentToolName });
  }

  if (event.type === "tool_result" || event.type === "tool_end") {
    if (currentToolName) {
      pushTool(currentToolName, event.summary || currentToolName);
    }
    emit({ kind: "tool", active: false });
    currentToolName = null;
  }

  // Completion signals
  if (event.type === "turn.completed" || event.type === "result" || event.type === "done") {
    emit({ kind: "tool", active: false });
    finalizeAssistant();
  }
}

// ---------------------------------------------------------------------------
// Context augmentation — inject editor context into user message
// ---------------------------------------------------------------------------

function buildContextAugmentedMessage(userText, context) {
  if (!context || !context.activeFile) return userText;

  const lines = [];
  const file = context.activeFile.split(/[\\/]/).pop();

  lines.push(`【博士当前编辑器上下文】`);
  lines.push(`- 活动文件: ${file}`);
  if (context.activeFileLanguage) lines.push(`- 语言: ${context.activeFileLanguage}`);
  if (context.cursorLine) lines.push(`- 光标: 第 ${context.cursorLine} 行，第 ${context.cursorColumn} 列`);

  if (context.selection && context.selection.text) {
    const lang = context.activeFileLanguage || "";
    const s = context.selection;
    lines.push(`\n博士选中的代码 (${s.startLine}-${s.endLine}行):`);
    lines.push("```" + lang);
    lines.push(s.text);
    lines.push("```");
  }

  lines.push("");
  lines.push("【博士本轮请求】");
  lines.push(userText);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Turn management
// ---------------------------------------------------------------------------

function dispatchSend(trimmed, context) {
  midTurn = true;
  const provider = chat.getProviderAvailability().activeProvider || "claude";
  currentProvider = provider;

  // Inject editor context into the user message so the CLI sees it
  const messageWithContext = buildContextAugmentedMessage(trimmed, context);

  pushUser(trimmed, context);  // store original text + context in history
  beginAssistant();

  const wsServer = require("./ws-server");
  const vscodeWs = wsServer.getVscodeWorkspace();
  const cwd = vscodeWs || settings.get("chatCwd") || "";

  const vibeCodingMode = settings.get("vibeCodingMode") || "companion";
  const invocation = chat.buildProviderInvocation(provider, messageWithContext, cwd, vibeCodingMode, null, "", vscodeSessionIds);

  if (!invocation) {
    const errMsg = "No CLI provider available";
    history.push({ id: nextId(), role: "system", text: errMsg, ts: Date.now() });
    emit({ kind: "status", status: "idle", error: errMsg });
    emit({ kind: "history", history: history.slice() });
    midTurn = false;
    return;
  }

  emit({
    kind: "status",
    status: "running",
    provider,
    sessionId: vscodeSessionIds[provider] || null,
  });

  currentProcess = spawnCli(invocation.command, invocation.args, {
    cwd: cwd || undefined,
    env: { ...process.env },
  });

  if (invocation.stdin) {
    currentProcess.stdin.write(invocation.stdin);
    currentProcess.stdin.end();
  }

  const rl = readline.createInterface({ input: currentProcess.stdout });
  rl.on("line", (line) => {
    if (provider === "claude" || provider === "priestess") {
      handleClaudeLine(line);
    } else if (provider === "codex") {
      handleCodexLine(line);
    }
  });

  let stderr = "";
  currentProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  currentProcess.on("close", (code) => {
    currentProcess = null;
    midTurn = false;

    if (code !== 0 && code !== null) {
      emit({
        kind: "status",
        status: "idle",
        error: "CLI exited with code " + code,
        provider,
      });
    } else {
      emit({ kind: "status", status: "idle", provider });
    }

    // Process queued messages
    if (outboundQueue.length > 0) {
      const next = outboundQueue.shift();
      dispatchSend(next.text, next.context || null);
    }
  });

  currentProcess.on("error", (err) => {
    currentProcess = null;
    midTurn = false;
    emit({
      kind: "status",
      status: "idle",
      error: err.message,
      provider,
    });
  });
}

function send(text, context) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { ok: false, reason: "empty" };
  }
  const trimmed = text.trim();
  if (midTurn) {
    outboundQueue.push({ text: trimmed, context: context || null });
    return { ok: true, queued: true, queueLength: outboundQueue.length };
  }
  dispatchSend(trimmed, context || null);
  return { ok: true };
}

function cancel() {
  if (currentProcess) {
    try { currentProcess.kill(); } catch (_) { /* ignore */ }
    currentProcess = null;
  }
  outboundQueue.length = 0;
  midTurn = false;
  emit({ kind: "status", status: "idle", cancelled: true });
}

function clear() {
  cancel();
  history.length = 0;
  vscodeSessionIds = {};
  emit({ kind: "history", history: [] });
  saveConversation();
}

function getHistory() {
  return history.slice();
}

function isBusy() {
  return midTurn;
}

function hydrate(data) {
  if (data && Array.isArray(data.history)) {
    history = data.history.map((m) => ({ ...m, id: m.id || nextId() }));
  }
  if (data && data.sessionIds) {
    vscodeSessionIds = data.sessionIds || {};
  }
}

function getSessionId() {
  const provider = chat.getProviderAvailability().activeProvider;
  return provider ? vscodeSessionIds[provider] || null : null;
}

// Called on VS Code connect / disconnect
function init() {
  conversationFile = conversationPath();
  persona.ensureMemoryFile();
  persona.ensureConversationArchiveFile();
  persona.ensureConversationSummaryFile();
  loadConversation();
  emit({ kind: "history", history: history.slice() });
}

function startFresh() {
  cancel();
  history.length = 0;
  vscodeSessionIds = {};
  emit({ kind: "history", history: [] });
  saveConversation();
}

function hasPreviousConversation() {
  try {
    return fs.existsSync(conversationPath());
  } catch {
    return false;
  }
}

module.exports = {
  send,
  cancel,
  clear,
  getHistory,
  subscribe,
  hydrate,
  isBusy,
  getSessionId,
  init,
  startFresh,
  hasPreviousConversation,
  loadConversation,
};
