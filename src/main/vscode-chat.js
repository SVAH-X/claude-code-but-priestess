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
const { spawnCli, killProcessTree } = require("./cli-spawn");
const { normalizeCwd, buildCodexExecArgs, codexSessionIdFromEvent } = require("./chat-runtime");
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
let currentInvocation = null;
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
  // A restore mid-turn would swap the history array out from under the running
  // reply (finalizeAssistant looks its entry up by id there), so the answer
  // would be lost for good. The running turn keeps its history; the client
  // already gets the current one back.
  if (midTurn || currentProcess) return false;
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
  // Archive to shared memory so the doctor's words aren't lost (same append
  // + size prune as the popover).
  persona.appendConversationArchiveEntry({ role: "user", text, ts: entry.ts, provider: currentProvider });
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
  // The webview only applies chunks to a message it already has: publish the
  // placeholder before the first chunk (mirrors chat.js emitHistory()).
  emit({ kind: "history", history: history.slice() });
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
// Same per-turn cap as the popover (chat.js REMEMBER_MAX_PER_TURN).
const REMEMBER_MAX_PER_TURN = 3;

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
    if (text && rememberedThisTurn.size < REMEMBER_MAX_PER_TURN && !rememberedThisTurn.has(text)) {
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
    persona.appendConversationArchiveEntry({
      role: "assistant",
      text: clean,
      ts: Date.now(),
      provider: currentProvider || "unknown",
    });
    // Project notes: what this workspace's conversations were about.
    try {
      const ws = wsServer.getVscodeWorkspace();
      if (ws) {
        const userEntry = [...history].reverse().find((item) => item.role === "user");
        persona.appendProjectNote(ws, userEntry?.text || "", clean);
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

function handleCodexLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  // Capture session/thread ID for resume. Codex JSONL uses "thread.started"
  // with thread_id; also handle legacy "session" events.
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" || type === "session" || type.includes("session")) {
    const id = codexSessionIdFromEvent(event);
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

  const visibleText = codexVisibleText(event, type, itemType);
  if (visibleText) {
    appendAssistant(visibleText);
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

// The text of a Codex event that belongs in the visible reply: output
// (agent_message) deltas and completed agent messages. Reasoning summaries
// stream as their own items/deltas and are never part of the reply, so they
// are neither shown nor archived.
function codexVisibleText(event, type, itemType) {
  if (itemType === "reasoning" || type.includes("reasoning")) return "";
  const item = event.item || event.event?.item || null;
  const role = String(item?.role || event.role || "");
  const isAssistantItem =
    itemType === "agent_message" ||
    itemType === "assistant_message" ||
    itemType === "final_answer" ||
    (itemType === "message" && (!role || role === "assistant"));
  if (type.includes("delta") || type.includes("chunk")) {
    if (item && !isAssistantItem) return "";
    const delta = event.delta !== undefined ? event.delta : item?.delta;
    return typeof delta === "string" ? delta : "";
  }
  if (item) {
    // Items arrive as started/updated/completed; only the completed one
    // carries the final text, and taking it once keeps the reply from doubling.
    if (!isAssistantItem || !type.endsWith("completed")) return "";
    return typeof item.text === "string" ? item.text : "";
  }
  if (type.includes("message") || type.includes("answer") || type === "result" || role === "assistant") {
    const text = event.text !== undefined ? event.text : event.message;
    return typeof text === "string" ? text : "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Context augmentation — inject editor context into user message
// ---------------------------------------------------------------------------

// The selection commands put the selected code in the message itself; the
// context block would otherwise send it a second time, and the history entry
// would store it twice. Drop the selection from the context in that case.
function withoutInlinedSelection(context, text) {
  const selected = context?.selection?.text;
  if (typeof selected !== "string" || !selected.trim()) return context;
  if (!String(text || "").includes(selected.trim())) return context;
  const { selection, ...rest } = context;
  return rest;
}

// Bounded transcript of this bridge's own history for the first turn of a
// fresh CLI session (budget matches chat.js SHARED_TRANSCRIPT_MAX_CHARS).
const SHARED_TRANSCRIPT_MAX_CHARS = 9000;

function buildSharedTranscript(currentUserEntry) {
  const lines = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && chars < SHARED_TRANSCRIPT_MAX_CHARS; i--) {
    const m = history[i];
    if (m.id === currentUserEntry?.id) continue;
    if (m.role === "user" || m.role === "assistant") {
      const line = `${m.role === "user" ? "博士" : "普瑞赛斯"}: ${(m.text || "").slice(0, 200)}`;
      lines.unshift(line);
      chars += line.length + 1;
    }
  }
  return lines.join("\n");
}

// The blacklist pattern covering `filePath` (relative to the VS Code workspace),
// or null. Guards what reaches the model without the Doctor asking for it.
function blacklistPatternFor(filePath, root) {
  const { parseBlacklist, matchBlacklist } = require("./file-blacklist");
  const patterns = parseBlacklist(settings.get("advisorFileBlacklist"));
  if (!patterns.length || !filePath) return null;
  return matchBlacklist(String(filePath), patterns, { root: root || "" });
}

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
  // Automatic editor context from a blacklisted file (name, cursor, selection)
  // is dropped, and the Doctor is told so. Text he explicitly sends (the
  // selection commands put it in the message itself) is his own choice and
  // passes untouched. Matching is relative to the VS Code workspace, the same
  // root the CLI runs in below.
  context = withoutInlinedSelection(context, trimmed);
  const blacklistHit = context?.activeFile
    ? blacklistPatternFor(context.activeFile, require("./ws-server").getVscodeWorkspace() || settings.get("chatCwd") || "")
    : null;
  const filteredContext = blacklistHit ? null : context;
  const messageWithContext = buildContextAugmentedMessage(trimmed, filteredContext);

  const currentUserEntry = userAlreadyShown
    ? latestMatchingUser(trimmed)
    : pushUser(trimmed, context);
  if (blacklistHit && !userAlreadyShown) {
    const name = String(context.activeFile).split(/[\\/]/).pop();
    history.push({
      id: nextId(),
      role: "system",
      text: `当前文件 ${name} 命中文件黑名单（${blacklistHit}），本轮没有自动附带它的编辑器上下文（文件名、光标、选区）。`,
      ts: Date.now()
    });
  }

  // A resumed CLI session already holds everything it was told; replaying
  // the transcript every turn only costs ~9k chars of prompt. It goes out on
  // the first turn of a session only (a stale-session retry clears the id and
  // sends it again), like the popover path does.
  const resumeId = vscodeSessionIds[provider];
  const resuming = typeof resumeId === "string" && Boolean(resumeId.trim());
  const sharedTranscript = resuming ? "" : buildSharedTranscript(currentUserEntry);

  const rawMode = settings.get("vibeCodingMode") || "companion";
  // VS Code extension never gets full agent — cap at advisor.
  const vibeCodingMode = rawMode === "agent" ? "advisor" : rawMode;
  // Keep the downgrade visible in history before the assistant reply starts.
  if (rawMode === "agent") {
    history.push({ id: nextId(), role: "system", text: "VS Code 扩展不支持代理模式，已切换至顾问模式（只读工具）。", ts: Date.now() });
  }

  const wsServer = require("./ws-server");
  const vscodeWs = wsServer.getVscodeWorkspace();
  const cwd = normalizeCwd(vscodeWs || settings.get("chatCwd"));
  // Built before the assistant placeholder so a validator notice (model /
  // effort fallback) lands in this history ahead of the reply. The popover's
  // attachments, cat mode and silent-turn state are never part of a VS Code
  // turn: this bridge hands over its own (empty) inputs explicitly.
  const invocation = chat.buildProviderInvocation(provider, messageWithContext, cwd, vibeCodingMode, null, sharedTranscript, null, vscodeSessionIds, {
    vscodeTurn: true,
    workspacePath: vscodeWs || "",
    attachments: [],
    catMode: null,
    silent: false,
    onNotice: pushSystem
  });

  if (!invocation) {
    const errMsg = "No CLI provider available";
    history.push({ id: nextId(), role: "system", text: errMsg, ts: Date.now() });
    emit({ kind: "status", status: "idle", error: errMsg });
    emit({ kind: "history", history: history.slice() });
    midTurn = false;
    return;
  }

  beginAssistant();

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
    chat.cleanupInvocation(invocation);
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
  currentInvocation = invocation;

  if (invocation.stdin) {
    // Same as chat.js: a CLI that exits before draining stdin turns the rest of
    // this write into an async EPIPE, and an unhandled stream error would kill
    // the main process instead of just failing the turn.
    proc.stdin.on("error", () => {});
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
    currentInvocation = null;
    midTurn = false;
    // Every exit path below (the retries included) starts here: the temp dir
    // holding the persona system prompt must not outlive the turn.
    chat.cleanupInvocation(invocation);

    // Self-heal: drop stale session on "not found" errors and retry once.
    // Covers Claude ("No conversation found"), Codex ("no rollout found",
    // "thread ... not found"), and provider-level structured error text
    // captured during streaming. errorText also feeds the Codex fallbacks below.
    const errorText = `${stderr}\n${providerErrorText}`;
    const sessionLost = /no conversation found|no rollout found|(?:session|thread|conversation|rollout).*not found|invalid.*(?:session|thread|conversation)/i.test(errorText);
    if (sessionLost && !staleRetryInFlight) {
      staleRetryInFlight = true;
      vscodeSessionIds[provider] = null;
      if (currentAssistantId) discardAssistant();
      saveConversation();
      // Retry with a fresh session. staleRetryInFlight stays true until the
      // retry succeeds — prevents loops if the fresh session also fails.
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
    currentInvocation = null;
    midTurn = false;
    chat.cleanupInvocation(invocation);
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

// `sync` is for the quit/restart paths (see chat.cancel): the Windows taskkill
// must finish before app.exit().
function cancel({ sync = false } = {}) {
  directiveTurnToken += 1;
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  // Clear / New Conversation call this while idle too; then there is nothing
  // to report — a "cancelled" status would just flash in the webview.
  const wasBusy = Boolean(currentProcess || midTurn || outboundQueue.length || currentAssistantId);
  if (currentProcess) {
    const proc = currentProcess;
    currentProcess = null;
    // The close handler ignores the dead process (identity guard above), so
    // this is the only place that ends the turn and releases its temp dir
    // (the CLI read the prompt file at startup). Whole tree: a .cmd shim's
    // cmd.exe would otherwise leave the real CLI streaming as an orphan.
    chat.cleanupInvocation(currentInvocation);
    currentInvocation = null;
    killProcessTree(proc, { sync });
  }
  outboundQueue.length = 0;
  midTurn = false;
  if (currentAssistantId) {
    if (pendingAssistantText) finalizeAssistant();
    else discardAssistant();
  }
  if (!wasBusy) return;
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
//
// The VS Code extension only asks when the Doctor opted in
// (prts.inlineCompletion.enabled); the gates below are the backend's own floor
// because any authenticated bridge client can send chat:inline-complete.
const COMPLETION_TIMEOUT_MS = 10000;
// The extension sends ~6 lines before the cursor; one minified line can still
// be huge, so keep only the tail that matters for the completion.
const COMPLETION_MAX_PREFIX_CHARS = 4000;

let completionInFlight = false;

// Companion mode is chat-only: editor contents are never sent to a model
// unasked. Advisor and agent both allow completion; the completion process
// itself never gets tools in either (see the Claude args below).
function completionAllowedByMode() {
  const mode = String(settings.get("vibeCodingMode") || "companion");
  return mode === "advisor" || mode === "agent";
}

// Never send sensitive or blacklisted files to the model. Checks both the full
// path (for directory patterns) and the bare file name the prompt shows.
// Matching is relative to the VS Code workspace, the same root dispatchSend()
// uses; a file outside it is judged by its name only (see file-blacklist.js).
function completionFileBlocked(file, filePath) {
  const { parseBlacklist, isBlacklisted, SENSITIVE_FILE_PATTERNS } = require("./file-blacklist");
  const patterns = [...SENSITIVE_FILE_PATTERNS, ...parseBlacklist(settings.get("advisorFileBlacklist"))];
  let root = "";
  try { root = require("./ws-server").getVscodeWorkspace() || ""; } catch (_) { /* bridge not loaded */ }
  if (!root) root = settings.get("chatCwd") || "";
  return [filePath, file].some((p) => typeof p === "string" && p && isBlacklisted(p, patterns, { root }));
}

async function complete(prefix, file, language, filePath) {
  if (typeof prefix !== "string" || !prefix.trim()) return null;

  // Reject completion while a chat turn is streaming - the CLI is busy and
  // spawning a second process would only pile up load.
  if (midTurn) return null;

  // Reject completion while another completion is already running. Every
  // completion request spawns a fresh CLI subprocess, and the VS Code inline
  // provider fires after every ~300ms pause while the user types. Without
  // this guard a short burst of typing could fork several CLI processes at
  // once. Dropping the redundant ones keeps the system cheap; the next pause
  // triggers a fresh completion.
  if (completionInFlight) return null;

  if (!completionAllowedByMode()) return null;
  if (completionFileBlocked(file, filePath)) return null;

  const availability = chat.getProviderAvailability({ refresh: false });
  const provider = availability.activeProvider;
  if (!provider || provider === "priestess") return null;
  const info = availability.providers[provider];
  if (!info?.available || !info.command) return null;

  // The prompt always goes through stdin, never argv: on Windows a .cmd shim
  // runs through `cmd /d /s /c`, which drops everything after the first
  // newline of the command line and expands %VAR% even inside quotes.
  const prompt =
    `Complete this code. Only output the completion text, no markdown, no explanation.\n` +
    `File: ${file || "unknown"} (${language || ""})\n\n` +
    prefix.slice(-COMPLETION_MAX_PREFIX_CHARS);

  let args;
  let effectiveCwd = settings.get("chatCwd") || "";
  if (provider === "codex") {
    // `codex exec` has no `-p` prompt flag: -p is `--profile`. Match the main
    // chat path (buildCodexExecArgs): prompt on stdin (`-`) with the read-only
    // sandbox, the advisor-level cap (codex has no switch that removes its
    // tools entirely). --json is dropped: complete() parses plain text.
    const built = buildCodexExecArgs({ cwd: effectiveCwd, mode: "companion", memoryDir: persona.memoryDir() });
    args = built.args.filter((a) => a !== "--json");
    effectiveCwd = built.cwd;
  } else {
    args = [
      "-p",
      "--output-format",
      "text",
      // A completion never needs tools: remove the built-in set, skip the
      // Doctor's MCP servers, and pin the permission mode so a
      // `defaultMode: "bypassPermissions"` in ~/.claude/settings.json cannot
      // apply to this extension-triggered process.
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "default",
      // One-shot request: do not leave a saved session on disk per pause.
      "--no-session-persistence"
    ];
    const claudeModel = String(settings.get("claudeModel") || "").trim();
    if (claudeModel) args.push("--model", claudeModel);
  }

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

    let proc;
    try {
      proc = spawnCli(info.command, args, {
        cwd: effectiveCwd || undefined,
        env: { ...process.env },
        // Completion fires on every typing pause; never flash a console window.
        windowsHide: true
      });
    } catch (_) {
      finish(null);
      return;
    }

    // A CLI that exits before draining stdin turns the write into an async
    // EPIPE; without a listener that stream error would crash the main process.
    proc.stdin.on("error", () => {});
    try { proc.stdin.end(prompt); } catch (_) { /* process already exited */ }
    // Drain stderr so a chatty CLI cannot block on a full pipe.
    proc.stderr?.resume();

    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
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
