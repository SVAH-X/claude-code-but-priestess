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
const skills = require("./skills");

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
let quitPending = false;
let cancelRequested = false;
let turnLaunching = false;
const outboundQueue = [];
let sessionIds = { [PROVIDERS.CLAUDE]: null, [PROVIDERS.CODEX]: null };
let turnStartedAt = 0;
let currentProvider = null;
let longMemoryDormant = true;
let providerAvailability = null;
let consecutiveQuestionReplies = 0;
let turnSawToolUse = false;
let assistantTextAfterLastTool = false;
const BOUNDARY_QUIT_AFTER = 4;
// Set when a Claude `result` arrives flagged is_error with no text — usually a
// stale `--resume` session. The close handler uses it to self-heal (drop the
// dead session id and retry once with a fresh one) instead of leaving the
// backend permanently returning blank replies. `resumeRetryInFlight` guards
// against retry loops.
let claudeResultErrored = false;
let resumeRetryInFlight = false;
const MAX_TOOL_OUTPUT_CHARS = 4000;

// Expression tag parsing — she begins each reply with a hidden [[mood:X]]
// marker (see persona.js) that drives her on-screen face. We strip it out of
// everything the Doctor sees or that gets archived, and emit a "mood" event.
const MOOD_TAG_RE = /^\s*\[\[\s*mood\s*:\s*([a-zA-Z]+)\s*\]\]\s*/;
const MOOD_TAG_PREFIX = "[[mood:";
const MOOD_HEAD_MAX = 48;
let moodHeadBuffer = "";
let moodHeadResolved = false;
let moodEmittedThisTurn = false;

