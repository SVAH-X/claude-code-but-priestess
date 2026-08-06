// Independent chat session for the VS Code extension.
//
// Maintains its own conversation history and CLI subprocess so VS Code
// chats are completely isolated from the Electron popover.  Directives
// ([[mood:X]], [[skill:X ARG]]) and stream parsing are handled here.
// Long-term memory (MEMORY.md, archive, summary) is still shared — both
// conversation surfaces feed the same persona memory files.
//
// Reuses chat.js for provider CLI invocation building, persona.js for prompt
// construction, cli-spawn.js for subprocess spawning, and skills.js for skill
// execution.

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { app } = require("electron");

const chat = require("./chat");
const persona = require("./persona");
const settings = require("./settings");
const skills = require("./skills");
const { spawnCli } = require("./cli-spawn");
const { normalizeCwd, buildCodexExecArgs } = require("./chat-runtime");
const { cleanDirectiveText, consumeDirectiveChunk } = require("./directive-stream");
const {
  classifyCodexRejection,
  codexEventErrorText,
  isCodexModelMetadataWarning
} = require("./codex-errors");

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
let staleRetryInFlight = false;
let codexModelFallbackInFlight = false;
let codexReasoningFallbackInFlight = false;
let providerErrorText = "";

// Per-turn streaming state
let pendingAssistantText = "";
let currentAssistantId = null;
let currentToolName = null;
let directiveStreamState = { tail: "" };
let directiveTurnToken = 0;

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
    const line = JSON.stringify({ role: "user", text, ts: Date.now(), provider: currentProvider });
    fs.appendFileSync(persona.conversationArchivePath(), line + "\n", "utf8");
  } catch (_) { /* best effort */ }
  return entry;
}

function pushSystem(text) {
  history.push({ id: nextId(), role: "system", text, ts: Date.now() });
  emit({ kind: "history", history: history.slice() });
  saveConversation();
}

function beginAssistant() {
  currentAssistantId = nextId();
  pendingAssistantText = "";
  providerErrorText = "";
  directiveStreamState = { tail: "" };
  directiveTurnToken += 1;
  skillExecutedThisTurn.clear();
  rememberedThisTurn.clear();
  lastEmittedMood = null;
  currentToolName = null;
  history.push({
    id: currentAssistantId,
    role: "assistant",
    text: "",
    ts: Date.now(),
  });
}

function appendAssistant(raw) {
  pendingAssistantText += raw;
  const visible = consumeDirectiveChunk(
    directiveStreamState,
    raw,
    handleVscodeDirective
  );
  if (visible) {
    const entry = history.find((item) => item.id === currentAssistantId);
    if (entry && entry.id === currentAssistantId) {
      entry.text += visible;
    }
    emit({ kind: "chunk", messageId: currentAssistantId, text: visible });
  }
}

const skillExecutedThisTurn = new Set();
let lastEmittedMood = null;
const rememberedThisTurn = new Set();

// Simple mood aliases matching chat.js normalizeMood behaviour.
function normalizeMood(raw) {
  const m = String(raw || "").toLowerCase().trim();
  if (m === "happy") return "smile";
  if (m === "threaten") return "threat";
  if (m === "cry") return "sad";
  return m;
}

function handleVscodeDirective(directive) {
  if (directive.type === "mood") {
    const mood = normalizeMood(directive.value);
    if (mood && mood !== lastEmittedMood) {
      lastEmittedMood = mood;
      emit({ kind: "mood", mood });
    }
    return;
  }

  if (directive.type === "remember") {
    const text = String(directive.value || "").trim();
    if (text && !rememberedThisTurn.has(text)) {
      rememberedThisTurn.add(text);
      persona.appendMemoryEntry(text);
    }
    return;
  }

  if (directive.type !== "skill" || settings.get("skillsEnabled") === false) return;
  const key = String(directive.raw || "").trim();
  if (skillExecutedThisTurn.has(key)) return;
  skillExecutedThisTurn.add(key);
  const turnToken = directiveTurnToken;
  skills.runSkill(directive.name, directive.arg || "").then((result) => {
    // A completed reply may still receive its skill receipt; a new/cancelled
    // turn invalidates the token so stale actions cannot mutate newer history.
    if (!result.receipt || turnToken !== directiveTurnToken) return;
    history.push({
      id: nextId(),
      role: "tool",
      summary: result.receipt,
      ts: Date.now(),
    });
    emit({ kind: "history", history: history.slice() });
    saveConversation();
  }).catch((error) => {
    console.warn("vscode-chat: skill failed", error);
  });
}

