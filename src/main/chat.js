// ============================================================
//  Chat — drives the selected local coding CLI as a subprocess.
//  Claude Code and Codex keep separate session ids, while persona,
//  memory, working directory, and renderer state stay shared.
// ============================================================
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settings = require("./settings");
const persona = require("./persona");

const PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  CODEX: "codex"
});
const SHARED_TRANSCRIPT_MAX_CHARS = 9000;
const RECENT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const SUMMARY_MAX_CHARS = 14000;
const SUMMARY_MESSAGE_MAX_CHARS = 720;
const ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;
const ARCHIVE_TARGET_BYTES = 4 * 1024 * 1024;

const subscribers = new Set();
const history = []; // { id, role: 'user' | 'assistant' | 'system' | 'tool', text, ts }

let currentProcess = null;
let pendingAssistantId = null;
let pendingAssistantText = "";
let sessionIds = { [PROVIDERS.CLAUDE]: null, [PROVIDERS.CODEX]: null };
let turnStartedAt = 0;
let currentProvider = null;
let longMemoryDormant = true;
let providerAvailability = null;

function normalizeProvider(provider) {
  return provider === PROVIDERS.CODEX ? PROVIDERS.CODEX : PROVIDERS.CLAUDE;
}

function activeProvider() {
  return selectAvailableProvider(settings.get("chatProvider")) ||
    normalizeProvider(settings.get("chatProvider"));
}

function providerLabel(provider = activeProvider()) {
  return provider === PROVIDERS.CODEX ? "Codex" : "Claude Code";
}

function providerShortLabel(provider = activeProvider()) {
  return provider === PROVIDERS.CODEX ? "Codex" : "Claude";
}

function executableNames(command) {
  if (process.platform !== "win32") return [command];
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command];
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function pathEnvDirs() {
  return unique(String(process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function commonBinDirs() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return unique([
      process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      path.join(home, ".local", "bin"),
      path.join(home, ".codex", "bin"),
      path.join(home, ".claude", "local")
    ]);
  }
  return unique([
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".codex", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ]);
}

function platformCodexBinDirs() {
  if (process.platform === "darwin") return ["macos-aarch64", "macos-x64"];
  if (process.platform === "win32") return ["windows-x64", "windows-arm64"];
  return ["linux-x64", "linux-arm64"];
}

function discoverCodexCandidates() {
  const roots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".cursor", "extensions")
  ];
  const candidates = [];
  const names = executableNames("codex");
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        if (!entry.startsWith("openai.chatgpt-")) continue;
        for (const binDir of platformCodexBinDirs()) {
          for (const name of names) {
            candidates.push(path.join(root, entry, "bin", binDir, name));
          }
        }
      }
    } catch {
      /* ignore missing editor extension directories */
    }
  }
  return candidates;
}

function executableCandidates(command) {
  const names = executableNames(command);
  const binCandidates = commonBinDirs().flatMap((dir) => names.map((name) => path.join(dir, name)));
  const pathCandidates = pathEnvDirs().flatMap((dir) => names.map((name) => path.join(dir, name)));
  const providerCandidates = command === PROVIDERS.CODEX
    ? discoverCodexCandidates()
    : [
        ...names.map((name) => path.join(os.homedir(), ".claude", "local", name)),
        ...names.map((name) => path.join(os.homedir(), ".local", "bin", name))
      ];
  return unique([...providerCandidates, ...binCandidates, ...pathCandidates]);
}