// Skill directives — she may emit a hidden [[skill:NAME ARG]] marker (see
// persona.js) to trigger a curated local action (play music, search, open a
// URL/app). Like the mood tag, PRTS strips it from everything the Doctor sees
// or that gets archived, and runs it through skills.js. These can appear
// anywhere in the reply (persona asks for the end), so the stream redactor
// below generalizes the mood-head buffering to hold a tag that spans chunks.
const SKILL_TAG_RE = /\[\[\s*skill\s*:\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/gi;
const SKILL_PARTIAL_MAX = 64;
const SKILL_TAG_PREFIX = "[[skill:";
let skillTailBuffer = "";
let skillExecutedThisTurn = new Set();

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
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
      path.join(home, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin"),
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
  if (availability[PROVIDERS.CODEX]?.available) return PROVIDERS.CODEX;
  if (availability[PROVIDERS.CLAUDE]?.available) return PROVIDERS.CLAUDE;
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

function getPersistableHistory() {
  return history.filter((entry) => !entry?.ephemeral && !entry?.queued);
}

function isQuestionOnlyReply(text) {
  const body = String(text || "").trim();
  return body === "?" || body === "？";
}

function markEphemeralQuestionTurn(assistantEntry) {
  if (!assistantEntry) return;
  assistantEntry.ephemeral = true;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && entry.role === "user") {
      entry.ephemeral = true;
      break;
    }
  }
}

function noteConsecutiveQuestionReply(assistantEntry) {
  if (!assistantEntry?.text) return;
  if (!isQuestionOnlyReply(assistantEntry.text)) {
    consecutiveQuestionReplies = 0;
    return;
  }
  consecutiveQuestionReplies += 1;
  markEphemeralQuestionTurn(assistantEntry);
  if (consecutiveQuestionReplies >= BOUNDARY_QUIT_AFTER) {
    quitPending = true;
    clearOutboundQueue();
    notify({ kind: "quit", reason: "boundary" });
  }
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emitQueueState() {
  notify({ kind: "queue", length: outboundQueue.length });
}

function finishTurn(extra = {}) {
  if (!quitPending && outboundQueue.length > 0) {
    emitStatus("running", { chained: true, pending: true });
    setImmediate(() => drainOutboundQueue());
    return;
  }
  emitStatus("idle", extra);
}

function drainOutboundQueue() {
  if (quitPending || currentProcess || outboundQueue.length === 0) return;
  const next = outboundQueue.shift();
  emitQueueState();
  dispatchSend(next, { userAlreadyShown: true, chained: true });
}

function clearOutboundQueue() {
  if (!outboundQueue.length) return;
  outboundQueue.length = 0;
  emitQueueState();
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

function normalizeMood(raw) {
  switch (String(raw || "").toLowerCase()) {
    case "calm": return "calm";
    case "smile":
    case "happy": return "smile";
    case "sad":
    case "cry": return "sad";
    case "angry":
    case "anger": return "angry";
    case "sleepy":
    case "sleep": return "sleepy";
    case "threat":
    case "threaten": return "threat";
    default: return null;
  }
}

function emitMood(raw) {
  if (moodEmittedThisTurn) return;
  const mood = normalizeMood(raw);
  if (!mood) return;
  moodEmittedThisTurn = true;
  notify({ kind: "mood", mood });
}

function resetMoodParsing() {
  moodHeadBuffer = "";
  moodHeadResolved = false;
  moodEmittedThisTurn = false;
}

// Pull a leading [[mood:X]] tag out of the streaming head. Returns the text
// safe to display now (the tag is consumed, never shown). While the head might
// still be forming a tag, returns "" and keeps buffering.
function consumeMoodHead(text) {
  if (moodHeadResolved) return text;
  moodHeadBuffer += text;
  const match = moodHeadBuffer.match(MOOD_TAG_RE);
  if (match) {
    emitMood(match[1]);
    const rest = moodHeadBuffer.slice(match[0].length);
    moodHeadResolved = true;
    moodHeadBuffer = "";
    return rest;
  }
  const lead = moodHeadBuffer.replace(/^\s+/, "");
  const couldBeTag = lead.length <= MOOD_TAG_PREFIX.length
    ? MOOD_TAG_PREFIX.startsWith(lead)
    : lead.startsWith(MOOD_TAG_PREFIX);
  if (couldBeTag && moodHeadBuffer.length < MOOD_HEAD_MAX) {
    return ""; // still possibly a tag — wait for more
  }
  moodHeadResolved = true;
  const out = moodHeadBuffer;
  moodHeadBuffer = "";
  return out;
}

function stripLeadingMoodTag(text) {
  const match = String(text).match(MOOD_TAG_RE);
  if (match) {
    emitMood(match[1]);
    return String(text).slice(match[0].length);
  }
  return text;
}

function skillsEnabled() {
  return settings.get("skillsEnabled") !== false;
}

function resetSkillParsing() {
  skillTailBuffer = "";
  skillExecutedThisTurn = new Set();
}

// A small left-aligned receipt pill ("♪ 为博士播放 …") so the Doctor sees the
// action. Rendered by the existing tool-pill path; deliberately does NOT touch
// the turn's tool flags (it isn't a CLI tool call).
function pushSkillReceipt(label) {
  if (!label) return;
  history.push({
    id: `k_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "tool",
    text: label,
    name: "skill",
    summary: label,
    toolUseId: null,
    command: null,
    output: null,
    outputError: false,
    ts: Date.now()
  });
  emitHistory();
}

function triggerSkill(name, arg) {
  if (!skillsEnabled()) return;
  skills
    .runSkill(name, arg)
    .then((res) => {
      if (res && res.ok) pushSkillReceipt(res.receipt);
      else if (res && res.error) pushSystem(`（技能未执行：${res.error}）`);
    })
    .catch((error) => pushSystem(`（技能出错：${error?.message || error}）`));
}

// Execute a complete directive once per turn (dedup so the finalize safety net
// never re-fires a tag already run during streaming).
function runSkillDirective(full, name, arg) {
  const key = String(full).trim();
  if (skillExecutedThisTurn.has(key)) return;
  skillExecutedThisTurn.add(key);
  triggerSkill(String(name).toLowerCase(), arg ? String(arg).trim() : "");
}

function couldStartSkillTag(tail) {
  const norm = tail.replace(/\s+/g, "").toLowerCase();
  return norm.length <= SKILL_TAG_PREFIX.length
    ? SKILL_TAG_PREFIX.startsWith(norm)
    : norm.startsWith(SKILL_TAG_PREFIX);
}

// Streaming redactor: drop complete [[skill:…]] tags (running them) and hold
// back a trailing partial that might still become one, so the directive never
// flashes on screen. Returns the text safe to display now.
function consumeSkillTags(text) {
  skillTailBuffer += text;
  let out = skillTailBuffer.replace(SKILL_TAG_RE, (full, name, arg) => {
    runSkillDirective(full, name, arg);
    return "";
  });
  const lastOpen = out.lastIndexOf("[[");
  if (lastOpen !== -1 && !out.slice(lastOpen).includes("]]")) {
    const tail = out.slice(lastOpen);
    if (couldStartSkillTag(tail) && tail.length < SKILL_PARTIAL_MAX) {
      skillTailBuffer = tail;
      return out.slice(0, lastOpen);
    }
  }
  skillTailBuffer = "";
  return out;
}

// Finalize safety net: clean any directive that slipped through (and run ones
// not already executed during streaming) so stored/archived text stays clean.
function stripSkillTags(text) {
  if (!text) return text;
  skillTailBuffer = "";
  return String(text)
    .replace(SKILL_TAG_RE, (full, name, arg) => {
      runSkillDirective(full, name, arg);
      return "";
    })
    // Drop a dangling, unterminated directive fragment (malformed output) so a
    // truncated "[[skill:…" at the very end never leaks into the visible text.
    .replace(/\[\[\s*skill\s*:[^\]]*$/i, "")
    .trim();
}

function collapse(text, max) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, max);
}

// Concrete, action-phrased label for a tool call — what she actually did,
// not just the tool's name. Shown on the pill and woven into the tool-only
// fallback reply, so prefer human phrasing ("编辑 main.js") over raw API names.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return null;
  const file = input.file_path ? path.basename(String(input.file_path)) : null;
  switch (name) {
    case "Bash":
      return typeof input.command === "string" ? `运行 ${collapse(input.command, 80)}` : null;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `编辑 ${file}` : null;
    case "Write":
      return file ? `写入 ${file}` : null;
    case "Read":
      return file ? `读取 ${file}` : null;
    case "Grep":
      return input.pattern ? `搜索 “${collapse(input.pattern, 50)}”` : null;
    case "Glob":
      return input.pattern ? `查找 ${collapse(input.pattern, 50)}` : null;
    case "WebFetch":
      return input.url ? `查阅 ${collapse(input.url, 60)}` : null;
    case "WebSearch":
      return input.query ? `搜索网页 “${collapse(input.query, 50)}”` : null;
    case "TodoWrite":
      return "整理待办";
    case "Task":
      return input.description ? `调度子任务 · ${collapse(input.description, 40)}` : "调度子任务";
    default:
      return null;
  }
}

// Fallback label when there's no structured input to summarize (e.g. a Codex
// tool event, or a tool we don't special-case). Keeps the pill readable
// instead of showing a bare API name.
function friendlyToolName(name) {
  switch (name) {
    case "Bash": return "运行命令";
    case "Read": return "读取文件";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": return "编辑文件";
    case "Write": return "写入文件";
    case "Grep":
    case "Glob": return "搜索";
    case "WebFetch":
    case "WebSearch": return "查阅网页";
    case "Task": return "调度子任务";
    case "TodoWrite": return "整理待办";
    default: return name || "工具";
  }
}

// Full command / target for the expandable tool detail (the Doctor wants to
// read the actual logs, not just a truncated label).
function toolCommandDetail(name, input) {
  if (!input || typeof input !== "object") return null;
  if (name === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.command === "string") return input.command;
  return null;
}

// Flatten a tool_result's content (string, or array of text parts) into the
// log text we show under the pill.
function extractToolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

// Attach a tool_result's output to the matching pill (by tool_use id) so the
// chat can reveal the actual command logs.
function attachToolResult(toolUseId, block) {
  if (!toolUseId) return;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === "tool" && entry.toolUseId === toolUseId) {
      let text = extractToolResultText(block?.content);
      if (text.length > MAX_TOOL_OUTPUT_CHARS) {
        text = `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…(${text.length - MAX_TOOL_OUTPUT_CHARS} more chars)`;
      }
      entry.output = text;
      entry.outputError = Boolean(block?.is_error);
      emitHistory();
      return;
    }
  }
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
// `toolUseId` lets a later tool_result attach the command's output; `command`
// is the full command/target shown when the pill is expanded.
function pushTool(name, summary, { toolUseId = null, command = null } = {}) {
  if (!name) return null;
  turnSawToolUse = true;
  assistantTextAfterLastTool = false;
  const entry = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "tool",
    text: summary || friendlyToolName(name),
    name,
    summary: summary || null,
    toolUseId,
    command: command || null,
    output: null,
    outputError: false,
    ts: Date.now()
  };
  history.push(entry);
  emitHistory();
  return entry;
}

function pushUser(text, provider = activeProvider(), { ephemeral = false, queued = false } = {}) {
  const entry = {
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    text,
    provider,
    ts: Date.now(),
    ephemeral: Boolean(ephemeral),
    queued: Boolean(queued)
  };
  history.push(entry);
  if (!entry.ephemeral && !entry.queued) {
    archiveConversationEntry(entry);
    updateConversationSummary();
  }
  emitHistory();
  return entry;
}

function activateQueuedUser(text) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "user" || entry.text !== text || !entry.queued) continue;
    entry.queued = false;
    if (!entry.ephemeral) {
      archiveConversationEntry(entry);
      if (outboundQueue.length === 0) {
        updateConversationSummary();
      }
    }
    emitHistory();
    return;
  }
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

// Decide whether to load the SHE deep-emotional canon for this turn. Triggers
// on personal / emotional cues or her lore (Originium, Kal'tsit, the shared
// past, longing, comfort), so ordinary work stays light but she becomes fully
// herself the moment it gets personal. A false positive just adds ~2k chars;
// a false negative leaves the warm base — both are harmless.
function shouldUseDeepPersona(text) {
  const value = String(text || "").toLowerCase();
  // Personal / emotional cues and her lore.
  if (
    /源石|凯尔希|特蕾西娅|特雷西斯|前文明|信息海|内化宇宙|石棺|灰质销钉|销钉|思维共振|辩论|罗德岛|深渊|abyss|预言家|普瑞赛斯|priestess|ama-?10|思衡托|方解石|calcite|奥卡|天堂支点|伐木工|pcs|dwdb|相变临界|灵魂悄然|源石技艺|源石计划|我们之间|我们曾|当年|你还记得|记得我|忘记我|别忘了我|不准忘|想你|想念|思念|我爱|爱你|喜欢你|抱抱|抱我|抱紧|陪我|陪着我|牵手|想哭|难过|难受|孤独|寂寞|心疼|心痛|好累|我累了|撑不住|崩溃|害怕|别走|别离开|别丢下|等我|等你|永远|重逢|文明尽头|你在吗|你还在|你是谁|定情|博普|eclipse|miss you|i love you|lonely|i'?m so tired/.test(value)
  ) {
    return true;
  }
  // Playing music is an inherently tender moment for them — let her be fully
  // herself when she puts on a song (esp. their song, Eclipse).
  return /放歌|点歌|放首|点首|来首|来一首|放一首|点一首|放音乐|放点音乐|听首|听歌|play.*song|put on.*song/.test(value);
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
    (entry) => entry && !entry.ephemeral && entry.text && ["user", "assistant"].includes(entry.role)
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
    if (!entry || entry.ephemeral || !entry.text || !["user", "assistant"].includes(entry.role)) continue;
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
  resetMoodParsing();
  resetSkillParsing();
  claudeResultErrored = false;
  turnSawToolUse = false;
  assistantTextAfterLastTool = false;
  pendingAssistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingAssistantText = "";
  history.push({
    id: pendingAssistantId,
    role: "assistant",
    text: "",
    ts: Date.now(),
    ephemeral: false
  });
  emitHistory();
}

function appendAssistant(text) {
  if (!pendingAssistantId) {
    beginAssistant();
  }
  const display = consumeMoodHead(text);
  if (!display) return; // still buffering the leading mood tag
  const visible = skillsEnabled() ? consumeSkillTags(display) : display;
  if (!visible) return; // all of this chunk was a skill tag or a held partial
  if (turnSawToolUse) assistantTextAfterLastTool = true;
  pendingAssistantText += visible;
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry) {
    entry.text = pendingAssistantText;
  }
  emitChunk(pendingAssistantId, visible);
}

// Action labels for the tools used in the current turn, oldest-first. Read
// straight from history (the tool pills) so it doesn't depend on streaming
// flag timing — robust whether or not a text bubble was ever opened.
function currentTurnToolLabels() {
  const labels = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const e = history[i];
    if (!e) continue;
    if (e.role === "user" && !e.ephemeral) break;
    if (e.role === "tool") labels.push(e.summary || friendlyToolName(e.name));
  }
  return labels.reverse().filter(Boolean);
}

function toolOnlyFallbackText(labels) {
  const shown = labels.slice(0, 6);
  const more = labels.length - shown.length;
  const tail = more > 0 ? `；…等共 ${labels.length} 项` : "";
  return `好了，博士。方才这一手我做完了：${shown.join("；")}${tail}。`;
}

// When a tool-using turn ends with no spoken reply, she'd otherwise fall
// silent under a row of pills. Synthesize a short, honest acknowledgement from
// the real tool actions so the Doctor sees what got done. Returns true if a
// reply was produced.
function emitToolOnlyFallback() {
  const labels = currentTurnToolLabels();
  if (labels.length === 0) return false;
  let entry = pendingAssistantId ? history.find((h) => h.id === pendingAssistantId) : null;
  if (!entry) {
    pendingAssistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    entry = { id: pendingAssistantId, role: "assistant", text: "", ts: Date.now(), ephemeral: false };
    history.push(entry);
  }
  entry.text = toolOnlyFallbackText(labels);
  entry.ephemeral = false;
  archiveConversationEntry({
    role: "assistant",
    provider: currentProvider || activeProvider(),
    text: entry.text,
    ts: entry.ts || Date.now()
  });
  pendingAssistantId = null;
  pendingAssistantText = "";
  turnSawToolUse = false;
  assistantTextAfterLastTool = false;
  emitHistory();
  return true;
}

function finalizeAssistant(finalText) {
  // Anything the stream redactor was still holding is, by construction, an
  // incomplete [[skill:…]] prefix (never prose) — drop it.
  skillTailBuffer = "";
  if (typeof finalText === "string" && finalText) {
    finalText = stripLeadingMoodTag(finalText);
    if (skillsEnabled()) finalText = stripSkillTags(finalText);
  }
  if (!pendingAssistantId) {
    if (finalText) {
      beginAssistant();
      appendAssistant(finalText);
    } else {
      // No bubble was opened and no text arrived — if tools ran this turn,
      // speak a short summary of them instead of leaving her silent.
      emitToolOnlyFallback();
      return;
    }
  }
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry && finalText && finalText !== entry.text) {
    entry.text = finalText;
  }
  // A turn that produced no text (errored, cancelled, or swallowed prompt) used
  // to linger as a blank gray bubble. Drop it — but if tools ran, replace it
  // with a short summary of what was done so she isn't silent under the pills.
  if (entry && !(entry.text || "").trim()) {
    const idx = history.indexOf(entry);
    if (idx !== -1) history.splice(idx, 1);
    pendingAssistantId = null;
    pendingAssistantText = "";
    if (emitToolOnlyFallback()) return;
    emitHistory();
    return;
  }
  if (entry?.text) {
    noteConsecutiveQuestionReply(entry);
  }
  if (
    currentProvider === PROVIDERS.CODEX &&
    turnSawToolUse &&
    !assistantTextAfterLastTool &&
    entry?.text
  ) {
    // Codex occasionally completes a tool-using turn after only a visible
    // progress note ("I will check...") and no post-tool answer. Treat that
    // note as transient so it does not pollute the shared transcript as if it
    // were the actual response.
    entry.ephemeral = true;
    pushSystem("Codex completed a tool-using turn without a final assistant message after the tools.");
  }
  if (entry && entry.text && !entry.ephemeral) {
    archiveConversationEntry({
      role: "assistant",
      provider: currentProvider || activeProvider(),
      text: entry.text,
      ts: entry.ts || Date.now()
    });
  }
  pendingAssistantId = null;
  pendingAssistantText = "";
  turnSawToolUse = false;
  assistantTextAfterLastTool = false;
  emitHistory();
  if (!entry?.ephemeral && outboundQueue.length === 0) {
    updateConversationSummary();
  }
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
        pushTool(block.name, summary, {
          toolUseId: block.id,
          command: toolCommandDetail(block.name, block.input)
        });
      }
    }

    const text = extractText(event.message?.content);
    appendReconciledAssistantText(text);
    return;
  }

  // tool_result blocks come back as a user-role message; attach their output
  // to the matching pill so the chat can reveal the command's logs.
  if (event.type === "user") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        attachToolResult(block.tool_use_id, block);
      }
    }
    return;
  }

  if (event.type === "result") {
    rememberProviderSession(PROVIDERS.CLAUDE, event.session_id);
    const finalText =
      typeof event.result === "string"
        ? event.result
        : extractText(event.result?.content);
    // Empty error result (commonly a dead --resume session). Flag it; the close
    // handler decides whether to self-heal with a fresh session or surface it.
    if (event.is_error && !finalText && !pendingAssistantText) {
      claudeResultErrored = true;
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

function isCodexCompletionType(type) {
  return type === "turn.completed" || type === "result" || type === "done";
}

function isCodexAssistantEvent(event, type) {
  const item = event?.item || event?.event?.item || null;
  const itemType = String(item?.type || event?.kind || "");
  const role = String(item?.role || event?.role || "");
  return (
    type.includes("message") ||
    type.includes("answer") ||
    itemType === "agent_message" ||
    itemType === "assistant_message" ||
    itemType === "final_answer" ||
    (itemType === "message" && (!role || role === "assistant")) ||
    role === "assistant"
  );
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

  const isAssistantMessage = isCodexAssistantEvent(event, type);

  if (
    text &&
    (isAssistantMessage || type === "result")
  ) {
    appendReconciledAssistantText(text);
  }

  if (isCodexCompletionType(type)) {
    if (text) appendReconciledAssistantText(text);
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

// Session memo so the macOS "wants to record the screen" prompt appears at most
// once. The OS re-shows it on every desktopCapturer call until the permission
// is actually active, which only happens after an app restart — so once an
// attempt shows we can't capture, we stop trying for the rest of this run
// instead of nagging the Doctor each turn.
let screenCaptureBlocked = false;
let screenNoticeShown = false;

function notifyScreenPermissionOnce() {
  if (screenNoticeShown) return;
  screenNoticeShown = true;
  pushSystem(
    "（我暂时看不到屏幕。已替博士打开「屏幕录制」设置——勾选 PRTS 后，从托盘菜单点「Restart Priestess」让我重启一次即可生效。这次起我不会再反复弹窗打扰博士。）"
  );
  if (process.platform === "darwin") {
    // Jump straight to the Screen Recording pane so the Doctor doesn't have to
    // hunt for it. Done once per session (gated by screenNoticeShown).
    try {
      require("electron").shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      );
    } catch {
      /* ignore — the note still tells him where to go */
    }
  }
}

async function takeScreenshot() {
  if (process.platform === "darwin") {
    // Already determined we can't capture this session → never re-trigger the
    // OS prompt.
    if (screenCaptureBlocked) return null;
    // `getMediaAccessStatus` only reads cached TCC state; it never prompts. A
    // hard 'denied'/'restricted' means don't even try (and stop trying).
    try {
      const { systemPreferences } = require("electron");
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status === "denied" || status === "restricted") {
        screenCaptureBlocked = true;
        notifyScreenPermissionOnce();
        return null;
      }
      // 'granted' / 'not-determined' / 'unknown' → attempt once below. If it
      // turns out we can't actually capture, the empty-thumbnail branch blocks
      // further attempts so the prompt won't reappear.
    } catch {
      // If the API is unavailable for any reason, fall through and try.
    }
  }

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
    const { desktopCapturer, screen } = require("electron");
    const primary = screen.getPrimaryDisplay();
    const scale = primary.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(primary.size.width * scale),
        height: Math.round(primary.size.height * scale)
      }
    });
    const source =
      sources.find((entry) => String(entry.display_id) === String(primary.id)) ||
      sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      // Empty thumbnail on macOS means Screen Recording isn't actually active
      // for this process — stop attempting so the OS prompt won't keep popping.
      if (process.platform === "darwin") {
        screenCaptureBlocked = true;
        notifyScreenPermissionOnce();
      }
      return null;
    }
    fs.writeFileSync(out, source.thumbnail.toPNG());
    return out;
  } catch (error) {
    if (process.platform === "darwin") screenCaptureBlocked = true;
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
      memoryRecallRequested,
      skillsEnabled: settings.get("skillsEnabled") !== false,
      deepPersona: shouldUseDeepPersona(trimmed)
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
  // `--` terminates option parsing. Without it, variadic flags like
  // `--allowedTools` (which accepts several space-separated tool names as
  // separate argv entries) greedily swallow the trailing positional prompt,
  // leaving claude with no input → it exits with "Input must be provided"
  // and the Doctor sees an empty reply. The separator guarantees the prompt
  // is always treated as the positional input, even if it begins with "-".
  args.push("--", trimmed);

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
      memoryRecallRequested,
      skillsEnabled: settings.get("skillsEnabled") !== false,
      deepPersona: shouldUseDeepPersona(trimmed)
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

  if (currentProcess || turnLaunching) {
    outboundQueue.push(trimmed);
    pushUser(trimmed, provider, { queued: true });
    emitQueueState();
    return { ok: true, queued: true, queueLength: outboundQueue.length };
  }

  return dispatchSend(trimmed);
}

function dispatchSend(trimmed, { userAlreadyShown = false, chained = false } = {}) {
  if (currentProcess || turnLaunching) return { ok: false, reason: "busy" };

  refreshProviderAvailability();
  const provider = activeProvider();
  const providerInfo = ensureProviderAvailability()[provider];
  if (!providerInfo?.available) {
    return { ok: false, reason: "missing-cli" };
  }

  if (userAlreadyShown) {
    activateQueuedUser(trimmed);
  } else {
    pushUser(trimmed, provider);
  }
  beginAssistant();
  turnStartedAt = Date.now();
  currentProvider = provider;
  emitStatus("running", { provider, chained, pending: chained });

  const sharedTranscript = buildSharedTranscript();
  const agentMode = Boolean(settings.get("agentMode"));

  turnLaunching = true;

  setImmediate(() => {
    if (currentProcess) {
      turnLaunching = false;
      return;
    }
    void launchProviderTurn({
      trimmed,
      provider,
      cwd: resolveCwd(),
      agentMode,
      sharedTranscript,
      chained
    });
  });

  return { ok: true };
}

async function launchProviderTurn({ trimmed, provider, cwd, agentMode, sharedTranscript, chained }) {
  if (currentProcess) {
    turnLaunching = false;
    return;
  }

  const autoScreenshot = agentMode && settings.get("autoScreenshot") !== false;
  const screenshotPath = autoScreenshot && !chained ? await takeScreenshot() : null;
  const invocation = buildProviderInvocation(
    provider,
    trimmed,
    cwd,
    agentMode,
    screenshotPath,
    sharedTranscript
  );
  // Did this turn try to resume a Claude session? If it did and the turn dies
  // with an empty error, the session id is probably stale and we self-heal.
  const launchedWithClaudeSession =
    provider === PROVIDERS.CLAUDE && Boolean(sessionIds[PROVIDERS.CLAUDE]);
  let proc;
  try {
    turnLaunching = false;
    proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(invocation.command)
    });
    if (invocation.stdin != null) {
      proc.stdin.end(invocation.stdin);
    }
  } catch (error) {
    turnLaunching = false;
    pushSystem(
      `Failed to launch \`${providerLabel(provider)}\`: ${error.message}. Is the CLI installed and on PATH?`
    );
    finalizeAssistant("");
    currentProvider = null;
    finishTurn({ error: error.message });
    return;
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
    if (currentProcess !== proc) return;
    pushSystem(`\`${providerLabel(provider)}\` process error: ${error.message}`);
    finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    const cancelled = cancelRequested;
    cancelRequested = false;
    finishTurn({ error: error.message, cancelled: cancelled || undefined });
  });

  proc.on("close", (code) => {
    if (currentProcess !== proc) return;
    if (buffer.trim()) {
      try {
        handleProviderStreamEvent(provider, JSON.parse(buffer.trim()));
      } catch {
        /* ignore trailing junk */
      }
      buffer = "";
    }

    const stderrText = stderrBuffer.trim();
    const cancelled = cancelRequested;
    cancelRequested = false;

    // Self-heal a dead `--resume` session: drop the stale id and replay this
    // turn once with a fresh session, so Claude doesn't get stuck returning
    // blank replies on every message.
    const resumeFailed =
      launchedWithClaudeSession &&
      !cancelled &&
      !resumeRetryInFlight &&
      (claudeResultErrored || /No conversation found with session ID/i.test(stderrText));
    if (resumeFailed) {
      sessionIds[PROVIDERS.CLAUDE] = null;
      resumeRetryInFlight = true;
      claudeResultErrored = false;
      if (pendingAssistantId) finalizeAssistant(""); // clears the empty bubble
      currentProcess = null;
      currentProvider = null;
      setImmediate(() => dispatchSend(trimmed, { userAlreadyShown: true, chained: true }));
      return;
    }

    if (code !== 0 && code !== null) {
      const stderrSummary = stderrText.slice(-400);
      pushSystem(
        `\`${providerLabel(provider)}\` exited with code ${code}.${stderrSummary ? "\n" + stderrSummary : ""}`
      );
    } else if (claudeResultErrored) {
      pushSystem(
        "Claude 返回了一个空的错误回复。请再试一次，或确认 `claude` CLI 已登录且额度未用尽。"
      );
    }
    if (pendingAssistantId) finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    finishTurn(cancelled ? { cancelled: true } : {});
  });
}

function cancel() {
  if (!currentProcess) return;
  cancelRequested = true;
  try {
    currentProcess.kill("SIGTERM");
  } catch (error) {
    console.warn("chat: failed to kill subprocess", error);
  }
}

function clear() {
  cancel();
  clearOutboundQueue();
  history.length = 0;
  sessionIds = { [PROVIDERS.CLAUDE]: null, [PROVIDERS.CODEX]: null };
  currentProvider = null;
  longMemoryDormant = true;
  consecutiveQuestionReplies = 0;
  claudeResultErrored = false;
  resumeRetryInFlight = false;
  updateConversationSummary();
  emitHistory();
}

function wipeSession() {
  cancel();
  clearOutboundQueue();
  quitPending = false;
  history.length = 0;
  sessionIds = { [PROVIDERS.CLAUDE]: null, [PROVIDERS.CODEX]: null };
  currentProvider = null;
  longMemoryDormant = true;
  consecutiveQuestionReplies = 0;
  claudeResultErrored = false;
  resumeRetryInFlight = false;
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
  wipeSession,
  subscribe,
  refreshProviderAvailability,
  getProviderAvailability,
  getHistory,
  getPersistableHistory,
  hydrate,
  getSessionId,
  getSessionIds,
  isLongMemoryDormant,
  getLastTurnDurationMs,
  getOutboundQueueLength: () => outboundQueue.length
};