function finalizeAssistant() {
  // Strip directive tags from the final text (side-effect-free — directives
  // were already executed while the stream was consumed).
  const clean = cleanDirectiveText(pendingAssistantText);
  const entry = history.find((item) => item.id === currentAssistantId);
  if (entry && entry.id === currentAssistantId) {
    // If the reply was only directives, show "(silent)" instead of leaking raw tags.
    entry.text = clean || "(silent)";
  }
  emit({ kind: "history", history: history.slice() });
  saveConversation();

  // Archive to shared memory
  if (clean) {
    try {
      persona.ensureConversationArchiveFile();
      const line = JSON.stringify({
        role: "assistant",
        text: clean,
        ts: Date.now(),
        provider: currentProvider || "unknown",
      });
      fs.appendFileSync(persona.conversationArchivePath(), line + "\n", "utf8");
    } catch (_) { /* best effort */ }
    // Auto-record project notes for workspace continuity across conversations.
    try {
      const wsServer = require("./ws-server");
      const ws = wsServer.getVscodeWorkspace();
      if (ws && clean) {
        const userEntry = [...history].reverse().find((m) => m.role === "user");
        persona.appendProjectNote(ws, userEntry?.text || "", clean.slice(0, 300));
      }
    } catch (_) { /* best effort */ }
  }

  pendingAssistantText = "";
  directiveStreamState = { tail: "" };
  currentAssistantId = null;
}

function discardAssistant() {
  const index = history.findIndex((item) => item.id === currentAssistantId);
  if (index !== -1) history.splice(index, 1);
  pendingAssistantText = "";
  directiveStreamState = { tail: "" };
  currentAssistantId = null;
  emit({ kind: "history", history: history.slice() });
  saveConversation();
}

function latestMatchingUser(text) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === "user" && entry.text === text) return entry;
  }
  return null;
}

