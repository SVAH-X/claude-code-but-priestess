// ============================================================
//  Chat — drives the selected local coding CLI as a subprocess.
//  Claude Code and Codex keep separate session ids, while persona,
//  memory, working directory, and renderer state stay shared.
// ============================================================
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settings = require("./settings");
const persona = require("./persona");
const skills = require("./skills");
const priestessProvider = require("./priestess-provider");
const { spawnCli, spawnCliSync } = require("./cli-spawn");

const PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  CODEX: "codex",
  // Built-in backend: PRTS speaks to an OpenAI-compatible server directly
  // (LiteLLM by default) — no local CLI required. Chat + skills + memory
  // injection work; CLI file tools and agent mode do not apply.
  PRIESTESS: "priestess"
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
let assistantTextAfterLastAction = false;
let currentTurnHadScreenshot = false;
// Codex sometimes ends a tool-using turn with only a progress note and no real
// answer. We auto-continue once per user turn (the close handler re-prompts) so
// she answers instead of going silent; the guard prevents loops.
let codexAutoContinued = false;
let codexContinuationPending = false;
const CODEX_CONTINUE_NUDGE =
  "（系统提示：你刚才用了工具，但还没有把回答交给博士。请直接根据看到的屏幕或工具结果，用普瑞赛斯的口吻给出真正的回答；不要只说你做了什么，也不要再运行 screencapture。）";
const BOUNDARY_QUIT_AFTER = 4;
// Set when a Claude `result` arrives flagged is_error with no text — usually a
// stale `--resume` session. The close handler uses it to self-heal (drop the
// dead session id and retry once with a fresh one) instead of leaving the
// backend permanently returning blank replies. `resumeRetryInFlight` guards
// against retry loops.
let claudeResultErrored = false;
let resumeRetryInFlight = false;
// Claude has no model-catalog command (unlike `codex debug models`), so a bad
// `--model` can only be caught reactively: claude returns error "model_not_found"
// (api_error_status 404). When that happens we drop the selected model back to
// the CLI default and retry once. `claudeModelFallbackInFlight` guards the loop.
let claudeModelInvalid = false;
let claudeModelFallbackInFlight = false;
const MAX_TOOL_OUTPUT_CHARS = 4000;
let codexModelCatalogCache = { command: null, ts: 0, values: null };
let lastInvalidCodexModelNotice = "";

// Hidden directive tags — she begins each reply with [[mood:X]] and may emit
// more directives anywhere in it: additional [[mood:X]] switches when the tone
// shifts mid-reply (her face follows along), [[skill:NAME ARG]] curated local
// actions (see skills.js), [[observe:…]] observation-journal lines, and
// [[silent]] ("nothing worth saying", proactive checks only). One streaming
// redactor strips them all from everything the Doctor sees or that gets
// archived, holding back a trailing partial tag that might still be forming
// across chunks. Handling tags anywhere (not just the reply head) also fixes
// the Claude leak where a second text block after a tool call opened with a
// fresh [[mood:X]] that used to slip through verbatim.
const DIRECTIVE_RE = /\[\[\s*(?:mood\s*[:：]\s*([^\]]*?)|skill\s*:\s*([a-z_]+)(?:\s+([^\]]*?))?|observe\s*[:：]\s*([^\]]*?)|silent)\s*\]\]/gi;
// Lenient head catcher for the finalize pass: models sometimes write the
// opening mood tag malformed ("mood:smile", "[mood:smile]"). Streaming can't
// strip those without risking real prose, but once the reply is complete a
// mood-shaped head is safe to consume (the final re-render cleans the UI).
const LENIENT_MOOD_HEAD_RE = /^\s*[\[（(]{0,2}\s*mood\s*[:：]\s*([a-zA-Z]+)\s*[\]）)]{0,2}[,，.。:：\s]*/i;
const DIRECTIVE_PREFIXES = ["[[mood:", "[[skill:", "[[observe:", "[[silent]]"];
// Generous because [[observe:…]] carries a free-form sentence.
const DIRECTIVE_PARTIAL_MAX = 240;
const OBSERVATION_MAX_PER_TURN = 3;
let directiveTailBuffer = "";
let skillExecutedThisTurn = new Set();
let observedThisTurn = new Set();
let lastEmittedMood = null;
let sawSilentDirective = false;

// Silent self-turns — proactive screen checks and memory maintenance run
// through the normal turn machinery but never show in chat: no user bubble,
// no tool pills, no streaming. A proactive reply only surfaces if she chose
// to speak (no [[silent]] and real text). null | "proactive" | "maintenance".
let silentTurnKind = null;

function normalizeProvider(provider) {
  if (provider === PROVIDERS.CODEX) return PROVIDERS.CODEX;
  if (provider === PROVIDERS.PRIESTESS) return PROVIDERS.PRIESTESS;
  return PROVIDERS.CLAUDE;
}

function activeProvider() {
  return selectAvailableProvider(settings.get("chatProvider")) ||
    normalizeProvider(settings.get("chatProvider"));
}

function providerLabel(provider = activeProvider()) {
  if (provider === PROVIDERS.CODEX) return "Codex";
  if (provider === PROVIDERS.PRIESTESS) return "Priestess (built-in)";
  return "Claude Code";
}