function canAccessExecutable(candidate) {
  try {
    fs.accessSync(
      candidate,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
}

function canSpawnExecutable(candidate) {
  try {
    const probe = spawnSync(candidate, ["--version"], {
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(candidate),
      stdio: "ignore",
      timeout: 1800
    });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

function detectProvider(provider) {
  const normalized = normalizeProvider(provider);
  for (const candidate of executableCandidates(normalized)) {
    try {
      if (canAccessExecutable(candidate) && canSpawnExecutable(candidate)) {
        return {
          provider: normalized,
          label: providerLabel(normalized),
          shortLabel: providerShortLabel(normalized),
          available: true,
          command: candidate
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return {
    provider: normalized,
    label: providerLabel(normalized),
    shortLabel: providerShortLabel(normalized),
    available: false,
    command: null
  };
}

function scanProviderAvailability() {
  return {
    [PROVIDERS.CLAUDE]: detectProvider(PROVIDERS.CLAUDE),
    [PROVIDERS.CODEX]: detectProvider(PROVIDERS.CODEX)
  };
}

function ensureProviderAvailability() {
  if (!providerAvailability) {
    providerAvailability = scanProviderAvailability();
  }
  return providerAvailability;
}

function emptyProviderAvailability() {
  return {
    [PROVIDERS.CLAUDE]: {
      provider: PROVIDERS.CLAUDE,
      label: providerLabel(PROVIDERS.CLAUDE),
      shortLabel: providerShortLabel(PROVIDERS.CLAUDE),
      available: false,
      command: null
    },
    [PROVIDERS.CODEX]: {
      provider: PROVIDERS.CODEX,
      label: providerLabel(PROVIDERS.CODEX),
      shortLabel: providerShortLabel(PROVIDERS.CODEX),
      available: false,
      command: null
    }
  };
}

function selectAvailableProvider(requested, availability = ensureProviderAvailability()) {
  const normalized = normalizeProvider(requested);
  if (availability[normalized]?.available) return normalized;
  if (availability[PROVIDERS.CLAUDE]?.available) return PROVIDERS.CLAUDE;
  if (availability[PROVIDERS.CODEX]?.available) return PROVIDERS.CODEX;
  return null;
}

function refreshProviderAvailability() {
  providerAvailability = scanProviderAvailability();
  const selected = selectAvailableProvider(settings.get("chatProvider"), providerAvailability);
  if (selected && settings.get("chatProvider") !== selected) {
    settings.set({ chatProvider: selected });
  }
  return getProviderAvailability();
}

function getProviderAvailability(options = {}) {
  const availability = options.refresh === false
    ? providerAvailability || emptyProviderAvailability()
    : ensureProviderAvailability();
  const availableProviders = [PROVIDERS.CLAUDE, PROVIDERS.CODEX]
    .filter((provider) => availability[provider]?.available);
  const active = selectAvailableProvider(settings.get("chatProvider"), availability);
  return {
    activeProvider: active,
    availableProviders,
    providers: {
      [PROVIDERS.CLAUDE]: { ...availability[PROVIDERS.CLAUDE] },
      [PROVIDERS.CODEX]: { ...availability[PROVIDERS.CODEX] }
    }
  };
}

function resolveExecutable(command) {
  const normalized = normalizeProvider(command);
  return ensureProviderAvailability()[normalized]?.command || command;
}

function notify(event) {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (error) {
      console.warn("chat subscriber threw", error);
    }
  }
}

function getHistory() {
  return history.slice();
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emitHistory() {
  notify({ kind: "history", history: getHistory() });
}

function emitStatus(status, extra = {}) {
  notify({ kind: "status", status, ...extra });
}

function emitChunk(messageId, text) {
  notify({ kind: "chunk", messageId, text });
}

function emitTool(active, name, summary) {
  notify({
    kind: "tool",
    active: Boolean(active),
    name: name || null,
    summary: summary || null
  });
}

// One-line summary for transcript ("PRTS · Bash · screencapture …").
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return null;
  if (name === "Bash" && typeof input.command === "string") {
    return input.command.slice(0, 80);
  }
  if ((name === "Edit" || name === "Write" || name === "NotebookEdit") && input.file_path) {
    return path.basename(String(input.file_path));
  }
  if (name === "Read" && input.file_path) {
    return path.basename(String(input.file_path));
  }
  if ((name === "Grep" || name === "Glob") && input.pattern) {
    return String(input.pattern).slice(0, 60);
  }
  return null;
}

function pushSystem(text) {
  const entry = {
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "system",
    text,
    ts: Date.now()
  };
  history.push(entry);
  emitHistory();
}

// Persistent tool-use receipt that appears inline as a pill in the chat stream.
function pushTool(name, summary) {
  if (!name) return;
  const entry = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "tool",
    text: summary ? `${name} · ${summary}` : name,
    name,
    summary: summary || null,
    ts: Date.now()
  };
  history.push(entry);
  emitHistory();
}

function pushUser(text, provider = activeProvider()) {
  const entry = {
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    text,
    provider,
    ts: Date.now()
  };
  history.push(entry);
  archiveConversationEntry(entry);
  updateConversationSummary();
  emitHistory();
}

function formatSummaryTimestamp(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function compactForSummary(text, maxChars = SUMMARY_MESSAGE_MAX_CHARS) {
  const compact = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function shouldIncludeLongMemoryForText(text) {
  const value = String(text || "").toLowerCase();
  return /记得|记忆|回忆|之前|以前|上次|上回|曾经|我们聊过|你知道我|想起来|remember|memory|recall|previous|last time|before/.test(value);
}

function pruneConversationArchiveIfNeeded() {
  try {
    const file = persona.ensureConversationArchiveFile();
    const stat = fs.statSync(file);
    if (stat.size <= ARCHIVE_MAX_BYTES) return;

    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const kept = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (kept.length && bytes + lineBytes > ARCHIVE_TARGET_BYTES) break;
      kept.push(line);
      bytes += lineBytes;
    }
    kept.reverse();
    fs.writeFileSync(file, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  } catch (error) {
    console.warn("chat: failed to prune conversation archive", error);
  }
}

function archiveConversationEntry(entry) {
  if (!entry || !entry.text || !["user", "assistant"].includes(entry.role)) return;
  try {
    const file = persona.ensureConversationArchiveFile();
    const payload = {
      ts: entry.ts || Date.now(),
      role: entry.role,
      provider: normalizeProvider(entry.provider),
      text: String(entry.text)
    };
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
    pruneConversationArchiveIfNeeded();
  } catch (error) {
    console.warn("chat: failed to archive conversation entry", error);
  }
}

function readConversationArchive() {
  try {
    const file = persona.ensureConversationArchiveFile();
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.text && ["user", "assistant"].includes(entry.role));
  } catch (error) {
    console.warn("chat: failed to read conversation archive", error);
    return [];
  }
}

function backfillArchiveFromHistoryIfEmpty() {
  const conversational = history.filter(
    (entry) => entry && entry.text && ["user", "assistant"].includes(entry.role)
  );
  if (!conversational.length) return;
  try {
    const file = persona.ensureConversationArchiveFile();
    const stat = fs.statSync(file);
    if (stat.size > 0) return;
    const lines = conversational.map((entry) => JSON.stringify({
      ts: entry.ts || Date.now(),
      role: entry.role,
      provider: PROVIDERS.CLAUDE,
      text: String(entry.text)
    }));
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  } catch (error) {
    console.warn("chat: failed to backfill conversation archive", error);
  }
}

function buildSharedTranscript() {
  const lines = [];
  for (const entry of history) {
    if (!entry || !entry.text || !["user", "assistant"].includes(entry.role)) continue;
    const label = entry.role === "user" ? "博士" : "普瑞赛斯";
    lines.push(`${label}: ${String(entry.text).trim()}`);
  }
  const transcript = lines.slice(-RECENT_TRANSCRIPT_MESSAGE_LIMIT).join("\n\n");
  if (transcript.length <= SHARED_TRANSCRIPT_MAX_CHARS) {
    return transcript;
  }
  return transcript.slice(transcript.length - SHARED_TRANSCRIPT_MAX_CHARS);
}

function buildConversationSummaryContent() {
  const conversational = readConversationArchive();
  const folded = conversational.slice(0, -RECENT_TRANSCRIPT_MESSAGE_LIMIT);
  const header = [
    "# 长期对话摘要",
    "",
    "_这份文件由 PRTS 自动从较早的聊天记录生成，用来让 Claude Code 与 Codex 在长对话和切换 backend 时保持连续。_",
    "_最近若干条原文会直接注入提示，这里只保留更早内容的压缩摘录。_",
    "",
    `更新时间：${formatSummaryTimestamp(Date.now())}`,
    "",
    "## 折叠的较早对话",
    ""
  ];

  if (!folded.length) {
    return `${header.join("\n")}_暂时还没有需要折叠的对话。_\n`;
  }

  const lines = folded.map((entry) => {
    const label = entry.role === "user" ? "博士" : "普瑞赛斯";
    const provider = entry.provider ? ` (${entry.provider})` : "";
    const text = compactForSummary(entry.text);
    return `- ${formatSummaryTimestamp(entry.ts)} ${label}${provider}: ${text}`;
  });

  while (lines.length > 1 && `${header.join("\n")}${lines.join("\n")}\n`.length > SUMMARY_MAX_CHARS) {
    lines.shift();
  }

  return `${header.join("\n")}${lines.join("\n")}\n`;
}

function updateConversationSummary() {
  try {
    const file = persona.ensureConversationSummaryFile();
    fs.writeFileSync(file, buildConversationSummaryContent(), "utf8");
  } catch (error) {
    console.warn("chat: failed to update conversation summary", error);
  }
}

function beginAssistant() {
  pendingAssistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingAssistantText = "";
  history.push({
    id: pendingAssistantId,
    role: "assistant",
    text: "",
    ts: Date.now()
  });
  emitHistory();
}

function appendAssistant(text) {
  if (!pendingAssistantId) {
    beginAssistant();
  }
  pendingAssistantText += text;
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry) {
    entry.text = pendingAssistantText;
  }
  emitChunk(pendingAssistantId, text);
}

function finalizeAssistant(finalText) {
  if (!pendingAssistantId) {
    if (finalText) {
      beginAssistant();
      appendAssistant(finalText);
    } else {
      return;
    }
  }
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry && finalText && finalText !== entry.text) {
    entry.text = finalText;
  }
  if (entry && entry.text) {
    archiveConversationEntry({
      role: "assistant",
      provider: currentProvider || activeProvider(),
      text: entry.text,
      ts: entry.ts || Date.now()
    });
  }
  pendingAssistantId = null;
  pendingAssistantText = "";
  emitHistory();
  updateConversationSummary();
}

function resolveCwd() {
  const raw = (settings.get("chatCwd") || "").trim();
  if (!raw) return os.homedir();
  try {
    const fs = require("node:fs");
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
      return raw;
    }
  } catch (error) {
    /* fall through */
  }
  return os.homedir();
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        if (part?.type === "input_text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function appendReconciledAssistantText(text) {
  if (!text) return;
  if (!pendingAssistantText) {
    if (!pendingAssistantId) beginAssistant();
    appendAssistant(text);
    return;
  }
  if (text !== pendingAssistantText) {
    const diff = text.startsWith(pendingAssistantText)
      ? text.slice(pendingAssistantText.length)
      : "";
    if (diff) appendAssistant(diff);
  }
}

function rememberProviderSession(provider, value) {
  if (typeof value === "string" && value.length > 0) {
    sessionIds[normalizeProvider(provider)] = value;
  }
}

function handleClaudeStreamEvent(event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "system" && event.subtype === "init") {
    rememberProviderSession(PROVIDERS.CLAUDE, event.session_id);
    return;
  }

  if (event.type === "stream_event") {
    const inner = event.event;
    if (inner?.type === "content_block_start") {
      const block = inner.content_block;
      if (block?.type === "tool_use") {
        emitTool(true, block.name);
      } else if (block?.type === "text") {
        emitTool(false);
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
        const summary = summarizeToolInput(block.name, block.input);
        emitTool(true, block.name, summary);
        pushTool(block.name, summary);
      }
    }

    const text = extractText(event.message?.content);
    appendReconciledAssistantText(text);
    return;
  }

  if (event.type === "result") {
    rememberProviderSession(PROVIDERS.CLAUDE, event.session_id);
    const finalText =
      typeof event.result === "string"
        ? event.result
        : extractText(event.result?.content);
    if (event.is_error && !finalText) {
      pushSystem(`claude reported an error (${event.subtype || "unknown"}).`);
    }
    emitTool(false);
    finalizeAssistant(finalText || pendingAssistantText);
    emitStatus("idle", { provider: PROVIDERS.CLAUDE, sessionId: sessionIds[PROVIDERS.CLAUDE] });
    return;
  }
}

function extractCodexText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractCodexText).join("");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.message === "string") return value.message;
    if (Array.isArray(value.content)) return extractCodexText(value.content);
    if (value.message && typeof value.message === "object") return extractCodexText(value.message);
    if (value.item && typeof value.item === "object") return extractCodexText(value.item);
  }
  return "";
}