function drainOutboundQueue() {
  while (outboundQueue.length > 0) {
    const next = outboundQueue.shift();
    if (!next?.text) continue;
    // This is a distinct user turn, not the internal retry of the previous
    // one, so it gets its own single stale-session recovery attempt.
    staleRetryInFlight = false;
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    dispatchSend(next.text, next.context || null);
    return;
  }
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
    if (event.is_error) {
      providerErrorText = typeof event.result === "string"
        ? event.result
        : String(event.error || event.subtype || "Claude returned an error");
      if (!pendingAssistantText) return;
    }
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

  const eventErrorText = codexEventErrorText(event);
  const itemType = String(event.item?.type || event.event?.item?.type || "");
  const isErrorEvent =
    Boolean(eventErrorText) ||
    type.includes("error") ||
    type.endsWith(".failed") ||
    itemType.includes("error");
  if (isErrorEvent) {
    const errorText =
      eventErrorText ||
      (typeof event.message === "string" ? event.message : "") ||
      (typeof event.error === "string" ? event.error : "") ||
      JSON.stringify(event);
    if (
      !isCodexModelMetadataWarning(errorText) ||
      classifyCodexRejection(errorText)
    ) {
      providerErrorText = providerErrorText
        ? `${providerErrorText}\n${errorText}`.slice(-4000)
        : String(errorText).slice(0, 4000);
    }
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
    const MAX_SELECTION = 30_000;
    let selText = s.text;
    if (selText.length > MAX_SELECTION) {
      selText = selText.slice(0, MAX_SELECTION) +
        `\n…(已截断，完整选区共 ${selText.length} 字符)`;
    }
    lines.push(`\n博士选中的代码 (${s.startLine}-${s.endLine}行):`);
    lines.push("```" + lang);
    lines.push(selText);
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

function dispatchSend(trimmed, context, { userAlreadyShown = false } = {}) {
  if (currentProcess) return; // re-entry guard — don't touch midTurn, it belongs to the running turn
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
    // Clear queued messages — they can't be processed on this backend.
    if (outboundQueue.length > 0) {
      outboundQueue.length = 0;
      emit({ kind: "queue", length: 0 });
    }
    return;
  }

  // Inject editor context into the user message so the CLI sees it.
  // Filter out blacklisted files: if the active file matches the blacklist,
  // strip all context so she doesn't even know the file exists.
  const { parseBlacklist, isBlacklisted } = require("./file-blacklist");
  const blPatterns = parseBlacklist(settings.get("advisorFileBlacklist"));
  const filteredContext = (blPatterns.length && context?.activeFile && isBlacklisted(context.activeFile, blPatterns))
    ? null
    : context;
  const messageWithContext = buildContextAugmentedMessage(trimmed, filteredContext);

  const currentUserEntry = userAlreadyShown
    ? latestMatchingUser(trimmed)
    : pushUser(trimmed, context);

  // Build a shared transcript from our own history for context continuity.
  const SHARED_MAX = 9000; // matches chat.js SHARED_TRANSCRIPT_MAX_CHARS
  const sharedLines = [];
  let sharedChars = 0;
  for (let i = history.length - 1; i >= 0 && sharedChars < SHARED_MAX; i--) {
    const m = history[i];
    if (m.id === currentUserEntry?.id) continue;
    if (m.role === "user" || m.role === "assistant") {
      const line = `${m.role === "user" ? "博士" : "普瑞赛斯"}: ${(m.text || "").slice(0, 200)}`;
      sharedLines.unshift(line);
      sharedChars += line.length + 1;
    }
  }
  const sharedTranscript = sharedLines.join("\n");

  const rawMode = settings.get("vibeCodingMode") || "companion";
  // VS Code extension never gets full agent — cap at advisor.
  const vibeCodingMode = rawMode === "agent" ? "advisor" : rawMode;
  // Keep the downgrade visible in history before the assistant reply starts.
  if (rawMode === "agent") {
    history.push({ id: nextId(), role: "system", text: "VS Code 扩展不支持代理模式，已切换至顾问模式（只读工具）。", ts: Date.now() });
  }

  beginAssistant();

  const wsServer = require("./ws-server");
  const vscodeWs = wsServer.getVscodeWorkspace();
  const cwd = normalizeCwd(vscodeWs || settings.get("chatCwd"));
  const invocation = chat.buildProviderInvocation(provider, messageWithContext, cwd, vibeCodingMode, null, sharedTranscript, null, vscodeSessionIds);

  if (!invocation) {
    const errMsg = "No CLI provider available";
    history.push({ id: nextId(), role: "system", text: errMsg, ts: Date.now() });
    emit({ kind: "status", status: "idle", error: errMsg });
    midTurn = false;
    discardAssistant();
    return;
  }

  emit({
    kind: "status",
    status: "running",
    provider,
    sessionId: vscodeSessionIds[provider] || null,
  });

  let proc;
  try {
    proc = spawnCli(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env },
    });
  } catch (error) {
    midTurn = false;
    discardAssistant();
    emit({
      kind: "status",
      status: "idle",
      error: error.message,
      provider,
    });
    drainOutboundQueue();
    return;
  }
  currentProcess = proc;

  if (invocation.stdin) {
    proc.stdin.write(invocation.stdin);
    proc.stdin.end();
  }

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (currentProcess !== proc) return;
    if (provider === "claude" || provider === "priestess") {
      handleClaudeLine(line);
    } else if (provider === "codex") {
      handleCodexLine(line);
    }
  });

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    if (currentProcess !== proc) return;
    currentProcess = null;
    midTurn = false;

    // Self-heal: drop stale session on "not found" errors and retry once.
    // Covers Claude ("No conversation found"), Codex ("no rollout found"),
    // and provider-level structured error text captured during streaming.
    const sessionLost = /no conversation found|session.*not found|no rollout found|invalid.*session/i.test(stderr)
      || (providerErrorText && /no conversation found|no rollout found/i.test(providerErrorText));
    if (sessionLost && !staleRetryInFlight) {
      staleRetryInFlight = true;
      vscodeSessionIds[provider] = null;
      if (currentAssistantId) discardAssistant();
      saveConversation();
      dispatchSend(trimmed, context, { userAlreadyShown: true });
      return;
    }

    const codexRejection =
      provider === "codex" ? classifyCodexRejection(errorText) : "";
    const badCodexReasoning = String(settings.get("codexReasoningEffort") || "").trim();
    if (
      provider === "codex" &&
      !codexReasoningFallbackInFlight &&
      codexRejection === "reasoning" &&
      badCodexReasoning
    ) {
      settings.set({ codexReasoningEffort: "" });
      vscodeSessionIds.codex = null;
      codexReasoningFallbackInFlight = true;
      if (currentAssistantId) discardAssistant();
      pushSystem(`Codex 推理强度 \`${badCodexReasoning}\` 不可用，已恢复默认并重试。`);
      dispatchSend(trimmed, context, { userAlreadyShown: true });
      return;
    }

    const badCodexModel = String(settings.get("codexModel") || "").trim();
    if (
      provider === "codex" &&
      !codexModelFallbackInFlight &&
      codexRejection === "model" &&
      badCodexModel
    ) {
      settings.set({ codexModel: "" });
      vscodeSessionIds.codex = null;
      codexModelFallbackInFlight = true;
      if (currentAssistantId) discardAssistant();
      pushSystem(`Codex 模型 \`${badCodexModel}\` 不可用，已恢复默认并重试。`);
      dispatchSend(trimmed, context, { userAlreadyShown: true });
      return;
    }

    if (currentAssistantId) {
      if (pendingAssistantText || (code === 0 && !providerErrorText)) finalizeAssistant();
      else discardAssistant();
    }

    if ((code !== 0 && code !== null) || providerErrorText) {
      emit({
        kind: "status",
        status: "idle",
        error: providerErrorText || "CLI exited with code " + code,
        provider,
      });
    } else {
      staleRetryInFlight = false;
      emit({ kind: "status", status: "idle", provider });
    }

    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    drainOutboundQueue();
  });

  proc.on("error", (err) => {
    if (currentProcess !== proc) return;
    currentProcess = null;
    midTurn = false;
    staleRetryInFlight = false;
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    if (currentAssistantId) {
      if (pendingAssistantText) finalizeAssistant();
      else discardAssistant();
    }
    emit({
      kind: "status",
      status: "idle",
      error: err.message,
      provider,
    });
    // Some spawn failures emit error before close; the identity guard makes
    // the later close callback harmless.
    drainOutboundQueue();
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
  staleRetryInFlight = false; // new user message — clear self-heal guard
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  dispatchSend(trimmed, context || null);
  return { ok: true };
}

function cancel() {
  directiveTurnToken += 1;
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  if (currentProcess) {
    const proc = currentProcess;
    currentProcess = null;
    try { proc.kill("SIGTERM"); } catch (_) { /* ignore */ }
    // Force-kill after 3s if SIGTERM was ignored (matches chat.js pattern).
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) { /* ignore */ }
    }, 3000).unref();
  }
  outboundQueue.length = 0;
  midTurn = false;
  if (currentAssistantId) {
    if (pendingAssistantText) finalizeAssistant();
    else discardAssistant();
  }
  emit({ kind: "tool", active: false });
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
  saveConversation();
}