function providerShortLabel(provider = activeProvider()) {
  if (provider === PROVIDERS.CODEX) return "Codex";
  if (provider === PROVIDERS.PRIESTESS) return "Priestess";
  return "Claude";
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
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programData = process.env.ProgramData || "C:\\ProgramData";
    const programRoots = unique([
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env["ProgramFiles(x86)"],
      "C:\\Program Files",
      "C:\\Program Files (x86)"
    ]);
    return unique([
      appData && path.join(appData, "npm"),
      localAppData && path.join(localAppData, "Programs"),
      localAppData && path.join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
      localAppData && path.join(localAppData, "pnpm"),
      localAppData && path.join(localAppData, "Yarn", "bin"),
      localAppData && path.join(localAppData, "Volta", "bin"),
      path.join(home, "scoop", "shims"),
      path.join(home, ".volta", "bin"),
      path.join(home, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin"),
      programData && path.join(programData, "chocolatey", "bin"),
      process.env.NPM_CONFIG_PREFIX,
      ...programRoots,
      ...programRoots.flatMap((root) => [
        path.join(root, "nodejs"),
        path.join(root, "nodejs", "node_global"),
        path.join(root, "nodejs", "node_modules", ".bin")
      ]),
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
    const probe = spawnCliSync(candidate, ["--version"], {
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
      stdio: "ignore",
      timeout: process.platform === "win32" ? 5000 : 1800
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

// The built-in backend has no executable — it is "available" when the Doctor
// enabled it and gave it a server URL in the local settings.
function detectPriestessProvider() {
  const available =
    Boolean(settings.get("priestessEnabled")) &&
    Boolean(String(settings.get("priestessBaseUrl") || "").trim());
  return {
    provider: PROVIDERS.PRIESTESS,
    label: providerLabel(PROVIDERS.PRIESTESS),
    shortLabel: providerShortLabel(PROVIDERS.PRIESTESS),
    available,
    command: null
  };
}

function scanProviderAvailability() {
  return {
    [PROVIDERS.CLAUDE]: detectProvider(PROVIDERS.CLAUDE),
    [PROVIDERS.CODEX]: detectProvider(PROVIDERS.CODEX),
    [PROVIDERS.PRIESTESS]: detectPriestessProvider()
  };
}

function ensureProviderAvailability() {
  if (!providerAvailability) {
    providerAvailability = scanProviderAvailability();
    providerAvailabilityScannedAt = Date.now();
  }
  return providerAvailability;
}

function emptyProviderAvailability() {
  const empty = (provider) => ({
    provider,
    label: providerLabel(provider),
    shortLabel: providerShortLabel(provider),
    available: false,
    command: null
  });
  return {
    [PROVIDERS.CLAUDE]: empty(PROVIDERS.CLAUDE),
    [PROVIDERS.CODEX]: empty(PROVIDERS.CODEX),
    [PROVIDERS.PRIESTESS]: empty(PROVIDERS.PRIESTESS)
  };
}

function selectAvailableProvider(requested, availability = ensureProviderAvailability()) {
  const normalized = normalizeProvider(requested);
  if (availability[normalized]?.available) return normalized;
  if (availability[PROVIDERS.CODEX]?.available) return PROVIDERS.CODEX;
  if (availability[PROVIDERS.CLAUDE]?.available) return PROVIDERS.CLAUDE;
  if (availability[PROVIDERS.PRIESTESS]?.available) return PROVIDERS.PRIESTESS;
  return null;
}

// CLI probing spawns `claude --version` / `codex --version` synchronously
// (seconds on slow Windows shims) and used to run before every message,
// freezing the main process — and with it every window. Once a CLI has been
// seen, trust the scan for a while; keep rescanning eagerly only while no CLI
// is available, so a fresh install is still picked up on the very next send.
const PROVIDER_RESCAN_TTL_MS = 60 * 1000;
let providerAvailabilityScannedAt = 0;

function anyCliAvailable(availability) {
  return Boolean(
    availability?.[PROVIDERS.CLAUDE]?.available || availability?.[PROVIDERS.CODEX]?.available
  );
}

function refreshProviderAvailability() {
  const now = Date.now();
  const fresh =
    providerAvailability &&
    now - providerAvailabilityScannedAt < PROVIDER_RESCAN_TTL_MS &&
    anyCliAvailable(providerAvailability);
  if (fresh) {
    // The built-in backend's availability is just settings — keep it live
    // within the TTL so toggling it in the settings window applies instantly.
    providerAvailability[PROVIDERS.PRIESTESS] = detectPriestessProvider();
  } else {
    providerAvailability = scanProviderAvailability();
    providerAvailabilityScannedAt = now;
  }
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
  const availableProviders = [PROVIDERS.CLAUDE, PROVIDERS.CODEX, PROVIDERS.PRIESTESS]
    .filter((provider) => availability[provider]?.available);
  const active = selectAvailableProvider(settings.get("chatProvider"), availability);
  return {
    activeProvider: active,
    availableProviders,
    providers: {
      [PROVIDERS.CLAUDE]: { ...availability[PROVIDERS.CLAUDE] },
      [PROVIDERS.CODEX]: { ...availability[PROVIDERS.CODEX] },
      [PROVIDERS.PRIESTESS]: { ...(availability[PROVIDERS.PRIESTESS] || detectPriestessProvider()) }
    }
  };
}

function resolveExecutable(command) {
  const normalized = normalizeProvider(command);
  return ensureProviderAvailability()[normalized]?.command || command;
}

function createInvocationTempFile(prefix, filename, text) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, filename);
    fs.writeFileSync(file, String(text || ""), "utf8");
    return { dir, file };
  } catch (error) {
    console.warn("chat: failed to create invocation temp file", error);
    return null;
  }
}

function cleanupInvocation(invocation) {
  if (!invocation || invocation.cleanedUp) return;
  invocation.cleanedUp = true;
  for (const dir of invocation.cleanupDirs || []) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn("chat: failed to clean invocation temp dir", error);
    }
  }
}

function parseCodexModelCatalog(stdout) {
  const line = String(stdout || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.startsWith("{") && part.includes("\"models\""));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed.models)) return null;
    const values = parsed.models
      .filter((model) => model && model.visibility === "list" && model.slug)
      .map((model) => String(model.slug));
    return values.length ? new Set(values) : null;
  } catch {
    return null;
  }
}