function codexSessionIdFromEvent(event) {
  return (
    event.session_id ||
    event.sessionId ||
    event.thread_id ||
    event.threadId ||
    event.conversation_id ||
    event.conversationId ||
    event.id
  );
}

function handleCodexStreamEvent(event) {
  if (!event || typeof event !== "object") return;

  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" || type.includes("session")) {
    rememberProviderSession(PROVIDERS.CODEX, codexSessionIdFromEvent(event));
  }

  if (type.includes("error")) {
    const errorText = extractCodexText(event) || event.message || event.error;
    if (errorText) pushSystem(`Codex reported an error: ${String(errorText).slice(0, 400)}`);
    return;
  }

  const itemType = event.item?.type || event.event?.item?.type || event.kind || "";
  const toolName =
    event.name ||
    event.tool_name ||
    event.item?.name ||
    event.item?.command ||
    event.event?.item?.name ||
    null;

  const isToolEvent =
    type.includes("tool") ||
    type.includes("exec") ||
    type.includes("command") ||
    String(itemType).includes("tool") ||
    String(itemType).includes("command");

  if (isToolEvent) {
    const active = !(type.includes("completed") || type.includes("finished") || type.includes("end"));
    emitTool(active, toolName || "Codex");
    if (active) pushTool(toolName || "Codex", event.item?.summary || event.summary || null);
    return;
  }

  const deltaText =
    extractCodexText(event.delta) ||
    extractCodexText(event.chunk) ||
    extractCodexText(event.item?.delta) ||
    "";

  if (deltaText && (type.includes("delta") || type.includes("chunk"))) {
    appendAssistant(deltaText);
    return;
  }

  const text =
    extractCodexText(event.final_answer) ||
    extractCodexText(event.output) ||
    extractCodexText(event.message) ||
    extractCodexText(event.item) ||
    extractCodexText(event.result);

  const isAssistantMessage =
    type.includes("message") ||
    type.includes("answer") ||
    event.item?.type === "agent_message" ||
    event.item?.type === "assistant_message";

  if (
    text &&
    (isAssistantMessage || type === "result")
  ) {
    appendReconciledAssistantText(text);
  }

  if (type === "turn.completed" || type === "result" || type === "done") {
    emitTool(false);
    finalizeAssistant(pendingAssistantText);
    emitStatus("idle", { provider: PROVIDERS.CODEX, sessionId: sessionIds[PROVIDERS.CODEX] });
  }
}