function getSessionId() {
  const provider = chat.getProviderAvailability().activeProvider;
  return provider ? vscodeSessionIds[provider] || null : null;
}

// Called on VS Code connect / disconnect
function init() {
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
    const data = JSON.parse(fs.readFileSync(conversationPath(), "utf8"));
    return Array.isArray(data?.history) && data.history.some((entry) =>
      entry && (entry.role === "user" || entry.role === "assistant") && entry.text
    );
  } catch {
    return false;
  }
}

// Lightweight inline completion — spawns a one-shot CLI subprocess per request.
// Uses chat.getProviderAvailability() for resolved paths and cli-spawn.js for
// cross-platform spawning. Does NOT touch history, archive, or any shared turn state.
const COMPLETION_TIMEOUT_MS = 10000;

﻿let completionInFlight = false;

async function complete(prefix, file, language) {
  // Reject completion while a chat turn is streaming - the CLI is busy and
  // spawning a second process would only pile up load.
  if (midTurn) return null;

  // Reject completion while another completion is already running. Every
  // completion request spawns a fresh CLI subprocess (Codex `exec` with the
  // prompt on stdin / Claude `-p`), and the VS Code inline provider fires
  // after every ~300ms
  // pause while the user types. Without this guard a short burst of typing
  // could fork several CLI processes at once. Dropping the redundant ones
  // keeps the system cheap; the next pause triggers a fresh completion.
  if (completionInFlight) return null;

  const availability = chat.getProviderAvailability({ refresh: false });
  const provider = availability.activeProvider;
  if (!provider || provider === "priestess") return null;
  const info = availability.providers[provider];
  if (!info?.available || !info.command) return null;

  const prompt =
    `Complete this code. Only output the completion text, no markdown, no explanation.\n` +
    `File: ${file || "unknown"} (${language || ""})\n\n` +
    prefix;

  completionInFlight = true;
  return new Promise((resolve) => {
    let settled = false;
    // Every exit path must go through finish() so completionInFlight is
    // released exactly once - a double release would let a second process
    // start while the first is still running, defeating the guard above.
    const finish = (value) => {
      if (settled) return;
      settled = true;
      completionInFlight = false;
      resolve(value);
    };

    let args;
    let effectiveCwd = settings.get("chatCwd") || "";
    let stdinPrompt = null;
    if (provider === "codex") {
      // `codex exec` has no `-p` prompt flag: -p is `--profile`, so the old
      // `["exec", "-p", prompt, "--json"]` made codex treat the prompt as a
      // profile name, error out, and produce empty stdout - completions were
      // always null. Match the main chat path (buildCodexExecArgs): prompt is
      // fed through stdin (`-`) with a read-only sandbox. --json is dropped:
      // complete() parses plain text (markdown-stripped), not the event stream.
      const built = buildCodexExecArgs({ cwd: effectiveCwd, mode: "companion", memoryDir: persona.memoryDir() });
      args = built.args.filter((a) => a !== "--json");
      effectiveCwd = built.cwd;
      stdinPrompt = prompt;
    } else {
      // Claude: -p for single-turn, --output-format text (no --max-tokens flag exists)
      args = ["-p", prompt, "--output-format", "text"];
      const claudeModel = String(settings.get("claudeModel") || "").trim();
      if (claudeModel) args.push("--model", claudeModel);
    }

    const proc = spawnCli(info.command, args, {
      cwd: effectiveCwd || undefined,
      env: { ...process.env },
    });
    if (stdinPrompt != null) {
      try { proc.stdin.end(stdinPrompt); } catch (_) { /* process already exited */ }
    }

    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch (_) {}
      finish(null);
    }, COMPLETION_TIMEOUT_MS);
    timer.unref();

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.on("close", () => {
      clearTimeout(timer);
      if (timedOut) return; // finish() already ran via the timeout path
      const text = (stdout || "").trim();
      const cleaned = text
        .replace(/^```[\w]*\n?/i, "")
        .replace(/\n?```$/i, "")
        .trim();
      if (cleaned && cleaned.length < 2000 && !/^(I|here|sure|certainly|this is)/i.test(cleaned)) {
        finish(cleaned);
      } else {
        finish(null);
      }
    });
    proc.on("error", () => { clearTimeout(timer); finish(null); });
  });
}

module.exports = {
  send,
  complete,
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
