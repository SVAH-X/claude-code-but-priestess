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
let directiveTailBuffer = ""; // partial directive fragment spanning chunk boundaries

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
  // Archive to shared memory so the doctor's words aren't lost.
  try {
    persona.ensureConversationArchiveFile();
    const line = JSON.stringify({ role: "user", text, ts: Date.now() });
    fs.appendFileSync(persona.conversationArchivePath(), line + "\n", "utf8");
  } catch (_) { /* best effort */ }
  return entry;
}

function beginAssistant() {
  currentAssistantId = nextId();
  pendingAssistantText = "";
  pendingDirectiveBuffer = "";
  directiveTailBuffer = "";
  skillExecutedThisTurn.clear();
  rememberedThisTurn.clear();
  lastEmittedMood = null;
  history.push({
    id: currentAssistantId,
    role: "assistant",
    text: "",
    ts: Date.now(),
  });
}

function appendAssistant(raw) {
  pendingAssistantText += raw;
  // Accumulate into the directive buffer for complete-tag matching.
  pendingDirectiveBuffer += raw;
  // Cross-chunk directive guard: prepend any buffered tail from the previous
  // chunk so tags split across chunk boundaries don't leak their second half.
  const displayInput = directiveTailBuffer + raw;
  // Strip directives from streaming text for clean display.
  const clean = stripPartialDirectives(displayInput);
  // Hold back a trailing partial tag for the next chunk.
  const partialRe = /\[\[\s*(?:mood|skill|observe|silent|remember)[^\]]{0,40}$/;
  const partialMatch = clean.match(partialRe);
  if (partialMatch) {
    directiveTailBuffer = partialMatch[0];
  } else {
    directiveTailBuffer = "";
  }
  // Check for complete directive tags in the accumulated buffer.
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
  // Remove [[remember:…]]
  out = out.replace(/\[\[\s*remember\s*[:：]\s*[^\]]*\s*\]\]/gi, "");
  // Strip trailing partial directive from display.
  const partialRe = /\[\[\s*(?:mood|skill|observe|silent|remember)[^\]]{0,40}$/;
  const partialMatch = out.match(partialRe);
  if (partialMatch) {
    out = out.slice(0, out.length - partialMatch[0].length);
  }
  return out;
}

const skillExecutedThisTurn = new Set();
let lastEmittedMood = null;
const rememberedThisTurn = new Set();

function checkDirectives() {
  let match;

  // Extract and handle complete [[mood:X]] tags (strict + lenient single-bracket).
  // Dedup per-turn: only emit when the mood actually changes.
  const moodRe = /\[\[\s*mood\s*[:：]\s*([a-z]+)\s*\]\]/gi;
  while ((match = moodRe.exec(pendingDirectiveBuffer)) !== null) {
    const thisMood = match[1];
    if (thisMood !== lastEmittedMood) {
      lastEmittedMood = thisMood;
      emit({ kind: "mood", mood: thisMood });
    }
  }

  // [[remember:…]] — write to MEMORY.md, works in any mode (no file tools needed).
  // Dedup per-turn so each unique text is written only once.
  const rememberRe = /\[\[\s*remember\s*[:：]\s*([^\]]+)\s*\]\]/gi;
  while ((match = rememberRe.exec(pendingDirectiveBuffer)) !== null) {
    const text = (match[1] || "").trim();
    if (text && !rememberedThisTurn.has(text)) {
      rememberedThisTurn.add(text);
      persona.appendMemoryEntry(text);
    }
  }

  // [[skill:NAME ARG]] — guarded on skillsEnabled + dedup per turn.
  if (settings.get("skillsEnabled") === false) return;
  const skillRe = /\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/gi;
  while ((match = skillRe.exec(pendingDirectiveBuffer)) !== null) {
    const tag = match[0];
    if (skillExecutedThisTurn.has(tag)) continue;
    skillExecutedThisTurn.add(tag);
    skills.runSkill(match[1], match[2] || "").then((result) => {
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

// Side-effect-free directive stripper for finalize — directives are already
// executed by checkDirectives() during streaming; this just cleans the text.
function cleanDirectives(text) {
  if (!text) return "";
  return String(text)
    .replace(/\[\[\s*mood\s*[:：]\s*[a-z]+\s*\]\]/gi, "")
    .replace(/\[\[\s*mood\s*[:：]\s*[a-z]+\s*\](?=[^\]])/gi, "")
    .replace(/\[\[\s*skill\s*[:：]\s*[a-z_]+(?:\s+[^\]]*?)?\s*\]\]/gi, "")
    .replace(/\[\[\s*silent\s*\]\]/gi, "")
    .replace(/\[\[\s*observe\s*[:：]\s*[^\]]*\s*\]\]/gi, "")
    .replace(/\[\[\s*remember\s*[:：]\s*[^\]]*\s*\]\]/gi, "")
    .replace(/\[?\[\s*(?:mood|skill|observe|remember|silent)\b[^\]]*$/i, "")
    .trim();
}

function finalizeAssistant() {
  // Strip directive tags from the final text (side-effect-free — directives
  // were already executed by checkDirectives during streaming).
  const clean = cleanDirectives(pendingAssistantText);
  const entry = history[history.length - 1];
  if (entry && entry.id === currentAssistantId) {
    // If the reply was only directives, show "(silent)" instead of leaking raw tags.
    entry.text = clean || "(silent)";
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

function codexThreadId(event) {
  // Priority matches chat.js codexSessionIdFromEvent:
  // session_id > sessionId > thread_id > threadId > conversation_id > conversationId > id
  return (
    event.session_id || event.sessionId ||
    event.thread_id || event.threadId ||
    event.conversation_id || event.conversationId ||
    event.id
  );
}

function handleCodexLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  // Capture session/thread ID for resume. Codex JSONL uses "thread.started"
  // with thread_id; also handle legacy "session" events.
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" || type === "session" || type.includes("session")) {
    const id = codexThreadId(event);
    if (id) {
      vscodeSessionIds.codex = id;
      saveConversation();
    }
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

  // The built-in "priestess" backend has no CLI file tools — it doesn't work
  // for vibe coding. Tell the user and fall back to companion-mode chat.
  if (provider === "priestess") {
    const errMsg = "内置普瑞赛斯后端不支持终端工具，Vibe Coding 暂只支持 Claude Code / Codex。";
    history.push({ id: nextId(), role: "system", text: errMsg, ts: Date.now() });
    emit({ kind: "status", status: "idle", error: errMsg });
    emit({ kind: "history", history: history.slice() });
    midTurn = false;
    return;
  }

  // Inject editor context into the user message so the CLI sees it
  const messageWithContext = buildContextAugmentedMessage(trimmed, context);

  pushUser(trimmed, context);  // store original text + context in history
  beginAssistant();

  const wsServer = require("./ws-server");
  const vscodeWs = wsServer.getVscodeWorkspace();
  const cwd = vscodeWs || settings.get("chatCwd") || "";

  const rawMode = settings.get("vibeCodingMode") || "companion";
  // VS Code extension never gets full agent — cap at advisor.
  const vibeCodingMode = rawMode === "agent" ? "advisor" : rawMode;
  if (rawMode === "agent") {
    history.push({ id: nextId(), role: "system", text: "VS Code 扩展不支持代理模式，已切换至顾问模式（只读工具）。", ts: Date.now() });
  }
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
  if (trimmed.length > 100_000) return { ok: false, reason: "too-long" };
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