function handleProviderStreamEvent(provider, event) {
  if (provider === PROVIDERS.CODEX) {
    handleCodexStreamEvent(event);
  } else {
    handleClaudeStreamEvent(event);
  }
}

function shouldIgnoreNonJsonLine(line) {
  return (
    !line ||
    line === "Reading additional input from stdin..." ||
    line.startsWith("WARNING: proceeding, even though we could not update PATH") ||
    /^\d{4}-\d{2}-\d{2}T.*\s(WARN|INFO)\s/.test(line)
  );
}

function takeScreenshotSync() {
  try {
    const dir = path.join(os.tmpdir(), "prts");
    fs.mkdirSync(dir, { recursive: true });
    // Clean up old screenshots — keep only the latest.
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith("screen-") && f.endsWith(".png")) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch {
      /* ignore */
    }
    const out = path.join(dir, `screen-${Date.now()}.png`);
    const proc = require("node:child_process").spawnSync("screencapture", ["-x", out], {
      timeout: 4000
    });
    if (proc.status === 0 && fs.existsSync(out)) {
      return out;
    }
  } catch (error) {
    console.warn("chat: screenshot failed", error);
  }
  return null;
}

function buildClaudeInvocation(trimmed, agentMode, screenshotPath, sharedTranscript) {
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt",
    persona.buildPersonaPrompt({
      agentMode,
      screenshotPath,
      provider: PROVIDERS.CLAUDE,
      sharedTranscript,
      includeLongMemory,
      memoryRecallRequested
    })
  ];

  if (agentMode) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Without agent mode she still needs file tools for memory + light helpfulness.
    // Bash and network tools stay off until the Doctor enables agent mode.
    args.push("--allowedTools", "Read Edit Write Glob Grep LS");
  }

  if (sessionIds[PROVIDERS.CLAUDE]) {
    args.push("--resume", sessionIds[PROVIDERS.CLAUDE]);
  }
  args.push(trimmed);

  return {
    command: resolveExecutable("claude"),
    args,
    stdin: null
  };
}