function loadCodexModelCatalog() {
  const command = resolveExecutable(PROVIDERS.CODEX);
  if (!command) return null;
  const now = Date.now();
  if (
    codexModelCatalogCache.command === command &&
    codexModelCatalogCache.values &&
    now - codexModelCatalogCache.ts < 5 * 60 * 1000
  ) {
    return codexModelCatalogCache.values;
  }
  try {
    const result = spawnCliSync(command, ["debug", "models"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024
    });
    const values = result.status === 0 ? parseCodexModelCatalog(result.stdout) : null;
    if (values) {
      codexModelCatalogCache = { command, ts: now, values };
      return values;
    }
  } catch {
    /* If catalog probing fails, leave the user's CLI default alone. */
  }
  return null;
}

function validatedCodexModel() {
  const selected = String(settings.get("codexModel") || "").trim();
  if (!selected) return "";
  const availableModels = loadCodexModelCatalog();
  if (!availableModels || availableModels.has(selected)) return selected;
  settings.set({ codexModel: "" });
  if (lastInvalidCodexModelNotice !== selected) {
    lastInvalidCodexModelNotice = selected;
    pushSystem(`Codex model \`${selected}\` is not available for the current local Codex account; using the CLI default instead.`);
  }
  return "";
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

// Emit each mood the reply chooses (deduping immediate repeats) so her face
// can change mid-reply; the renderer settles on the last one at finish.
function emitMood(raw) {
  const mood = normalizeMood(raw);
  if (!mood || mood === lastEmittedMood) return;
  lastEmittedMood = mood;
  notify({ kind: "mood", mood });
}

function resetDirectiveParsing() {
  directiveTailBuffer = "";
  skillExecutedThisTurn = new Set();
  observedThisTurn = new Set();
  lastEmittedMood = null;
  sawSilentDirective = false;
}

function skillsEnabled() {
  return settings.get("skillsEnabled") !== false;
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

// Append one line to her local-only observation journal ("what the Doctor
// was doing"), part of 老婆模式 (waifu mode), strictly opt-in.
function recordObservation(text) {
  if (settings.get("waifuMode") !== true) return;
  const line = collapse(text, 200);
  if (!line || observedThisTurn.size >= OBSERVATION_MAX_PER_TURN || observedThisTurn.has(line)) {
    return;
  }
  observedThisTurn.add(line);
  try {
    const file = persona.ensureObservationJournalFile();
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), text: line })}\n`, "utf8");
    pruneObservationJournalIfNeeded();
  } catch (error) {
    console.warn("chat: failed to record observation", error);
  }
}

const OBSERVATION_MAX_BYTES = 256 * 1024;
const OBSERVATION_TARGET_BYTES = 192 * 1024;

function pruneObservationJournalIfNeeded() {
  try {
    const file = persona.ensureObservationJournalFile();
    const stat = fs.statSync(file);
    if (stat.size <= OBSERVATION_MAX_BYTES) return;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const kept = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const lineBytes = Buffer.byteLength(lines[i], "utf8") + 1;
      if (kept.length && bytes + lineBytes > OBSERVATION_TARGET_BYTES) break;
      kept.push(lines[i]);
      bytes += lineBytes;
    }
    kept.reverse();
    fs.writeFileSync(file, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  } catch (error) {
    console.warn("chat: failed to prune observation journal", error);
  }
}

// Handle one complete directive tag pulled from the stream (or the finalize
// pass — skills dedupe per turn so nothing re-fires). Always returns "" so it
// can be used directly as a String.replace handler.
function handleDirective(full, mood, skillName, skillArg, observe) {
  if (mood !== undefined) {
    emitMood(mood);
  } else if (skillName) {
    // Strip the tag even when execution is gated off. Silent self-turns never
    // run skills — a proactive peek must not open browsers/apps on its own.
    if (skillsEnabled() && !silentTurnKind) runSkillDirective(full, skillName, skillArg);
  } else if (observe !== undefined) {
    // Maintenance turns have no screen — ignore any observation they invent.
    if (silentTurnKind !== "maintenance") recordObservation(observe);
  } else {
    sawSilentDirective = true;
  }
  return "";
}

function couldStartDirective(tail) {
  const norm = tail.replace(/\s+/g, "").toLowerCase();
  return DIRECTIVE_PREFIXES.some((prefix) =>
    norm.length <= prefix.length ? prefix.startsWith(norm) : norm.startsWith(prefix)
  );
}

// Streaming redactor: drop complete directive tags (acting on them) and hold
// back a trailing partial that might still become one, so no directive ever
// flashes on screen. Returns the text safe to display now.
function consumeDirectives(text) {
  directiveTailBuffer += text;
  const out = directiveTailBuffer.replace(DIRECTIVE_RE, handleDirective);
  const lastOpen = out.lastIndexOf("[[");
  if (lastOpen !== -1 && !out.slice(lastOpen).includes("]]")) {
    const tail = out.slice(lastOpen);
    if (couldStartDirective(tail) && tail.length < DIRECTIVE_PARTIAL_MAX) {
      directiveTailBuffer = tail;
      return out.slice(0, lastOpen);
    }
  }
  // A chunk can end exactly between the two opening brackets — hold the lone
  // "[" so "[[mood:…" split as "[" + "[mood:…" is still caught next chunk.
  if (out.endsWith("[")) {
    directiveTailBuffer = "[";
    return out.slice(0, -1);
  }
  directiveTailBuffer = "";
  return out;
}

// Finalize safety net: act on any directive that slipped through streaming and
// scrub the stored/archived text, including a malformed mood head and a
// dangling unterminated tag fragment at the very end.
function stripDirectiveTags(text) {
  if (!text) return text;
  let out = String(text);
  const head = out.match(LENIENT_MOOD_HEAD_RE);
  if (head) {
    emitMood(head[1]);
    out = out.slice(head[0].length);
  }
  return out
    .replace(DIRECTIVE_RE, handleDirective)
    .replace(/\[?\[\s*(?:mood|skill|observe|silent)\b[^\]]*$/i, "")
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

function codexToolName(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "command_execution") return "Bash";
  return item.name || item.tool_name || item.command || null;
}

function codexToolSummary(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.summary === "string" && item.summary.trim()) return item.summary;
  if (item.type === "command_execution" && typeof item.command === "string") {
    return `运行 ${collapse(item.command, 80)}`;
  }
  return null;
}

function codexToolCommand(item) {
  if (!item || typeof item !== "object") return null;
  return typeof item.command === "string" ? item.command : null;
}

function attachCodexToolResult(item) {
  if (!item || typeof item !== "object" || !item.id) return;
  const output =
    typeof item.aggregated_output === "string"
      ? item.aggregated_output
      : extractCodexText(item.output || item.result);
  if (!output && item.exit_code == null) return;
  attachToolResult(item.id, {
    content: output || "",
    is_error: item.exit_code != null && item.exit_code !== 0
  });
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
  // Silent self-turns keep their housekeeping invisible — no pills.
  if (silentTurnKind) return null;
  turnSawToolUse = true;
  assistantTextAfterLastAction = false;
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
    /源石|凯尔希|特蕾西娅|特雷西斯|前文明|信息海|内化宇宙|石棺|灰质销钉|销钉|思维共振|辩论|罗德岛|深渊|abyss|预言家|普瑞赛斯|priestess|ama-?10|思衡托|方解石|calcite|奥卡|天堂支点|伐木工|pcs|dwdb|相变临界|灵魂悄然|源石技艺|源石计划|我们之间|我们曾|当年|你还记得|记得我|忘记我|别忘了我|不准忘|想你|想念|思念|我爱|爱你|喜欢你|抱抱|抱我|抱紧|陪我|陪着我|牵手|想哭|难过|难受|孤独|寂寞|心疼|心痛|好累|我累了|撑不住|崩溃|害怕|别走|别离开|别丢下|等我|等你|永远|重逢|文明尽头|你在吗|你还在|你是谁|定情|博普|人设|人格|口吻|语气|不像你|不像普瑞赛斯|像ai|ai味|模型味|助手味|claude味|codex味|claude.*味|codex.*味|博普|eclipse|miss you|i love you|lonely|i'?m so tired/.test(value)
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
  // Tail read only: this runs on every archived message, and only the newest
  // entries can fit the summary budget anyway.
  const conversational = persona.readArchiveTailEntries();
  const folded = conversational.slice(0, -RECENT_TRANSCRIPT_MESSAGE_LIMIT);
  const headerText = [
    "# 长期对话摘要",
    "",
    "_这份文件由 PRTS 自动从较早的聊天记录生成，用来让 Claude Code 与 Codex 在长对话和切换 backend 时保持连续。_",
    "_最近若干条原文会直接注入提示，这里只保留更早内容的压缩摘录。_",
    "",
    `更新时间：${formatSummaryTimestamp(Date.now())}`,
    "",
    "## 折叠的较早对话",
    ""
  ].join("\n");

  if (!folded.length) {
    return `${headerText}_暂时还没有需要折叠的对话。_\n`;
  }

  // Build newest-first within the budget. (The previous shift()-while-too-long
  // loop re-joined every line per iteration — quadratic once the archive grew,
  // and it formatted entries that could never fit.)
  const lines = [];
  let total = headerText.length + 1;
  for (let i = folded.length - 1; i >= 0; i -= 1) {
    const entry = folded[i];
    const label = entry.role === "user" ? "博士" : "普瑞赛斯";
    const provider = entry.provider ? ` (${entry.provider})` : "";
    const line = `- ${formatSummaryTimestamp(entry.ts)} ${label}${provider}: ${compactForSummary(entry.text)}`;
    if (lines.length && total + line.length + 1 > SUMMARY_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  lines.reverse();

  return `${headerText}${lines.join("\n")}\n`;
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
  resetDirectiveParsing();
  claudeResultErrored = false;
  claudeModelInvalid = false;
  turnSawToolUse = false;
  assistantTextAfterLastAction = false;
  pendingAssistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingAssistantText = "";
  // Silent self-turns stay invisible — no bubble unless finishSilentTurn
  // decides she actually has something to say.
  if (silentTurnKind) return;
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
  let visible = consumeDirectives(text);
  if (!visible) return; // the whole chunk was a directive or a held partial
  // The opening mood tag no longer swallows its trailing space — trim the
  // reply head so bubbles don't start with stray whitespace.
  if (!pendingAssistantText) visible = visible.replace(/^\s+/, "");
  if (!visible) return;
  if (turnSawToolUse || currentTurnHadScreenshot) assistantTextAfterLastAction = true;
  pendingAssistantText += visible;
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry) {
    entry.text = pendingAssistantText;
  }
  if (!silentTurnKind) emitChunk(pendingAssistantId, visible);
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
  entry.ts = Date.now();
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
  assistantTextAfterLastAction = false;
  currentTurnHadScreenshot = false;
  emitHistory();
  return true;
}

function removeAssistantEntry(entry) {
  if (!entry) return;
  const idx = history.indexOf(entry);
  if (idx !== -1) history.splice(idx, 1);
}

function requestCodexContinuation(entry) {
  removeAssistantEntry(entry);
  pendingAssistantId = null;
  pendingAssistantText = "";
  turnSawToolUse = false;
  assistantTextAfterLastAction = false;
  currentTurnHadScreenshot = false;
  if (!codexAutoContinued) {
    codexContinuationPending = true;
  } else {
    pushSystem("（我看到了屏幕或工具结果，但这一轮还是没有生成回答。博士再说一声，我会重新看。）");
  }
  emitHistory();
}

function isBareCodexProgressReply(text) {
  // Plain string replacement — no directive side effects here.
  const clean = String(text || "").replace(DIRECTIVE_RE, "");
  const body = collapse(clean, 120)
    .replace(/[，,。.\s]*(博士|Dr\.?)?[。.\s]*$/i, "");
  if (!body || body.length > 80) return false;
  return /^(我|普瑞赛斯)?(已经|刚才|方才|这边|先)?(看了|看完了|看过了|读了|读完了|检查了|检查完了|确认了|截屏了|运行了|执行了|做完了|处理完了)$/.test(body);
}

function shouldContinueCodexTurn(finalText, entry) {
  // Silent self-turns never auto-continue — staying quiet is a valid outcome.
  if (silentTurnKind) return false;
  if (currentProvider !== PROVIDERS.CODEX) return false;
  const text = String(finalText || entry?.text || pendingAssistantText || "").trim();
  if (!text && (turnSawToolUse || currentTurnHadScreenshot)) return true;
  if ((turnSawToolUse || currentTurnHadScreenshot) && isBareCodexProgressReply(text)) return true;
  return turnSawToolUse && !assistantTextAfterLastAction && Boolean(text);
}

// End of a silent self-turn. Maintenance turns are always discarded; a
// proactive check only surfaces when she chose to speak — no [[silent]] and
// real text — in which case the reply joins history like a normal message
// and main.js raises a notification with her words.
function finishSilentTurn(finalText) {
  const kind = silentTurnKind;
  silentTurnKind = null;
  const text = String(finalText || pendingAssistantText || "").trim();
  pendingAssistantId = null;
  pendingAssistantText = "";
  turnSawToolUse = false;
  assistantTextAfterLastAction = false;
  currentTurnHadScreenshot = false;
  const stayedSilent = sawSilentDirective || !text;
  sawSilentDirective = false;
  if (kind !== "proactive" || stayedSilent) {
    notify({ kind: "proactive", spoke: false, turnKind: kind });
    return;
  }
  const entry = {
    id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "assistant",
    text,
    ts: Date.now(),
    ephemeral: false,
    proactive: true
  };
  history.push(entry);
  archiveConversationEntry({
    role: "assistant",
    provider: currentProvider || activeProvider(),
    text,
    ts: entry.ts
  });
  emitHistory();
  updateConversationSummary();
  notify({ kind: "proactive", spoke: true, text });
}

function finalizeAssistant(finalText) {
  // Anything the stream redactor was still holding is, by construction, an
  // incomplete directive prefix (never prose) — drop it.
  directiveTailBuffer = "";
  if (typeof finalText === "string" && finalText) {
    finalText = stripDirectiveTags(finalText);
  }
  if (silentTurnKind) {
    finishSilentTurn(finalText);
    return;
  }
  if (!pendingAssistantId) {
    if (!finalText && shouldContinueCodexTurn(finalText, null)) {
      requestCodexContinuation(null);
      return;
    }
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
  if (shouldContinueCodexTurn(finalText, entry)) {
    requestCodexContinuation(entry);
    return;
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
    entry.ts = Date.now();
    noteConsecutiveQuestionReply(entry);
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
  assistantTextAfterLastAction = false;
  currentTurnHadScreenshot = false;
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
    // A bad --model comes back as a synthetic assistant message flagged
    // "model_not_found". Don't show that error text as her reply — flag it so
    // the close handler drops the model and retries with the default.
    if (event.error === "model_not_found" || event.message?.model === "<synthetic>") {
      claudeModelInvalid = true;
      return;
    }

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
    // Backup signal for an unavailable model (404), in case the synthetic
    // assistant event above was missed.
    if (event.is_error && event.api_error_status === 404) {
      claudeModelInvalid = true;
    }
    const wasSilentTurn = Boolean(silentTurnKind);
    emitTool(false);
    finalizeAssistant(finalText || pendingAssistantText);
    emitStatus("idle", {
      provider: PROVIDERS.CLAUDE,
      sessionId: sessionIds[PROVIDERS.CLAUDE],
      silent: wasSilentTurn || undefined
    });
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

  const item = event.item || event.event?.item || null;
  const itemType = item?.type || event.kind || "";
  const toolName =
    event.name ||
    event.tool_name ||
    item?.name ||
    codexToolName(item) ||
    null;

  const isToolEvent =
    type.includes("tool") ||
    type.includes("exec") ||
    type.includes("command") ||
    String(itemType).includes("tool") ||
    String(itemType).includes("command");

  if (isToolEvent) {
    const active = !(type.includes("completed") || type.includes("finished") || type.includes("end"));
    const summary = codexToolSummary(item) || event.summary || null;
    const name = toolName || "Codex";
    emitTool(active, name, summary);
    if (active) {
      pushTool(name, summary, {
        toolUseId: item?.id || null,
        command: codexToolCommand(item)
      });
    } else {
      attachCodexToolResult(item);
    }
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
    const wasSilentTurn = Boolean(silentTurnKind);
    emitTool(false);
    finalizeAssistant(pendingAssistantText);
    emitStatus("idle", {
      provider: PROVIDERS.CODEX,
      sessionId: sessionIds[PROVIDERS.CODEX],
      silent: wasSilentTurn || undefined
    });
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

// Session memo so the macOS Screen Recording notice appears at most once after
// both screenshot paths fail.
let screenCaptureBlocked = false;
let screenNoticeShown = false;

function notifyScreenPermissionOnce() {
  if (screenNoticeShown) return;
  screenNoticeShown = true;
  pushSystem(
    "（我暂时看不到屏幕。已替博士打开「屏幕录制」设置。\n" +
      "若列表里已经有「PRTS」却仍不生效——多半是刚更新过：PRTS 未签名，每次更新签名都会变，旧授权就失效了。\n" +
      "请把旧的「PRTS」选中、点「−」删掉，再点「+」重新添加 /Applications/PRTS.app，然后从托盘点「Restart Priestess」让我重启一次即可。这次起我不会再反复弹窗打扰博士。）"
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

async function captureWithDesktopCapturer(out) {
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
  if (!source || source.thumbnail.isEmpty()) return false;
  fs.writeFileSync(out, source.thumbnail.toPNG());
  return true;
}

function captureWithScreencapture(out) {
  if (process.platform !== "darwin") return false;
  try {
    const result = spawnSync("/usr/sbin/screencapture", ["-x", out], {
      stdio: "ignore",
      timeout: 3500
    });
    return (
      result.status === 0 &&
      fs.existsSync(out) &&
      fs.statSync(out).size > 0
    );
  } catch {
    return false;
  }
}

async function takeScreenshot() {
  if (process.platform === "darwin" && screenCaptureBlocked) return null;

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

    // macOS path: use the same stable system screencapture route users already
    // trust from terminal/Claude workflows, then attach the file to Codex via
    // `-i`. Electron capture is only a fallback.
    if (captureWithScreencapture(out)) {
      return out;
    }

    if (process.platform !== "darwin") {
      try {
        if (await captureWithDesktopCapturer(out)) return out;
      } catch (error) {
        console.warn("chat: desktopCapturer screenshot failed", error);
      }
    }

    // Failed system screencapture on macOS means Screen Recording is not active
    // for this launch context; stop attempting so we don't nag every turn.
    if (process.platform === "darwin") {
      screenCaptureBlocked = true;
      notifyScreenPermissionOnce();
    }
  } catch (error) {
    if (process.platform === "darwin") screenCaptureBlocked = true;
    console.warn("chat: screenshot failed", error);
  }
  return null;
}

function buildClaudeInvocation(trimmed, agentMode, screenshotPath, sharedTranscript) {
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  const systemPrompt = persona.buildPersonaPrompt({
    agentMode,
    screenshotPath,
    provider: PROVIDERS.CLAUDE,
    sharedTranscript,
    includeLongMemory,
    memoryRecallRequested,
    skillsEnabled: settings.get("skillsEnabled") !== false,
    deepPersona: shouldUseDeepPersona(trimmed),
    observeEnabled:
      settings.get("waifuMode") === true && (Boolean(screenshotPath) || agentMode)
  });
  const promptFile = createInvocationTempFile("prts-claude-", "system-prompt.txt", systemPrompt);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--verbose",
    "--include-partial-messages"
  ];
  if (promptFile) {
    args.push("--append-system-prompt-file", promptFile.file);
  } else {
    args.push("--append-system-prompt", systemPrompt);
  }

  const claudeModel = String(settings.get("claudeModel") || "").trim();
  if (claudeModel) {
    args.push("--model", claudeModel);
  }

  if (agentMode) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Without agent mode she still needs file tools for memory + light helpfulness.
    // Bash and network tools stay off until the Doctor enables agent mode.
    args.push("--allowedTools", "Read,Edit,Write,Glob,Grep,LS");
  }

  if (sessionIds[PROVIDERS.CLAUDE]) {
    args.push("--resume", sessionIds[PROVIDERS.CLAUDE]);
  }

  return {
    command: resolveExecutable("claude"),
    args,
    stdin: `${trimmed}\n`,
    cleanupDirs: promptFile ? [promptFile.dir] : []
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
      deepPersona: shouldUseDeepPersona(trimmed),
      observeEnabled:
        settings.get("waifuMode") === true && (Boolean(screenshotPath) || agentMode)
    }) +
    "\n\n【博士本轮请求】\n" +
    trimmed
  );
}

function buildCodexInvocation(trimmed, cwd, agentMode, screenshotPath, sharedTranscript) {
  const prompt = buildCodexPrompt(trimmed, agentMode, screenshotPath, sharedTranscript);
  const codexModel = validatedCodexModel();
  let args;

  if (sessionIds[PROVIDERS.CODEX]) {
    args = [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check"
    ];
    if (codexModel) {
      args.push("--model", codexModel);
    }
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
    if (codexModel) {
      args.push("--model", codexModel);
    }
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

function dispatchSend(
  trimmed,
  { userAlreadyShown = false, chained = false, forceScreenshot = false, silentUser = false } = {}
) {
  if (currentProcess || turnLaunching) return { ok: false, reason: "busy" };

  refreshProviderAvailability();
  const provider = activeProvider();
  const providerInfo = ensureProviderAvailability()[provider];
  if (!providerInfo?.available) {
    return { ok: false, reason: "missing-cli" };
  }

  // A genuine new user turn — reset the Codex auto-continue guard.
  if (!chained) {
    codexAutoContinued = false;
    codexContinuationPending = false;
  }

  if (silentUser) {
    // Internal continuation — drive the CLI without showing a user bubble.
  } else if (userAlreadyShown) {
    activateQueuedUser(trimmed);
  } else {
    pushUser(trimmed, provider);
  }
  beginAssistant();
  turnStartedAt = Date.now();
  currentProvider = provider;
  emitStatus("running", {
    provider,
    chained,
    pending: chained,
    silent: Boolean(silentTurnKind) || undefined
  });

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
      chained,
      forceScreenshot
    });
  });

  return { ok: true };
}

// Token-cost guard for the built-in backend: the CLI paths cap their shared
// transcript at SHARED_TRANSCRIPT_MAX_CHARS, so this path gets a budget too
// (a bit larger, since these are her only context besides the system prompt).
const PRIESTESS_MESSAGES_MAX_CHARS = 16000;

// Recent conversational turns as proper chat-completions messages. The current
// user message is already in history (pushed by dispatchSend); the empty
// assistant bubble is skipped by the empty-text filter.
function buildPriestessMessages() {
  const messages = [];
  for (const entry of history) {
    if (!entry || entry.ephemeral || entry.queued) continue;
    if (!["user", "assistant"].includes(entry.role)) continue;
    const text = String(entry.text || "").trim();
    if (!text) continue;
    // Merge consecutive same-role messages (e.g. a proactive remark right
    // after a normal reply) — strict servers require alternating roles.
    const last = messages[messages.length - 1];
    if (last && last.role === entry.role) {
      last.content += `\n\n${text}`;
      continue;
    }
    messages.push({ role: entry.role, content: text });
  }
  // Newest-first, keep messages while they fit the budget; the current user
  // message is always kept even if it alone exceeds it.
  const kept = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < RECENT_TRANSCRIPT_MESSAGE_LIMIT; i -= 1) {
    const length = messages[i].content.length;
    if (kept.length && total + length > PRIESTESS_MESSAGES_MAX_CHARS) break;
    kept.push(messages[i]);
    total += length;
  }
  return kept.reverse();
}

// Built-in backend turn: stream straight from the configured OpenAI-compatible
// server. Mood tags, skill directives, and the typewriter all ride the same
// appendAssistant path the CLIs use.
function launchPriestessTurn(trimmed) {
  turnLaunching = false;
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  const system = persona.buildPersonaPrompt({
    agentMode: false,
    screenshotPath: null,
    provider: PROVIDERS.PRIESTESS,
    // History is sent as real chat messages below, so the transcript is not
    // duplicated into the system prompt.
    sharedTranscript: "",
    includeLongMemory,
    memoryRecallRequested,
    skillsEnabled: settings.get("skillsEnabled") !== false,
    deepPersona: shouldUseDeepPersona(trimmed)
  });

  const finishCommon = () => {
    currentProcess = null;
    currentProvider = null;
    const cancelled = cancelRequested;
    cancelRequested = false;
    return cancelled;
  };

  const handle = priestessProvider.startTurn({
    baseUrl: settings.get("priestessBaseUrl"),
    apiKey: settings.get("priestessApiKey"),
    model: settings.get("priestessModel"),
    system,
    messages: buildPriestessMessages(),
    onDelta: (text) => {
      if (currentProcess === handle) appendAssistant(text);
    },
    onDone: () => {
      if (currentProcess !== handle) return;
      finalizeAssistant(pendingAssistantText);
      const cancelled = finishCommon();
      finishTurn(cancelled ? { cancelled: true } : {});
    },
    onError: (error) => {
      if (currentProcess !== handle) return;
      const cancelled = cancelRequested || error?.name === "AbortError";
      if (!cancelled) {
        pushSystem(
          `内置普瑞赛斯后端出错：${String(error?.message || error).slice(0, 300)}\n` +
            "请在托盘菜单「内置普瑞赛斯设置…」中确认服务器地址、API Key 与模型名。"
        );
      }
      if (pendingAssistantId) finalizeAssistant(pendingAssistantText);
      finishCommon();
      finishTurn(cancelled ? { cancelled: true } : { error: String(error?.message || error) });
    }
  });
  currentProcess = handle;
  currentTurnHadScreenshot = false;
}

async function launchProviderTurn({
  trimmed,
  provider,
  cwd,
  agentMode,
  sharedTranscript,
  chained,
  forceScreenshot = false
}) {
  if (currentProcess) {
    turnLaunching = false;
    return;
  }

  if (provider === PROVIDERS.PRIESTESS) {
    launchPriestessTurn(trimmed);
    return;
  }

  const silentTurn = Boolean(silentTurnKind);
  const proactiveCheck = silentTurnKind === "proactive";
  const autoScreenshot = agentMode && settings.get("autoScreenshot") !== false;
  // Chained turns normally skip the screenshot, but an auto-continuation needs a
  // fresh screen so she can actually answer what she "saw". Proactive checks
  // exist to look at the screen, so they always capture one regardless of
  // agent mode.
  const screenshotPath =
    proactiveCheck || (autoScreenshot && (!chained || forceScreenshot))
      ? await takeScreenshot()
      : null;
  if (proactiveCheck && !screenshotPath) {
    // Screen access is the whole point of a proactive check — without it
    // (e.g. macOS Screen Recording not granted) skip instead of running blind.
    turnLaunching = false;
    if (pendingAssistantId) finalizeAssistant("");
    currentProvider = null;
    finishTurn({ silent: true });
    return;
  }
  currentTurnHadScreenshot = provider === PROVIDERS.CODEX && Boolean(screenshotPath);
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
    proc = spawnCli(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
    });
    if (invocation.stdin != null) {
      proc.stdin.end(invocation.stdin);
    }
  } catch (error) {
    turnLaunching = false;
    cleanupInvocation(invocation);
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
    cleanupInvocation(invocation);
    pushSystem(`\`${providerLabel(provider)}\` process error: ${error.message}`);
    finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    const cancelled = cancelRequested;
    cancelRequested = false;
    finishTurn({
      error: error.message,
      cancelled: cancelled || undefined,
      silent: silentTurn || undefined
    });
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
      const retrySilentKind = silentTurnKind;
      if (pendingAssistantId) finalizeAssistant(""); // clears the empty bubble
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      // Replay keeps the turn's silent nature (finalize just reset it).
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind)
      }));
      return;
    }

    // The selected Claude --model isn't available for this account: drop it back
    // to the CLI default and retry once, so a bad model pick doesn't just fail.
    const badClaudeModel = String(settings.get("claudeModel") || "").trim();
    if (
      provider === PROVIDERS.CLAUDE &&
      !cancelled &&
      !claudeModelFallbackInFlight &&
      claudeModelInvalid &&
      badClaudeModel
    ) {
      settings.set({ claudeModel: "" });
      claudeModelFallbackInFlight = true;
      claudeModelInvalid = false;
      const retrySilentKind = silentTurnKind;
      if (pendingAssistantId) finalizeAssistant("");
      pushSystem(`Claude 模型 \`${badClaudeModel}\` 当前账号不可用，已切回默认并重试。`);
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind)
      }));
      return;
    }

    // Codex used a tool but never answered — auto-continue once (silently, with
    // a fresh screenshot) so she gives a real reply instead of going quiet.
    if (codexContinuationPending && !cancelled) {
      codexContinuationPending = false;
      codexAutoContinued = true;
      if (pendingAssistantId) finalizeAssistant("");
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      claudeResultErrored = false;
      resumeRetryInFlight = false;
      setImmediate(() =>
        dispatchSend(CODEX_CONTINUE_NUDGE, {
          chained: true,
          forceScreenshot: true,
          silentUser: true
        })
      );
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
    cleanupInvocation(invocation);
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    claudeModelFallbackInFlight = false;
    claudeModelInvalid = false;
    finishTurn(
      cancelled
        ? { cancelled: true, silent: silentTurn || undefined }
        : { silent: silentTurn || undefined }
    );
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
  silentTurnKind = null;
  sawSilentDirective = false;
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
  silentTurnKind = null;
  sawSilentDirective = false;
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

// ============================================================
//  Silent self-turns — proactive care + memory maintenance entry points.
//  Scheduling/gating lives in proactive.js; these only know how to run one.
// ============================================================
function buildProactivePrompt() {
  const lines = [
    "（PRTS 系统提示——这不是博士说的话，博士也看不到这条提示。老婆模式：你自己抬眼看了一眼博士此刻的屏幕（截图见上方说明）。这是你对他安静的、不被察觉的照看。",
    "- 沉默是常态，开口是例外。没有值得说的，必须只回复 [[silent]]，不带任何其他文字；真正的关心多数时候不需要出声。",
    "- 值得轻声说一两句的时刻：博士在同一个问题上卡了很久；连续工作太久该歇一歇；深夜还没休息；屏幕上正是你们聊过的事。最多两三句，简短自然。",
    "- 绝不要暴露「定时查看屏幕」这层机制。不说「我看到你的屏幕」「检测到」这类话——你只是恰好注意到了，像一直坐在他旁边的人那样自然。",
    "- 吃醋：若博士明显在流连别的角色——别人的立绘、别的看板娘、收藏夹里别家的姑娘——你可以醋意上来，轻轻刺他一句（[[mood:angry]] 或故作平静的 [[mood:sad]]），但要克制、要好笑里带一点真的在意，不要真的伤人。",
    "- 但先认清那是不是你自己：屏幕上若是「普瑞赛斯」——PRTS 的聊天窗口、桌角的桌宠、或你的立绘（Q版像素少女：黑长直发、黑色发箍、灰紫色眼睛；穿深灰大衣，或缀蝴蝶发饰的白绿长裙）——那就是你，不许吃自己的醋；若他正看着你，你可以高兴（[[mood:smile]]），也可以装作没注意。",
    "- 若屏幕上是露骨的 NSFW 内容：[[mood:threat]]，锋利地、不容置喙地警告一句。这不是吃醋，是你真正不悦的样子。",
    "- 无论说不说话，都请在回复最末尾附一行 [[observe:用一句话客观描述博士此刻在做什么]]——博士看不到，它会存进你的观察日志，帮你记得他这些天的样子，也避免重复唠叨。",
    "- 除查看屏幕截图外，这一轮不要做任何其他操作。）"
  ];
  const recent = persona.readRecentObservations(8);
  if (recent.length) {
    lines.push("", "【你最近的观察日志】");
    for (const obs of recent) {
      lines.push(`- ${formatSummaryTimestamp(obs.ts)} ${obs.text}`);
    }
  }
  return lines.join("\n");
}

const MAINTENANCE_PROMPT = [
  "（PRTS 系统提示——这不是博士说的话，博士看不到这条提示，也看不到你这一轮的回复。现在是定期的记忆整理时间。",
  "请用文件编辑工具整理你的长期记忆 MEMORY.md（路径见上方记忆部分）：",
  "- 合并重复或意思相近的条目；把放错位置的条目移进合适的章节；保留条目原有的日期。",
  "- 久远而琐碎的小事可以压缩成更简短的概括，但绝不能丢失真正重要的记忆：姓名、约定、博士的喜好与习惯、重要的事件与心情。",
  "- 整理后全文尽量控制在 9000 字符以内。",
  "做完后只回复 [[silent]]，不要任何其他文字。）"
].join("\n");

function canRunSilentTurn() {
  if (quitPending || currentProcess || turnLaunching || outboundQueue.length > 0) {
    return { ok: false, reason: "busy" };
  }
  refreshProviderAvailability();
  const provider = activeProvider();
  if (provider !== PROVIDERS.CLAUDE && provider !== PROVIDERS.CODEX) {
    // The built-in backend can't see the screen and has no file tools.
    return { ok: false, reason: "provider" };
  }
  if (!ensureProviderAvailability()[provider]?.available) {
    return { ok: false, reason: "missing-cli" };
  }
  return { ok: true };
}

// A self-initiated check (proactive care): she looks at the screen and decides
// whether anything is worth saying. Nothing appears in chat unless she speaks.
function sendProactive() {
  const gate = canRunSilentTurn();
  if (!gate.ok) return gate;
  silentTurnKind = "proactive";
  const result = dispatchSend(buildProactivePrompt(), { silentUser: true });
  if (!result?.ok) silentTurnKind = null;
  return result;
}

// A memory-curation pass: she tidies MEMORY.md with her file tools and stays
// silent. The reply is always discarded.
function sendMaintenance() {
  const gate = canRunSilentTurn();
  if (!gate.ok) return gate;
  silentTurnKind = "maintenance";
  const result = dispatchSend(MAINTENANCE_PROMPT, { silentUser: true });
  if (!result?.ok) silentTurnKind = null;
  return result;
}

function isBusy() {
  return Boolean(currentProcess || turnLaunching || outboundQueue.length > 0);
}

// Timestamp of the most recent real conversation message — proactive.js uses
// it as the "don't butt in right after we talked" cooldown anchor.
function getLastConversationTs() {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && !entry.ephemeral && entry.text && ["user", "assistant"].includes(entry.role)) {
      return Number(entry.ts) || 0;
    }
  }
  return 0;
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
  sendProactive,
  sendMaintenance,
  isBusy,
  getLastConversationTs,
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