function buildCodexPrompt(trimmed, agentMode, screenshotPath, sharedTranscript) {
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  return (
    persona.buildPersonaPrompt({
      agentMode,
      screenshotPath,
      provider: PROVIDERS.CODEX,
      sharedTranscript,
      includeLongMemory,
      memoryRecallRequested
    }) +
    "\n\n【博士本轮请求】\n" +
    trimmed
  );
}

function buildCodexInvocation(trimmed, cwd, agentMode, screenshotPath, sharedTranscript) {
  const prompt = buildCodexPrompt(trimmed, agentMode, screenshotPath, sharedTranscript);
  let args;

  if (sessionIds[PROVIDERS.CODEX]) {
    args = [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check"
    ];
    if (screenshotPath) {
      args.push("-i", screenshotPath);
    }
    if (agentMode) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(sessionIds[PROVIDERS.CODEX], "-");
  } else {
    args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      cwd
    ];
    if (screenshotPath) {
      args.push("-i", screenshotPath);
    }
    if (agentMode) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-s", "workspace-write", "--add-dir", persona.memoryDir());
    }
    args.push("-");
  }

  return {
    command: resolveExecutable("codex"),
    args,
    stdin: prompt
  };
}

function buildProviderInvocation(provider, trimmed, cwd, agentMode, screenshotPath, sharedTranscript) {
  if (provider === PROVIDERS.CODEX) {
    return buildCodexInvocation(trimmed, cwd, agentMode, screenshotPath, sharedTranscript);
  }
  return buildClaudeInvocation(trimmed, agentMode, screenshotPath, sharedTranscript);
}

function send(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (currentProcess) return { ok: false, reason: "busy" };

  refreshProviderAvailability();
  const provider = activeProvider();
  const providerInfo = ensureProviderAvailability()[provider];
  if (!providerInfo?.available) {
    pushSystem(
      "No local Claude Code or Codex CLI was found. Install and authenticate one of them, then reopen the tray menu or send again."
    );
    emitStatus("idle", { error: "missing-cli" });
    return { ok: false, reason: "missing-cli" };
  }

  const sharedTranscript = buildSharedTranscript();
  currentProvider = provider;
  pushUser(trimmed, provider);
  beginAssistant();
  turnStartedAt = Date.now();
  emitStatus("running", { provider });

  const agentMode = Boolean(settings.get("agentMode"));
  const autoScreenshot = agentMode && settings.get("autoScreenshot") !== false;
  const screenshotPath = autoScreenshot ? takeScreenshotSync() : null;
  const cwd = resolveCwd();
  const invocation = buildProviderInvocation(
    provider,
    trimmed,
    cwd,
    agentMode,
    screenshotPath,
    sharedTranscript
  );
  let proc;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(invocation.command)
    });
    if (invocation.stdin != null) {
      proc.stdin.end(invocation.stdin);
    }
  } catch (error) {
    pushSystem(
      `Failed to launch \`${providerLabel(provider)}\`: ${error.message}. Is the CLI installed and on PATH?`
    );
    finalizeAssistant("");
    emitStatus("idle", { error: error.message });
    currentProvider = null;
    return { ok: false, reason: "spawn-failed" };
  }

  currentProcess = proc;
  let buffer = "";
  let stderrBuffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineAt;
    while ((newlineAt = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line) continue;
      try {
        handleProviderStreamEvent(provider, JSON.parse(line));
      } catch (error) {
        if (shouldIgnoreNonJsonLine(line)) continue;
        // Non-JSON line — surface as system note for transparency.
        pushSystem(`Unparsed: ${line.slice(0, 200)}`);
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
  });

  proc.on("error", (error) => {
    pushSystem(`\`${providerLabel(provider)}\` process error: ${error.message}`);
    finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    emitStatus("idle", { error: error.message });
  });

  proc.on("close", (code) => {
    if (buffer.trim()) {
      try {
        handleProviderStreamEvent(provider, JSON.parse(buffer.trim()));
      } catch {
        /* ignore trailing junk */
      }
      buffer = "";
    }
    if (code !== 0 && code !== null) {
      const stderrSummary = stderrBuffer.trim().slice(-400);
      pushSystem(
        `\`${providerLabel(provider)}\` exited with code ${code}.${stderrSummary ? "\n" + stderrSummary : ""}`
      );
    }
    if (pendingAssistantId) finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    emitStatus("idle");
  });

  return { ok: true };
}

function cancel() {
  if (currentProcess) {
    try {
      currentProcess.kill("SIGTERM");
    } catch (error) {
      console.warn("chat: failed to kill subprocess", error);
    }
    currentProcess = null;
    if (pendingAssistantId) finalizeAssistant("");
    currentProvider = null;
    emitStatus("idle", { cancelled: true });
  }
}

function clear() {
  cancel();
  history.length = 0;
  sessionIds = { [PROVIDERS.CLAUDE]: null, [PROVIDERS.CODEX]: null };
  currentProvider = null;
  longMemoryDormant = true;
  updateConversationSummary();
  emitHistory();
}

function hydrate({
  history: savedHistory,
  sessionId: savedSessionId,
  sessionIds: savedSessionIds,
  longMemoryDormant: savedLongMemoryDormant
} = {}) {
  if (Array.isArray(savedHistory)) {
    history.length = 0;
    for (const entry of savedHistory) {
      if (entry && entry.role && typeof entry.text === "string") {
        history.push(entry);
      }
    }
  }
  longMemoryDormant = typeof savedLongMemoryDormant === "boolean"
    ? savedLongMemoryDormant
    : history.length === 0;
  if (typeof savedSessionId === "string" && savedSessionId.length > 0) {
    sessionIds[PROVIDERS.CLAUDE] = savedSessionId;
  }
  if (savedSessionIds && typeof savedSessionIds === "object") {
    sessionIds = {
      [PROVIDERS.CLAUDE]: typeof savedSessionIds[PROVIDERS.CLAUDE] === "string"
        ? savedSessionIds[PROVIDERS.CLAUDE]
        : sessionIds[PROVIDERS.CLAUDE],
      [PROVIDERS.CODEX]: typeof savedSessionIds[PROVIDERS.CODEX] === "string"
        ? savedSessionIds[PROVIDERS.CODEX]
        : sessionIds[PROVIDERS.CODEX]
    };
  }
  backfillArchiveFromHistoryIfEmpty();
  updateConversationSummary();
  emitHistory();
}

function getSessionId() {
  return sessionIds[activeProvider()] || null;
}

function getSessionIds() {
  return { ...sessionIds };
}

function getLastTurnDurationMs() {
  return turnStartedAt ? Date.now() - turnStartedAt : 0;
}

function isLongMemoryDormant() {
  return longMemoryDormant;
}

module.exports = {
  send,
  cancel,
  clear,
  subscribe,
  refreshProviderAvailability,
  getProviderAvailability,
  getHistory,
  hydrate,
  getSessionId,
  getSessionIds,
  isLongMemoryDormant,
  getLastTurnDurationMs
};
