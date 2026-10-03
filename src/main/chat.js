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
const { killProcessTree, spawnCli, spawnCliSync } = require("./cli-spawn");
const {
  attachmentTempName,
  buildCodexExecArgs,
  codexSessionIdFromEvent,
  createBackoffRetry,
  resolveResumeSessionId,
  silentTurnVibeMode,
  silentTurnWantsScreenshot
} = require("./chat-runtime");
const { parseClaudeEffortLevels, claudeHelpSupportsTools, claudeModeToolArgs } = require("./claude-capabilities");
const {
  compatibleReasoningEffort,
  findCatalogModel,
  normalizeCodexVersion,
  parseCodexModelCatalog,
  readCodexModelCatalogFile,
  reasoningEffortsForModel,
  resolveCodexModel
} = require("./codex-model-catalog");
const { claudeReadDenyRules, matchBlacklist, matchClaudeReadDeny, parseBlacklist } = require("./file-blacklist");
const {
  classifyCodexRejection,
  codexEventErrorText,
  isCodexModelMetadataWarning
} = require("./codex-errors");

const PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  CODEX: "codex",
  // Built-in backend: PRTS speaks to an OpenAI-compatible server directly
  // (LiteLLM by default) — no local CLI required. Chat + skills + memory
  // injection work; CLI file tools and agent mode do not apply.
  PRIESTESS: "priestess"
});
const SHARED_TRANSCRIPT_MAX_CHARS = 9000;
const MAX_USER_MESSAGE_CHARS = 100_000;
const RECENT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const SUMMARY_MAX_CHARS = 14000;
const SUMMARY_MESSAGE_MAX_CHARS = 720;
// Codex persists every resumed turn (including our persona and transcript) in
// its own JSONL rollout. Once that file grows large, adding an image can turn a
// normal request into repeated transport reconnects. PRTS already owns bounded
// cross-backend context, so rotate the CLI session before it becomes a burden.
const CODEX_SESSION_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_SESSION_SCAN_MAX_DEPTH = 6;

const subscribers = new Set();
const history = []; // { id, role: 'user' | 'assistant' | 'system' | 'tool', text, ts }

let currentProcess = null;
let pendingAssistantId = null;
let pendingAssistantText = "";
let quitPending = false;
let cancelRequested = false;
// Bumped on every launch. Each turn's stream/close/error callbacks capture the
// value at launch and bail out when it no longer matches, so a cancelled or
// dying turn (its process may linger after Stop) can never finish, pollute or
// double-finish the turn that replaced it. cancel() leaves the token alone:
// the cancelled turn still owns the idle(cancelled) status, exactly once.
let turnToken = 0;
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
let unparsedLinesThisTurn = 0; // cap at 10 to prevent crash-dump flood
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
let codexModelFallbackInFlight = false;
let codexReasoningFallbackInFlight = false;
let codexErrorText = "";
let codexErrorSurfaced = false;
const MAX_TOOL_OUTPUT_CHARS = 4000;
// Live Codex model catalog, see loadCodexModelCatalog(). `ts` is when
// `catalog` was obtained, `failedAt` when the last background probe failed.
const CODEX_CATALOG_TTL_MS = 5 * 60 * 1000;
const CODEX_CATALOG_RETRY_MS = 60 * 1000;
let codexModelCatalogCache = {
  command: null,
  version: "",
  ts: 0,
  catalog: null,
  failedAt: 0,
  refreshing: false
};
let lastInvalidCodexModelNotice = "";
let lastInvalidCodexReasoningNotice = "";
let lastInvalidClaudeReasoningNotice = "";
let claudeHelpProbeCache = { command: null, version: "", levels: null, toolsFlag: true };
const codexSessionFileCache = new Map();

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
const DIRECTIVE_RE = /\[\[\s*(?:mood\s*[:：]\s*([^\]]*?)|skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?|observe\s*[:：]\s*([^\]]*?)|remember\s*[:：]\s*([^\]]*?)|silent)\s*\]\]/gi;
// Lenient head catcher for the finalize pass: models sometimes write the
// opening mood tag malformed ("mood:smile", "[mood:smile]"). Streaming can't
// strip those without risking real prose, but once the reply is complete a
// mood-shaped head is safe to consume (the final re-render cleans the UI).
const LENIENT_MOOD_HEAD_RE = /^\s*[\[（(]{0,2}\s*mood\s*[:：]\s*([a-zA-Z]+)\s*[\]）)]{0,2}[,，.。:：\s]*/i;
// Mid-reply she sometimes drops a bracket ("[[mood:sad] 再后来…"). The strict
// matcher above needs "]]", so such a tag used to stall the partial-hold for
// 240 chars and then leak verbatim with no face change. Treat "]" as closing
// when the next char proves no second "]" is coming — mood ONLY, deliberately:
// a mangled skill tag must never auto-execute. The stream variant requires a
// following char (the tag at the buffer tail may still become "]]"); the
// finalize variant also accepts end-of-text.
const LENIENT_MOOD_STREAM_RE = /\[\[\s*mood\s*[:：]\s*([a-zA-Z]+)\s*\](?=[^\]])[ \t]?/gi;
const LENIENT_MOOD_FINAL_RE = /\[\[\s*mood\s*[:：]\s*([a-zA-Z]+)\s*\](?!\])[ \t]?/gi;
const DIRECTIVE_PREFIXES = ["[[mood:", "[[skill:", "[[observe:", "[[remember:", "[[silent]]"];
// Generous because [[observe:…]] carries a free-form sentence.
const DIRECTIVE_PARTIAL_MAX = 240;
const OBSERVATION_MAX_PER_TURN = 3;
const REMEMBER_MAX_PER_TURN = 3;
let directiveTailBuffer = "";
let skillExecutedThisTurn = new Set();
let observedThisTurn = new Set();
let rememberedThisTurn = new Set();
let lastEmittedMood = null;
let sawSilentDirective = false;

// Silent self-turns — proactive screen checks and memory maintenance run
// through the normal turn machinery but never show in chat: no user bubble,
// no tool pills, no streaming. A proactive reply only surfaces if she chose
// to speak (no [[silent]] and real text). null | "proactive" | "maintenance".
let silentTurnKind = null;
// Whether the current proactive turn carries VS Code editor context; such
// turns are capped at advisor permissions. Set by sendProactive, and kept
// across the self-heal retries (which replay silentTurnKind the same way).
let proactiveEditorContext = false;
// Whether the current proactive turn may look at the screen: only with 老婆模式
// consent. An editor-context check without it runs on VS Code text alone.
let proactiveWantsScreenshot = false;
// Mirrors the chat window's current 普猫猫 visual state (set by main.js when the
// pet→chat transition rolls it). Kept here so the persona prompt can match what
// the Doctor sees. Ephemeral; never persisted.
let chatCatMode = { cat: false, mood: "normal" };

function setChatCatMode(mode) {
  chatCatMode = mode && mode.cat
    ? { cat: true, mood: mode.mood === "crying" ? "crying" : "normal" }
    : { cat: false, mood: "normal" };
}

// Absolute paths of files/images the Doctor attached to the turn currently being
// dispatched (+ button / drag-drop). Set in dispatchSend, read by the invocation
// builders and the persona prompt. Ephemeral; reset every dispatch.
let pendingAttachments = [];

function isImagePath(p) {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i.test(String(p || ""));
}

function findCodexSessionFileInDir(dir, sessionId, depth = 0) {
  if (depth > CODEX_SESSION_SCAN_MAX_DEPTH) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findCodexSessionFileInDir(path.join(dir, entry.name), sessionId, depth + 1);
    if (found) return found;
  }
  return null;
}

function codexSessionFile(sessionId) {
  if (!sessionId) return null;
  const cached = codexSessionFileCache.get(sessionId);
  if (cached) {
    try {
      if (fs.statSync(cached).isFile()) return cached;
    } catch {
      codexSessionFileCache.delete(sessionId);
    }
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  for (const root of roots) {
    const found = findCodexSessionFileInDir(root, sessionId);
    if (found) {
      codexSessionFileCache.set(sessionId, found);
      return found;
    }
  }
  return null;
}

function codexSessionRotationReason(sessionId) {
  if (!sessionId) return "";
  // Image turns are relatively heavy and must not inherit an unbounded CLI
  // rollout. The bounded shared transcript below preserves visible continuity.
  if (pendingAttachments.some(isImagePath)) return "image attachment";
  const file = codexSessionFile(sessionId);
  if (!file) return "";
  try {
    const bytes = fs.statSync(file).size;
    return bytes > CODEX_SESSION_MAX_BYTES ? `rollout ${Math.ceil(bytes / 1024 / 1024)} MB` : "";
  } catch {
    codexSessionFileCache.delete(sessionId);
    return "";
  }
}

function providerSessionPlan(provider) {
  const savedSessionId = sessionIds[provider] || null;
  if (provider !== PROVIDERS.CODEX) {
    return { resumeSessionId: savedSessionId, rotationReason: "" };
  }
  const rotationReason = codexSessionRotationReason(savedSessionId);
  if (rotationReason) {
    console.info(`chat: starting a fresh Codex session (${rotationReason})`);
  }
  return {
    resumeSessionId: rotationReason ? null : savedSessionId,
    rotationReason
  };
}

// Codex gets images as -i image input. Non-image files are inlined into the
// prompt by persona.js (no --add-dir: `codex exec resume` rejects that flag).
function codexAttachmentArgs(attachments) {
  const args = [];
  for (const p of attachments) {
    if (isImagePath(p)) args.push("-i", p);
  }
  return args;
}

// Claude has no image flag — it reads attached images with its Read tool, which
// outside agent mode is sandboxed to the cwd. Grant each image's parent dir so
// Read can reach images dropped from elsewhere (Desktop etc.); without this,
// non-agent turns answer "no photo". Text files are inlined, so only images.
function attachmentDirArgs(images, screenshotPath) {
  const dirs = new Set();
  for (const p of images) dirs.add(path.dirname(p));
  if (screenshotPath) dirs.add(path.dirname(screenshotPath));
  const args = [];
  for (const d of dirs) args.push("--add-dir", d);
  return args;
}

// The file blacklist guards what she reads on her own inside the working
// directory. Files the Doctor attached himself are his explicit choice: they are
// always delivered, and one from inside the working directory that matches the
// list only earns a one-line heads-up in the modes where the list applies.
function blacklistActiveForMode(mode) {
  return mode === "companion" || mode === "advisor";
}

function noteBlacklistedAttachments(files) {
  if (!Array.isArray(files) || !files.length) return;
  if (!blacklistActiveForMode(String(settings.get("vibeCodingMode") || "companion"))) return;
  const patterns = parseBlacklist(settings.get("advisorFileBlacklist"));
  if (!patterns.length) return;
  const root = resolveCwd();
  const hits = [];
  for (const p of files) {
    const pattern = matchBlacklist(p, patterns, { root, outsideRoot: "ignore" });
    if (pattern) hits.push(`${path.basename(p)}（${pattern}）`);
  }
  if (!hits.length) return;
  pushSystem(`提示：附件 ${hits.join("、")} 命中了文件黑名单。这是你亲手附上的，已照常发送。`);
}

// Claude enforcement of the blacklist: companion/advisor turns carry Read deny
// rules (Claude applies Read rules to Grep/Glob too) in a --settings file. A file
// keeps globs, spaces and JSON quotes out of argv, which matters on Windows,
// where a .cmd shim routes every argument through cmd.exe.
// Returns { args, cleanupDir }: cleanupDir is set when a temp dir of its own
// had to be created (it goes away with the turn like the prompt file's).
function claudeReadDenyArgs(mode, promptFile) {
  const none = { args: [], cleanupDir: null };
  if (!blacklistActiveForMode(mode)) return none;
  const rules = claudeReadDenyRules(parseBlacklist(settings.get("advisorFileBlacklist")));
  if (!rules.length) return none;
  const json = JSON.stringify({ permissions: { deny: rules } });
  if (promptFile) {
    try {
      const file = path.join(promptFile.dir, "read-deny-settings.json");
      fs.writeFileSync(file, json, "utf8");
      return { args: ["--settings", file], cleanupDir: null };
    } catch (error) {
      console.warn("chat: failed to write read-deny settings", error);
    }
  }
  const own = createInvocationTempFile("prts-claude-", "read-deny-settings.json", json);
  if (own) return { args: ["--settings", own.file], cleanupDir: own.dir };
  // No temp dir at all. Inline JSON is fine for a real executable, but cmd.exe
  // would mangle its quotes, so on Windows this turn goes unenforced (advisor
  // turns still carry the persona prompt hint).
  if (process.platform === "win32") {
    console.warn("chat: file blacklist not enforced this turn (no temp dir)");
    return none;
  }
  return { args: ["--settings", json], cleanupDir: null };
}

// An attached image is always delivered. When the file (or the downscaled copy
// that would stand in for it) sits where this turn's Claude Read deny rules
// reach, Claude gets a neutrally named temp copy instead, so the Doctor's own
// attachment stays readable while the deny rules keep guarding the workspace.
function claudeAttachmentGuard(provider, mode) {
  if (provider !== PROVIDERS.CLAUDE || !blacklistActiveForMode(mode)) return null;
  const patterns = parseBlacklist(settings.get("advisorFileBlacklist"));
  if (!patterns.length) return null;
  // Compare both spellings of each path: the CLI may resolve symlinks (macOS
  // /tmp -> /private/tmp) or 8.3 names before applying its rules. A file that
  // does not exist yet is resolved through its folder.
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch { /* not there yet */ }
    try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch { return p; }
  };
  const cwd = resolveCwd();
  const roots = [...new Set([cwd, real(cwd)])];
  // Outside the cwd Claude's relative rules deny nothing (seen on macOS). That
  // is unverified on Windows, so there a name match outside the cwd also gets
  // a neutral copy: a needless rename beats an image she cannot open.
  const outsideRoot = process.platform === "win32" ? "basename" : "ignore";
  return (file) => {
    const files = [...new Set([file, real(file)])];
    return roots.some((root) => files.some((f) => matchClaudeReadDeny(f, patterns, { root, outsideRoot }) !== null));
  };
}

function neutralAttachmentName(index, ext) {
  return `${String(index).padStart(2, "0")}-attachment${ext || ".png"}`;
}

// Vision cost + latency scale with pixels, so cap oversized images before they
// go to a backend (a huge screenshot/photo is mostly wasted detail). The Doctor
// still sees the full original in their own bubble; only the backend copy
// shrinks. Returns paths with large images swapped for downscaled temp copies.
// `denied` (from claudeAttachmentGuard) marks paths Claude may not Read.
const ATTACHMENT_MAX_DIM = 1280;

function resolveAttachmentsForBackend(paths, denied = null) {
  if (!paths.some(isImagePath)) return paths;
  let dir = null;
  const tempDir = () => {
    if (!dir) {
      dir = path.join(os.tmpdir(), "prts-attach");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  };
  return paths.map((p, index) => {
    if (!isImagePath(p)) return p;
    try {
      const { nativeImage } = require("electron");
      const img = nativeImage.createFromPath(p);
      const size = img.isEmpty() ? null : img.getSize();
      if (size && Math.max(size.width, size.height) > ATTACHMENT_MAX_DIM) {
        const resized =
          size.width >= size.height
            ? img.resize({ width: ATTACHMENT_MAX_DIM, quality: "good" })
            : img.resize({ height: ATTACHMENT_MAX_DIM, quality: "good" });
        let out = path.join(tempDir(), attachmentTempName(p, index));
        // The copy keeps the original's name, and os.tmpdir() can sit inside
        // the cwd (Windows: %LOCALAPPDATA%\Temp under a home-dir cwd).
        if (denied && (denied(p) || denied(out))) out = path.join(tempDir(), neutralAttachmentName(index, ".png"));
        fs.writeFileSync(out, resized.toPNG());
        return out;
      }
      if (denied && denied(p)) {
        const out = path.join(tempDir(), neutralAttachmentName(index, path.extname(p).toLowerCase()));
        fs.copyFileSync(p, out);
        return out;
      }
      return p;
    } catch {
      return p;
    }
  });
}

// ---- Built-in (HTTP) backend attachments: no file tools, so inline them ----
const PRIESTESS_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PRIESTESS_TEXTFILE_MAX_CHARS = 20000;

function imageToDataUri(p) {
  try {
    if (fs.statSync(p).size > PRIESTESS_IMAGE_MAX_BYTES) {
      console.warn("priestess: image too large to inline, skipping", p);
      return null;
    }
    const ext = path.extname(p).toLowerCase();
    const mime =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".webp" ? "image/webp" :
      ext === ".gif" ? "image/gif" :
      ext === ".bmp" ? "image/bmp" : "image/png";
    return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
  } catch (error) {
    console.warn("priestess: failed to inline image", p, error);
    return null;
  }
}

function readTextFileForInline(p) {
  try {
    if (fs.statSync(p).size > 1024 * 1024) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null; // looks binary — can't inline as text
    let text = buf.toString("utf8");
    if (text.length > PRIESTESS_TEXTFILE_MAX_CHARS) {
      text = text.slice(0, PRIESTESS_TEXTFILE_MAX_CHARS) + "\n…（文件过长，已截断）";
    }
    return text;
  } catch {
    return null;
  }
}

// Fold this turn's attachments into the final user message: images as base64
// image_url (OpenAI vision), text files inlined as text. Whether the configured
// model can actually see images is up to that model.
function applyAttachmentsToPriestessMessages(messages) {
  if (!pendingAttachments.length) return;
  let lastUser = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUser = messages[i];
      break;
    }
  }
  if (!lastUser) return;
  const baseText = typeof lastUser.content === "string" ? lastUser.content : "";
  const imageParts = [];
  let inlined = "";
  for (const p of pendingAttachments) {
    if (isImagePath(p)) {
      const uri = imageToDataUri(p);
      if (uri) imageParts.push({ type: "image_url", image_url: { url: uri } });
    } else {
      const content = readTextFileForInline(p);
      if (content != null) inlined += `\n\n【附件 ${path.basename(p)}】\n${content}`;
    }
  }
  if (imageParts.length) {
    lastUser.content = [{ type: "text", text: baseText + inlined }, ...imageParts];
  } else if (inlined) {
    lastUser.content = baseText + inlined;
  }
}

function normalizeProvider(provider) {
  if (provider === PROVIDERS.CODEX) return PROVIDERS.CODEX;
  if (provider === PROVIDERS.PRIESTESS) return PROVIDERS.PRIESTESS;
  return PROVIDERS.CLAUDE;
}

function activeProvider() {
  return selectAvailableProvider(settings.get("chatProvider")) ||
    normalizeProvider(settings.get("chatProvider"));
}

function neteaseClientPlaybackEnabled() {
  return (
    process.platform === "win32" &&
    settings.get("windowsNeteaseClientControl") === true
  );
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

function installedCodexAppCandidates() {
  if (process.platform !== "darwin") return [];
  const appNames = ["ChatGPT.app", "Codex.app"];
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  return roots.flatMap((root) => appNames.map((appName) =>
    path.join(root, appName, "Contents", "Resources", "codex")
  ));
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
      const entries = fs.readdirSync(root)
        .filter((entry) => entry.startsWith("openai.chatgpt-"))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const entry of entries) {
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
  return [...installedCodexAppCandidates(), ...candidates];
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
  // Respect the executable the user gets in their terminal first. A machine
  // can retain many older VS Code extension bundles; choosing the first
  // directory entry there made PRTS silently run an outdated Codex catalog.
  if (command === PROVIDERS.CODEX) {
    return unique([...pathCandidates, ...binCandidates, ...providerCandidates]);
  }
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

function probeExecutable(candidate) {
  try {
    // The timeout is a ceiling, not a wait — a healthy CLI answers --version
    // in 50-400ms and we return immediately. 5s (formerly 1.8s on mac) only
    // matters for a genuinely slow binary: macOS deep-scans the first exec of
    // a freshly self-updated claude (a ~220MB bundle, shipped near-daily),
    // which regularly blew the old ceiling and made a working CLI look gone.
    const probe = spawnCliSync(candidate, ["--version"], {
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    });
    return {
      ok: !probe.error && probe.status === 0,
      version: `${probe.stdout || ""}\n${probe.stderr || ""}`.trim()
    };
  } catch {
    return { ok: false, version: "" };
  }
}

// Reads `claude --help` once per CLI: the effort levels it exposes and whether
// it has the --tools allowlist (see claudeModeToolArgs). `levels` is a
// definite answer when it is an array (an empty one means an older CLI
// without `--effort`) and is then cached per command + version. null means
// the probe itself failed — it timed out or could not run — so the CLI's
// support is simply unknown: nothing is cached (the next scan asks again) and
// callers must not treat it as "no levels". One 5s stall used to be cached as
// [] and silently wiped the saved claudeReasoningEffort setting. For the
// --tools flag an unreadable help is treated as a current CLI.
function probeClaudeHelp(command, version) {
  if (
    claudeHelpProbeCache.command === command &&
    claudeHelpProbeCache.version === version &&
    Array.isArray(claudeHelpProbeCache.levels)
  ) {
    return claudeHelpProbeCache;
  }
  let levels = null;
  let toolsFlag = true;
  try {
    const result = spawnCliSync(command, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    if (!result.error && result.status === 0) {
      const help = `${result.stdout || ""}\n${result.stderr || ""}`;
      levels = parseClaudeEffortLevels(help);
      toolsFlag = claudeHelpSupportsTools(help);
    }
  } catch {
    levels = null;
  }
  const probed = { command, version, levels, toolsFlag };
  if (Array.isArray(levels)) claudeHelpProbeCache = probed;
  return probed;
}

function detectProvider(provider, previous = null) {
  const normalized = normalizeProvider(provider);
  for (const candidate of executableCandidates(normalized)) {
    try {
      if (canAccessExecutable(candidate)) {
        const probe = probeExecutable(candidate);
        if (!probe.ok) continue;
        if (previous?.command !== candidate || previous?.version !== probe.version) {
          console.info(
            `chat: detected ${providerShortLabel(normalized)} CLI at ${candidate}` +
            (probe.version ? ` (${probe.version})` : "")
          );
        }
        const help = normalized === PROVIDERS.CLAUDE ? probeClaudeHelp(candidate, probe.version) : null;
        return {
          provider: normalized,
          label: providerLabel(normalized),
          shortLabel: providerShortLabel(normalized),
          available: true,
          command: candidate,
          version: probe.version,
          effortLevels: help ? help.levels : [],
          toolsFlag: help ? help.toolsFlag : true
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  // Sticky availability: a CLI that was working moments ago and whose binary
  // is still on disk is almost certainly mid-self-update (claude replaces its
  // bundle near-daily), not uninstalled. A single missed probe used to demote
  // it and silently flip the backend; a genuinely broken CLI still surfaces
  // a visible error on the next send.
  if (previous?.available && previous.command && canAccessExecutable(previous.command)) {
    return { ...previous };
  }
  return {
    provider: normalized,
    label: providerLabel(normalized),
    shortLabel: providerShortLabel(normalized),
    available: false,
    command: null,
    version: "",
    effortLevels: []
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
    command: null,
    version: "",
    effortLevels: []
  };
}

function scanProviderAvailability() {
  const previous = providerAvailability;
  return {
    [PROVIDERS.CLAUDE]: detectProvider(PROVIDERS.CLAUDE, previous?.[PROVIDERS.CLAUDE]),
    [PROVIDERS.CODEX]: detectProvider(PROVIDERS.CODEX, previous?.[PROVIDERS.CODEX]),
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
    command: null,
    version: "",
    effortLevels: []
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
  // Deliberately NO settings.set here: the effective provider is computed per
  // send via selectAvailableProvider, and the tray radio shows activeProvider.
  // Persisting the fallback meant one transient detection miss permanently
  // overwrote the Doctor's chosen backend (a probe that landed during a claude
  // self-update flipped chatProvider to the VS Code codex binary, 2026-06-12).
  // Only an explicit menu click writes chatProvider now.
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

// The model catalog of the active Codex CLI, for validating a pinned model or
// effort before a turn. Never blocks: `codex debug models` used to run
// synchronously here (3s ceiling, twice per turn, and on every turn once it
// had failed), freezing the main process. A turn now only reads the cache,
// seeded from Codex's own models_cache.json and refreshed by a background
// probe at most once per TTL — or once a minute after a failure. A missing
// catalog is not an error: the CLI stays the final authority and the close
// handler heals a rejected pin reactively.
function loadCodexModelCatalog() {
  const info = ensureProviderAvailability()[PROVIDERS.CODEX];
  const command = info?.command;
  if (!command) return null;
  const version = normalizeCodexVersion(info.version);
  const now = Date.now();
  if (codexModelCatalogCache.command !== command || codexModelCatalogCache.version !== version) {
    const seeded = readCodexModelCatalogFile(version);
    codexModelCatalogCache = {
      command,
      version,
      ts: seeded?.length ? now : 0,
      catalog: seeded?.length ? seeded : null,
      failedAt: 0,
      refreshing: false
    };
  }
  const cache = codexModelCatalogCache;
  const stale = !cache.catalog || now - cache.ts >= CODEX_CATALOG_TTL_MS;
  const retryDue = now - cache.failedAt >= CODEX_CATALOG_RETRY_MS;
  if (stale && retryDue && !cache.refreshing) refreshCodexModelCatalogInBackground(cache);
  return cache.catalog;
}

function refreshCodexModelCatalogInBackground(cache) {
  cache.refreshing = true;
  let stdout = "";
  let killed = false;
  let settled = false;
  const settle = (catalog) => {
    if (settled) return;
    settled = true;
    cache.refreshing = false;
    if (catalog?.length) {
      cache.catalog = catalog;
      cache.ts = Date.now();
      cache.failedAt = 0;
    } else {
      cache.failedAt = Date.now();
    }
  };
  try {
    const proc = spawnCli(cache.command, ["debug", "models"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(proc);
    }, 8000);
    if (typeof timer.unref === "function") timer.unref();
    proc.stdout.on("data", (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      settle(code === 0 && !killed ? parseCodexModelCatalog(stdout) : null);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      settle(null);
    });
  } catch {
    settle(null);
  }
}

function validatedCodexModel() {
  const selected = String(settings.get("codexModel") || "").trim();
  if (!selected) return "";
  const catalog = loadCodexModelCatalog();
  if (!catalog || findCatalogModel(catalog, selected)) return selected;
  settings.set({ codexModel: "" });
  if (lastInvalidCodexModelNotice !== selected) {
    lastInvalidCodexModelNotice = selected;
    pushSystem(`Codex model \`${selected}\` is not available for the current local Codex account; using the CLI default instead.`);
  }
  return "";
}

// Call after validatedCodexModel(), which clears a stale pin this then re-reads.
function validatedCodexReasoningEffort() {
  const selected = String(settings.get("codexReasoningEffort") || "").trim();
  if (!selected) return "";
  const catalog = loadCodexModelCatalog();
  if (!catalog) return selected; // No catalog — the CLI is the only authority.

  const { model, certain } = resolveCodexModel(settings.get("codexModel"));
  if (!certain) {
    // Codex picks the model from the account default, which nothing local
    // reports. Guessing one and downgrading from that guess would silently
    // overwrite a valid choice, so only reject a level that no visible model
    // offers — those are stale for certain.
    const advertised = reasoningEffortsForModel(catalog, "", false);
    if (!advertised.length || advertised.includes(selected)) return selected;
    settings.set({ codexReasoningEffort: "" });
    if (lastInvalidCodexReasoningNotice !== selected) {
      lastInvalidCodexReasoningNotice = selected;
      pushSystem(
        `No Codex model in the current catalog supports reasoning effort ` +
        `\`${selected}\`; using the CLI default instead.`
      );
    }
    return "";
  }

  const compatible = compatibleReasoningEffort(findCatalogModel(catalog, model), selected);
  if (compatible === selected) return selected;
  settings.set({ codexReasoningEffort: compatible });
  const noticeKey = `${model}:${selected}`;
  if (lastInvalidCodexReasoningNotice !== noticeKey) {
    lastInvalidCodexReasoningNotice = noticeKey;
    pushSystem(
      `Codex reasoning effort \`${selected}\` is not supported by \`${model}\`; ` +
      `using \`${compatible || "the CLI default"}\` instead.`
    );
  }
  return compatible;
}

function validatedClaudeReasoningEffort() {
  const selected = String(settings.get("claudeReasoningEffort") || "").trim();
  if (!selected) return "";
  const supported = ensureProviderAvailability()[PROVIDERS.CLAUDE]?.effortLevels;
  // null: the help probe failed, so support is unknown. Pass the setting
  // through and let the CLI decide; only a definite "unsupported" clears it.
  if (!Array.isArray(supported) || supported.includes(selected)) return selected;
  settings.set({ claudeReasoningEffort: "" });
  if (lastInvalidClaudeReasoningNotice !== selected) {
    lastInvalidClaudeReasoningNotice = selected;
    pushSystem(
      `Claude Code does not expose the selected \`${selected}\` effort level; ` +
      "using its default instead."
    );
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

// Every launch starts with a clean cancel flag — a Stop that landed on the
// previous turn must not end this one as "cancelled" (which would also skip
// the resume self-heal and the model fallbacks).
function beginTurnToken() {
  cancelRequested = false;
  turnToken += 1;
  return turnToken;
}

function finishTurn(extra = {}) {
  if (!quitPending && outboundQueue.length > 0) {
    emitStatus("running", { chained: true, pending: true });
    setImmediate(() => drainOutboundQueue());
    return;
  }
  emitStatus("idle", extra);
}

// A queued message whose CLI vanished mid-turn (e.g. a self-update swapping the
// binary) is retried on a short backoff: 5s, 10s, 20s, 40s. Each attempt
// rescans the CLIs with synchronous `--version` probes on the main thread, so
// the retry is bounded instead of polling forever.
const outboundRetry = createBackoffRetry({ baseMs: 5000, maxMs: 40000, maxAttempts: 4 });

function drainOutboundQueue() {
  if (quitPending || currentProcess || outboundQueue.length === 0) return;
  // Peek, don't shift yet — if dispatchSend fails (missing-cli, quitting),
  // the message stays in the queue for the next drain attempt.
  const next = outboundQueue[0];
  const result = dispatchSend(next.text, {
    userAlreadyShown: true,
    chained: true,
    attachments: next.attachments || []
  });
  if (result?.ok) {
    outboundRetry.reset();
    outboundQueue.shift();
    emitQueueState();
    return;
  }
  if (result?.reason === "busy" || result?.reason === "quitting") return;
  const scheduled = outboundRetry.schedule(() => {
    if (!quitPending && !currentProcess) drainOutboundQueue();
  });
  if (!scheduled) abandonOutboundQueue(result?.reason || "missing-cli");
}

// Out of retries: drop the queue so the renderer (which ignores "idle" while
// anything is queued) leaves the thinking state, and say what happened. The
// unsent bubbles stay greyed out as queued, so their text can be copied.
function abandonOutboundQueue(reason) {
  const count = outboundQueue.length;
  clearOutboundQueue();
  pushSystem(
    `找不到可用的 Claude Code 或 Codex CLI，排队中的 ${count} 条消息没有发出。` +
      "请确认 CLI 已安装并登录，然后重新发送。"
  );
  emitStatus("idle", { error: reason });
}

function clearOutboundQueue() {
  outboundRetry.reset();
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
  rememberedThisTurn = new Set();
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
function handleDirective(full, mood, skillName, skillArg, observe, remember) {
  if (mood !== undefined) {
    emitMood(mood);
  } else if (skillName) {
    // Strip the tag even when execution is gated off. Silent self-turns never
    // run skills — a proactive peek must not open browsers/apps on its own.
    if (skillsEnabled() && !silentTurnKind) runSkillDirective(full, skillName, skillArg);
  } else if (observe !== undefined) {
    // Maintenance turns have no screen — ignore any observation they invent.
    if (silentTurnKind !== "maintenance") recordObservation(observe);
  } else if (remember !== undefined) {
    // [[remember:…]] writes to MEMORY.md — any mode, no file tools needed.
    // Never on a silent self-turn (the tag is stripped but nothing is written:
    // a proactive peek must not file the screen as a memory), and capped per
    // turn like observations so one reply can't flood the file.
    const text = (remember || "").trim();
    if (
      text &&
      !silentTurnKind &&
      rememberedThisTurn.size < REMEMBER_MAX_PER_TURN &&
      !rememberedThisTurn.has(text)
    ) {
      rememberedThisTurn.add(text);
      persona.appendMemoryEntry(text);
    }
  } else {
    sawSilentDirective = true;
  }
  return "";
}

function couldStartDirective(tail) {
  const norm = tail.replace(/\s+/g, "").replaceAll("：", ":").toLowerCase();
  return DIRECTIVE_PREFIXES.some((prefix) =>
    norm.length <= prefix.length ? prefix.startsWith(norm) : norm.startsWith(prefix)
  );
}

// Streaming redactor: drop complete directive tags (acting on them) and hold
// back a trailing partial that might still become one, so no directive ever
// flashes on screen. Returns the text safe to display now.
function consumeDirectives(text) {
  directiveTailBuffer += text;
  const out = directiveTailBuffer
    .replace(DIRECTIVE_RE, handleDirective)
    .replace(LENIENT_MOOD_STREAM_RE, (_m, mood) => {
      emitMood(mood);
      return "";
    });
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
    .replace(LENIENT_MOOD_FINAL_RE, (_m, mood) => {
      emitMood(mood);
      return "";
    })
    .replace(/\[?\[\s*(?:mood|skill|observe|remember|silent)\b[^\]]*$/i, "")
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

// While a VS Code turn's invocation is being built (buildProviderInvocation
// with turnOptions.onNotice), validator notices go to that bridge's own
// history instead of the popover's.
let systemNoticeSink = null;

function pushSystem(text) {
  if (systemNoticeSink) {
    systemNoticeSink(text);
    return;
  }
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

function pushUser(text, provider = activeProvider(), { ephemeral = false, queued = false, attachments = [] } = {}) {
  const entry = {
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    text,
    provider,
    ts: Date.now(),
    ephemeral: Boolean(ephemeral),
    queued: Boolean(queued)
  };
  // Show what the Doctor attached in their own bubble (renderer renders these).
  if (Array.isArray(attachments) && attachments.length) entry.attachments = attachments.slice();
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
    return entry;
  }
  return null;
}

function findLatestUserEntry(text, provider) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (
      entry?.role === "user" &&
      !entry.queued &&
      entry.text === text &&
      entry.provider === provider
    ) {
      return entry;
    }
  }
  return null;
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

// Append + size prune live in persona.js so the VS Code bridge's archive
// writes go through the same prune as the popover's.
function archiveConversationEntry(entry) {
  if (!entry || !entry.text || !["user", "assistant"].includes(entry.role)) return;
  persona.appendConversationArchiveEntry({
    ts: entry.ts || Date.now(),
    role: entry.role,
    provider: normalizeProvider(entry.provider),
    text: String(entry.text)
  });
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

function buildSharedTranscript({ provider, forceFull = false, excludeEntryId = null, skip = false } = {}) {
  if (skip) return "";
  let entries = history.filter(
    (entry) =>
      entry &&
      !entry.ephemeral &&
      !entry.queued &&
      entry.text &&
      ["user", "assistant"].includes(entry.role)
  );

  // A resumed backend already owns everything through its most recent
  // successful assistant reply. Only bridge messages produced while another
  // backend was active. A fresh/rotated session receives the bounded full tail.
  if (!forceFull && provider) {
    let cursor = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].role === "assistant" && entries[i].provider === provider) {
        cursor = i;
        break;
      }
    }
    if (cursor >= 0) entries = entries.slice(cursor + 1);
  }

  if (excludeEntryId) entries = entries.filter((entry) => entry.id !== excludeEntryId);
  const lines = entries.map((entry) => {
    const label = entry.role === "user" ? "博士" : "普瑞赛斯";
    return `${label}: ${String(entry.text).trim()}`;
  });
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

function beginAssistant(provider = currentProvider || activeProvider()) {
  resetDirectiveParsing();
  claudeResultErrored = false;
  claudeModelInvalid = false;
  codexErrorText = "";
  codexErrorSurfaced = false;
  turnSawToolUse = false;
  assistantTextAfterLastAction = false;
  unparsedLinesThisTurn = 0;
  pendingAssistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingAssistantText = "";
  // Silent self-turns stay invisible — no bubble unless finishSilentTurn
  // decides she actually has something to say.
  if (silentTurnKind) return;
  history.push({
    id: pendingAssistantId,
    role: "assistant",
    text: "",
    provider,
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
    entry = {
      id: pendingAssistantId,
      role: "assistant",
      text: "",
      provider: currentProvider || activeProvider(),
      ts: Date.now(),
      ephemeral: false
    };
    history.push(entry);
  }
  entry.provider = currentProvider || entry.provider || activeProvider();
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
    notify({ kind: "proactive", spoke: false, turnKind: kind, editorContext: proactiveEditorContext });
    return;
  }
  const entry = {
    id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "assistant",
    text,
    provider: currentProvider || activeProvider(),
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
  notify({ kind: "proactive", spoke: true, text, editorContext: proactiveEditorContext });
}

function finalizeAssistant(finalText, opts) {
  // Anything the stream redactor was still holding is, by construction, an
  // incomplete directive prefix (never prose) — drop it.
  const hadError = opts?.hadError === true;
  // The turn is about to be replayed (stale session, rejected model/effort):
  // close its bubble without deciding anything on its behalf. No auto-
  // continuation, no tool-only summary, no proactive notification — the
  // retry finalizes again with the real result. Requesting a continuation
  // here used to leave codexContinuationPending set, and the retried turn
  // then ran an extra nudge turn after it had already answered.
  const retrying = opts?.retrying === true;
  directiveTailBuffer = "";
  if (typeof finalText === "string" && finalText) {
    finalText = stripDirectiveTags(finalText);
  }
  if (silentTurnKind) {
    // When called from a self-heal retry path, suppress the proactive
    // notification — the retry will finalize again with the real result.
    if (!opts?.suppressProactiveNotify && !retrying) {
      finishSilentTurn(finalText);
    }
    return;
  }
  if (!pendingAssistantId) {
    if (!finalText && !retrying && shouldContinueCodexTurn(finalText, null)) {
      requestCodexContinuation(null);
      return;
    }
    if (finalText) {
      beginAssistant();
      appendAssistant(finalText);
    } else {
      // No bubble was opened and no text arrived — if tools ran this turn,
      // speak a short summary of them instead of leaving her silent. Skip
      // when the turn errored — a cheerful summary after a crash is misleading.
      if (!hadError && !retrying) {
        emitToolOnlyFallback();
      }
      return;
    }
  }
  const entry = history.find((h) => h.id === pendingAssistantId);
  if (entry) entry.provider = currentProvider || entry.provider || activeProvider();
  if (entry && finalText && finalText !== entry.text) {
    entry.text = finalText;
  }
  if (!retrying && shouldContinueCodexTurn(finalText, entry)) {
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
    if (!retrying && emitToolOnlyFallback()) return;
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
        // Don't re-emit the tool indicator — the stream_event path already
        // handled it. Just record the tool entry with summary in history.
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

function rememberCodexError(text) {
  const message = String(text || "").trim();
  if (!message) return;
  if (!codexErrorText) {
    codexErrorText = message.slice(0, 4000);
  } else if (!codexErrorText.includes(message)) {
    codexErrorText = `${codexErrorText}\n${message}`.slice(-4000);
  }
}

function handleCodexStreamEvent(event) {
  if (!event || typeof event !== "object") return;

  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" || type.includes("session")) {
    rememberProviderSession(PROVIDERS.CODEX, codexSessionIdFromEvent(event));
  }

  const item = event.item || event.event?.item || null;
  const itemType = item?.type || event.kind || "";
  const eventErrorText = codexEventErrorText(event);
  const isErrorEvent =
    Boolean(eventErrorText) ||
    type.includes("error") ||
    type.endsWith(".failed") ||
    String(itemType).includes("error");
  if (isErrorEvent) {
    const errorText =
      eventErrorText ||
      extractCodexText(event) ||
      (typeof event.message === "string" ? event.message : "") ||
      (typeof event.error === "string" ? event.error : "");
    if (!errorText) return;
    const rejection = classifyCodexRejection(errorText);
    if (isCodexModelMetadataWarning(errorText) && !rejection) return;
    rememberCodexError(errorText);
    if (!rejection) {
      pushSystem(`Codex reported an error: ${String(errorText).slice(0, 400)}`);
      codexErrorSurfaced = true;
    }
    return;
  }

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

// What a turn feeds the persona prompt beyond its text. A popover turn reads
// the module state (pending attachments, cat mode, silent-turn kind). A VS
// Code turn (vscode-chat.js, turnOptions.vscodeTurn) owns a separate history,
// so it passes these explicitly and popover state never leaks into it.
function resolveTurnInputs(turnOptions = {}) {
  if (turnOptions.vscodeTurn) {
    const silentTurn = Boolean(turnOptions.silent);
    return {
      vscodeTurn: true,
      workspacePath: String(turnOptions.workspacePath || ""),
      attachments: Array.isArray(turnOptions.attachments) ? turnOptions.attachments : [],
      catMode: turnOptions.catMode && turnOptions.catMode.cat ? turnOptions.catMode : null,
      silentTurn,
      coauthorCommits: !silentTurn && settings.get("coauthorCommits") !== false
    };
  }
  const silentTurn = Boolean(silentTurnKind);
  return {
    vscodeTurn: false,
    workspacePath: "",
    attachments: silentTurn ? [] : pendingAttachments,
    catMode: silentTurn ? null : chatCatMode,
    silentTurn,
    coauthorCommits: !silentTurn && settings.get("coauthorCommits") !== false
  };
}

function buildClaudeInvocation(trimmed, vibeCodingMode, screenshotPath, sharedTranscript, sessionPlan, customSessionIds, turnOptions = {}) {
  const turn = resolveTurnInputs(turnOptions);
  const mode = vibeCodingMode || "companion";
  const isAgent = mode === "agent";
  const resumeSessionId = resolveResumeSessionId(
    PROVIDERS.CLAUDE,
    sessionPlan,
    customSessionIds
  );
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  const systemPrompt = persona.buildPersonaPrompt({
    vibeCodingMode: mode,
    screenshotPath,
    provider: PROVIDERS.CLAUDE,
    sharedTranscript,
    includeLongMemory,
    memoryRecallRequested,
    skillsEnabled: settings.get("skillsEnabled") !== false,
    deepPersona: shouldUseDeepPersona(trimmed),
    observeEnabled:
      settings.get("waifuMode") === true && (Boolean(screenshotPath) || isAgent),
    personaNotes: settings.get("personaNotes") || "",
    catMode: turn.catMode,
    coauthorCommits: turn.coauthorCommits,
    attachments: turn.attachments,
    neteaseClientPlayback: neteaseClientPlaybackEnabled(),
    workspacePath: turn.workspacePath,
    vscodeTurn: turn.vscodeTurn,
    silentTurn: turn.silentTurn
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
  const claudeReasoningEffort = validatedClaudeReasoningEffort();
  if (claudeReasoningEffort) {
    args.push("--effort", claudeReasoningEffort);
  }

  // Images this turn hands to Claude: the Doctor's attachments (silent turns
  // carry none, matching the persona prompt above) and a screen capture.
  const images = turn.attachments.filter(isImagePath);
  if (isAgent) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Companion: no tools (Read only for an image); advisor: read-only
    // (Read/Grep/Glob); maintenance: file r/w, no Bash or network. The CLI
    // enforces each (see claudeModeToolArgs): the Doctor's settings.json
    // defaultMode and allow rules cannot widen a non-agent turn.
    args.push(...claudeModeToolArgs(mode, {
      needsRead: images.length > 0 || Boolean(screenshotPath),
      toolsFlag: ensureProviderAvailability()[PROVIDERS.CLAUDE]?.toolsFlag !== false
    }));
  }
  const readDeny = claudeReadDenyArgs(mode, promptFile);
  args.push(...readDeny.args);
  // Let Read reach images outside the project dir (attachments, screenshots).
  args.push(...attachmentDirArgs(images, screenshotPath));

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  return {
    command: resolveExecutable("claude"),
    args,
    stdin: `${trimmed}\n`,
    cleanupDirs: [promptFile && promptFile.dir, readDeny.cleanupDir].filter(Boolean),
    resumed: Boolean(resumeSessionId)
  };
}

function buildCodexPrompt(trimmed, vibeCodingMode, screenshotPath, sharedTranscript, turnOptions = {}) {
  const turn = resolveTurnInputs(turnOptions);
  const mode = vibeCodingMode || "companion";
  const isAgent = mode === "agent";
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  return (
    persona.buildPersonaPrompt({
      vibeCodingMode: mode,
      screenshotPath,
      provider: PROVIDERS.CODEX,
      sharedTranscript,
      includeLongMemory,
      memoryRecallRequested,
      skillsEnabled: settings.get("skillsEnabled") !== false,
      deepPersona: shouldUseDeepPersona(trimmed),
      observeEnabled:
        settings.get("waifuMode") === true && (Boolean(screenshotPath) || isAgent),
      personaNotes: settings.get("personaNotes") || "",
      catMode: turn.catMode,
      coauthorCommits: turn.coauthorCommits,
      attachments: turn.attachments,
      neteaseClientPlayback: neteaseClientPlaybackEnabled(),
      workspacePath: turn.workspacePath,
      vscodeTurn: turn.vscodeTurn,
      silentTurn: turn.silentTurn
    }) +
    "\n\n【博士本轮请求】\n" +
    trimmed
  );
}

function buildCodexInvocation(trimmed, cwd, vibeCodingMode, screenshotPath, sharedTranscript, sessionPlan, customSessionIds, turnOptions = {}) {
  const mode = vibeCodingMode || "companion";
  const resumeSessionId = resolveResumeSessionId(
    PROVIDERS.CODEX,
    sessionPlan,
    customSessionIds
  );
  const prompt = buildCodexPrompt(trimmed, mode, screenshotPath, sharedTranscript, turnOptions);
  const codexModel = validatedCodexModel();
  const codexReasoningEffort = validatedCodexReasoningEffort();
  const invocation = buildCodexExecArgs({
    cwd,
    mode,
    resumeSessionId,
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    screenshotPath,
    attachmentArgs: codexAttachmentArgs(resolveTurnInputs(turnOptions).attachments),
    memoryDir: persona.memoryDir()
  });

  return {
    command: resolveExecutable("codex"),
    args: invocation.args,
    stdin: prompt,
    resumed: invocation.resumed
  };
}

// turnOptions.vscodeTurn marks a turn from the VS Code extension (vscode-chat.js):
// it always gets the coding voice and never reads popover state. Such a turn
// passes its own `attachments`, `catMode` and `silent` (see resolveTurnInputs)
// and an `onNotice(text)` that receives the model/effort validator notices
// raised while building, so they land in the VS Code history.
function buildProviderInvocation(provider, trimmed, cwd, vibeCodingMode, screenshotPath, sharedTranscript, sessionPlan, customSessionIds, turnOptions) {
  turnOptions = turnOptions || {};
  // vscode-chat.js already caps the extension at advisor; enforced again here
  // so no caller can hand a VS Code turn the agent flags.
  if (turnOptions.vscodeTurn && vibeCodingMode === "agent") vibeCodingMode = "advisor";
  const previousSink = systemNoticeSink;
  if (turnOptions.vscodeTurn && typeof turnOptions.onNotice === "function") {
    systemNoticeSink = turnOptions.onNotice;
  }
  try {
    if (provider === PROVIDERS.CODEX) {
      return buildCodexInvocation(
        trimmed,
        cwd,
        vibeCodingMode,
        screenshotPath,
        sharedTranscript,
        sessionPlan,
        customSessionIds,
        turnOptions
      );
    }
    return buildClaudeInvocation(trimmed, vibeCodingMode, screenshotPath, sharedTranscript, sessionPlan, customSessionIds, turnOptions);
  } finally {
    systemNoticeSink = previousSink;
  }
}

function send(text, attachments) {
  const files = Array.isArray(attachments)
    ? attachments.filter((p) => typeof p === "string" && p.trim())
    : [];
  let trimmed = String(text ?? "").trim();
  if (!trimmed && files.length === 0) return { ok: false, reason: "empty" };
  if (!trimmed) trimmed = "看看这些。"; // attachments with no text of their own
  if (trimmed.length > MAX_USER_MESSAGE_CHARS) return { ok: false, reason: "too-long" };

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
    outboundQueue.push({ text: trimmed, attachments: files });
    pushUser(trimmed, provider, { queued: true, attachments: files });
    noteBlacklistedAttachments(files);
    emitQueueState();
    return { ok: true, queued: true, queueLength: outboundQueue.length };
  }

  return dispatchSend(trimmed, { attachments: files });
}

function dispatchSend(
  trimmed,
  { userAlreadyShown = false, chained = false, forceScreenshot = false, silentUser = false, vibeCodingMode: vibeCodingModeOverride = null, attachments = [], resolvedAttachments = null } = {}
) {
  if (currentProcess || turnLaunching) return { ok: false, reason: "busy" };
  if (quitPending) return { ok: false, reason: "quitting" };

  refreshProviderAvailability();
  const provider = activeProvider();
  const providerInfo = ensureProviderAvailability()[provider];
  if (!providerInfo?.available) {
    return { ok: false, reason: "missing-cli" };
  }

  // Attachments belong only to this real turn; silent self-turns never carry any.
  // Backend copies get downscaled (faster/cheaper vision); the bubble keeps the
  // full original, which was attached to the history entry above.
  //
  // A retry replays a turn whose images were downscaled already, and hands them
  // back through `resolvedAttachments`. Re-resolving them would be worse than
  // wasteful: the resolver wipes its temp directory the moment it has anything
  // to downscale, which would delete the very files being replayed.
  pendingAttachments = silentTurnKind
    ? []
    : Array.isArray(resolvedAttachments)
      ? resolvedAttachments
      : resolveAttachmentsForBackend(
          Array.isArray(attachments) ? attachments : [],
          // Only real turns carry attachments, so the mode is the Doctor's own.
          claudeAttachmentGuard(provider, vibeCodingModeOverride || String(settings.get("vibeCodingMode") || "companion"))
        );

  // A genuine new user turn — reset the Codex auto-continue guard.
  if (!chained) {
    codexAutoContinued = false;
    codexContinuationPending = false;
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
  }

  let currentUserEntry = null;
  if (silentUser) {
    // Internal continuation — drive the CLI without showing a user bubble.
  } else if (userAlreadyShown) {
    currentUserEntry = activateQueuedUser(trimmed) || findLatestUserEntry(trimmed, provider);
  } else {
    currentUserEntry = pushUser(trimmed, provider, { attachments });
    noteBlacklistedAttachments(attachments);
  }
  const sessionPlan = provider === PROVIDERS.PRIESTESS ? null : providerSessionPlan(provider);
  const sharedTranscript =
    provider === PROVIDERS.PRIESTESS
      ? ""
      : buildSharedTranscript({
          provider,
          forceFull: !sessionPlan.resumeSessionId,
          excludeEntryId: currentUserEntry?.id || null,
          // A Codex tool-turn continuation is already in the same CLI session;
          // replaying transcript data there would duplicate the turn again.
          skip: Boolean(silentUser && chained && sessionPlan.resumeSessionId)
        });
  beginAssistant(provider);
  turnStartedAt = Date.now();
  currentProvider = provider;
  emitStatus("running", {
    provider,
    chained,
    pending: chained,
    silent: Boolean(silentTurnKind) || undefined
  });

  // Silent turns need tools regardless of the Doctor's vibeCodingMode setting.
  // Proactive checks need at least Read (advisor); maintenance needs file r/w;
  // editor-context checks never run above advisor (see silentTurnVibeMode).
  const globalMode = String(settings.get("vibeCodingMode") || "companion");
  let vibeCodingMode = vibeCodingModeOverride || globalMode;
  if (!vibeCodingModeOverride) {
    const silentMode = silentTurnVibeMode(silentTurnKind, globalMode, {
      editorContext: proactiveEditorContext
    });
    if (silentMode) {
      vibeCodingMode = silentMode;
      if (silentMode !== globalMode) {
        console.log("%s turn: overrode vibeCodingMode from %s to %s", silentTurnKind, globalMode, silentMode);
      }
    }
  }

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
      vibeCodingMode,
      sharedTranscript,
      sessionPlan,
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
  const result = kept.reverse();
  // Inline this turn's files/images into the final user message (built-in
  // backend has no file tools). Done after budgeting so the char-length math
  // above keeps working on plain-string content.
  applyAttachmentsToPriestessMessages(result);
  return result;
}

// Built-in backend turn: stream straight from the configured OpenAI-compatible
// server. Mood tags, skill directives, and the typewriter all ride the same
// appendAssistant path the CLIs use.
function launchPriestessTurn(trimmed) {
  turnLaunching = false;
  const turnHadImages = pendingAttachments.some(isImagePath);
  const memoryRecallRequested = shouldIncludeLongMemoryForText(trimmed);
  const includeLongMemory = !longMemoryDormant || memoryRecallRequested;
  const system = persona.buildPersonaPrompt({
    vibeCodingMode: "companion",
    screenshotPath: null,
    provider: PROVIDERS.PRIESTESS,
    // History is sent as real chat messages below, so the transcript is not
    // duplicated into the system prompt.
    sharedTranscript: "",
    includeLongMemory,
    memoryRecallRequested,
    skillsEnabled: settings.get("skillsEnabled") !== false,
    deepPersona: shouldUseDeepPersona(trimmed),
    personaNotes: settings.get("personaNotes") || "",
    catMode: silentTurnKind ? null : chatCatMode,
    neteaseClientPlayback: neteaseClientPlaybackEnabled()
  });

  const finishCommon = () => {
    currentProcess = null;
    currentProvider = null;
    const cancelled = cancelRequested;
    cancelRequested = false;
    return cancelled;
  };

  // cancel() clears currentProcess before aborting (so the next send is not
  // blocked), so the callbacks cannot use handle identity: the AbortError they
  // get afterwards must still finish this turn. The token tells them whether a
  // newer turn has taken over instead.
  const token = beginTurnToken();
  const live = () => token === turnToken;
  const handle = priestessProvider.startTurn({
    baseUrl: settings.get("priestessBaseUrl"),
    apiKey: settings.get("priestessApiKey"),
    model: settings.get("priestessModel"),
    system,
    messages: buildPriestessMessages(),
    onDelta: (text) => {
      if (live() && !cancelRequested) appendAssistant(text);
    },
    onDone: () => {
      if (!live()) return;
      finalizeAssistant(pendingAssistantText);
      const cancelled = finishCommon();
      finishTurn(cancelled ? { cancelled: true } : {});
    },
    onError: (error) => {
      if (!live()) return;
      const cancelled = cancelRequested || error?.name === "AbortError";
      if (!cancelled) {
        pushSystem(
          `内置普瑞赛斯后端出错：${String(error?.message || error).slice(0, 300)}\n` +
            (turnHadImages
              ? "（这一轮发了图片——如果你配的模型不支持看图，请换一个支持视觉的模型，或改用 Claude / Codex 后端。）\n"
              : "") +
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
  vibeCodingMode,
  sharedTranscript,
  sessionPlan,
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
  const isAgent = vibeCodingMode === "agent";
  // When the Doctor attached files this turn, he's pointing her at THOSE — skip
  // the auto-screenshot so a full-screen grab doesn't steal her attention.
  const autoScreenshot =
    isAgent && settings.get("autoScreenshot") !== false && pendingAttachments.length === 0;
  // Chained turns normally skip the screenshot, but an auto-continuation needs a
  // fresh screen so she can actually answer what she "saw". A proactive check
  // captures one regardless of agent mode — but only with 老婆模式 consent
  // (sendProactive); an editor-context check without it stays text-only.
  const proactiveScreenshot = proactiveCheck && proactiveWantsScreenshot;
  const screenshotPath =
    proactiveScreenshot || (autoScreenshot && (!chained || forceScreenshot))
      ? await takeScreenshot()
      : null;
  if (proactiveScreenshot && !screenshotPath) {
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
    vibeCodingMode,
    screenshotPath,
    sharedTranscript,
    sessionPlan
  );
  // Did this turn try to resume a Claude session? If it did and the turn dies
  // with an empty error, the session id is probably stale and we self-heal.
  const launchedWithClaudeSession =
    provider === PROVIDERS.CLAUDE && invocation.resumed;
  let proc;
  try {
    turnLaunching = false;
    proc = spawnCli(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: "1" },
    });
    if (invocation.stdin != null) {
      // A prompt is tens of KB, so it won't clear the pipe buffer in one go. If
      // the CLI dies before draining it (not logged in, bad flag, instant
      // crash), the rest of the write lands as an async EPIPE on stdin — which
      // the try/catch here cannot see, and an unhandled stream error takes the
      // whole main process down. The close/error handlers already report the
      // dead turn, so swallowing it is enough.
      proc.stdin.on("error", () => {});
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
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    codexErrorText = "";
    codexErrorSurfaced = false;
    finishTurn({ error: error.message });
    return;
  }

  const token = beginTurnToken();
  const live = () => token === turnToken;
  // 'error' and 'close' both end the turn; whichever fires first wins (a spawn
  // failure emits both), so the status/idle path runs exactly once.
  let settled = false;
  currentProcess = proc;
  let buffer = "";
  let stderrBuffer = "";

  proc.stdout.on("data", (chunk) => {
    // After Stop (or once a newer turn owns the slot) the dying process's output
    // is noise: a late `result` would otherwise re-adopt a session id that
    // "New Conversation" just dropped, or stream text into the next reply.
    if (!live() || cancelRequested) return;
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
        // Non-JSON line — surface up to 10 per turn; merge overflow into a summary.
        unparsedLinesThisTurn += 1;
        if (unparsedLinesThisTurn <= 10) {
          pushSystem(`Unparsed: ${line.slice(0, 200)}`);
        } else if (unparsedLinesThisTurn === 11) {
          pushSystem("Unparsed: (further non-JSON lines omitted — output may be a crash dump)");
        }
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
  });

  proc.on("error", (error) => {
    if (settled) return;
    settled = true;
    cleanupInvocation(invocation);
    if (!live()) return;
    pushSystem(`\`${providerLabel(provider)}\` process error: ${error.message}`);
    finalizeAssistant("");
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    codexErrorText = "";
    codexErrorSurfaced = false;
    const cancelled = cancelRequested;
    cancelRequested = false;
    finishTurn({
      error: error.message,
      cancelled: cancelled || undefined,
      silent: silentTurn || undefined
    });
  });

  proc.on("close", (code) => {
    if (settled) return;
    settled = true;
    if (!live()) {
      // A newer turn replaced this one while it was dying; its state is no
      // longer ours to touch — only the temp files are.
      cleanupInvocation(invocation);
      return;
    }
    const cancelled = cancelRequested;
    cancelRequested = false;
    if (buffer.trim() && !cancelled) {
      try {
        handleProviderStreamEvent(provider, JSON.parse(buffer.trim()));
      } catch {
        /* ignore trailing junk */
      }
      buffer = "";
    }

    const stderrText = stderrBuffer.trim();
    const codexRejection =
      provider === PROVIDERS.CODEX
        ? classifyCodexRejection(`${codexErrorText}\n${stderrText}`)
        : "";

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
      const retryAttachments = pendingAttachments;
      if (pendingAssistantId) finalizeAssistant("", { suppressProactiveNotify: true });
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind),
        resolvedAttachments: retryAttachments
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
      const retryAttachments = pendingAttachments;
      if (pendingAssistantId) finalizeAssistant("", { suppressProactiveNotify: true });
      pushSystem(`Claude 模型 \`${badClaudeModel}\` 当前账号不可用，已切回默认并重试。`);
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind),
        resolvedAttachments: retryAttachments
      }));
      return;
    }

    // The live catalog is the primary source, but the CLI remains the final
    // authority. If it rejects the selected effort, clear only that override,
    // discard the now-invalid session, and replay the turn once.
    const badCodexReasoning = String(settings.get("codexReasoningEffort") || "").trim();
    if (
      provider === PROVIDERS.CODEX &&
      !cancelled &&
      !codexReasoningFallbackInFlight &&
      codexRejection === "reasoning" &&
      badCodexReasoning
    ) {
      settings.set({ codexReasoningEffort: "" });
      sessionIds[PROVIDERS.CODEX] = null;
      codexReasoningFallbackInFlight = true;
      const retrySilentKind = silentTurnKind;
      // Read now, not inside the callback: pendingAttachments is module state
      // that the next turn overwrites, so a deferred read can replay the wrong
      // images — or none.
      const retryAttachments = pendingAttachments;
      // A continuation requested earlier in this turn (by a stream-level
      // finalize) belongs to the turn being replaced, not to the retry.
      codexContinuationPending = false;
      if (pendingAssistantId) finalizeAssistant("", { retrying: true });
      pushSystem(`Codex 推理强度 \`${badCodexReasoning}\` 不可用，已恢复默认并重试。`);
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind),
        resolvedAttachments: retryAttachments
      }));
      return;
    }

    // Apply the same bounded recovery to a rejected model. Reasoning is checked
    // first so an effort error never clears the independent model preference.
    const badCodexModel = String(settings.get("codexModel") || "").trim();
    if (
      provider === PROVIDERS.CODEX &&
      !cancelled &&
      !codexModelFallbackInFlight &&
      codexRejection === "model" &&
      badCodexModel
    ) {
      settings.set({ codexModel: "" });
      sessionIds[PROVIDERS.CODEX] = null;
      codexModelFallbackInFlight = true;
      const retrySilentKind = silentTurnKind;
      // Read now, not inside the callback: pendingAttachments is module state
      // that the next turn overwrites, so a deferred read can replay the wrong
      // images — or none.
      const retryAttachments = pendingAttachments;
      codexContinuationPending = false;
      if (pendingAssistantId) finalizeAssistant("", { retrying: true });
      pushSystem(`Codex 模型 \`${badCodexModel}\` 不可用，已恢复默认并重试。`);
      cleanupInvocation(invocation);
      currentProcess = null;
      currentProvider = null;
      silentTurnKind = retrySilentKind;
      setImmediate(() => dispatchSend(trimmed, {
        userAlreadyShown: true,
        chained: true,
        silentUser: Boolean(retrySilentKind),
        resolvedAttachments: retryAttachments
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
      const stderrSummary =
        (stderrText || (provider === PROVIDERS.CODEX && !codexErrorSurfaced ? codexErrorText : ""))
          .slice(-400);
      pushSystem(
        `\`${providerLabel(provider)}\` exited with code ${code}.${stderrSummary ? "\n" + stderrSummary : ""}`
      );
    } else if (provider === PROVIDERS.CODEX && codexErrorText && !codexErrorSurfaced) {
      pushSystem(`Codex reported an error: ${codexErrorText.slice(0, 400)}`);
    } else if (claudeResultErrored) {
      pushSystem(
        "Claude 返回了一个空的错误回复。请再试一次，或确认 `claude` CLI 已登录且额度未用尽。"
      );
    }
    const turnHadError = (code !== 0 && code !== null) || claudeResultErrored;
    if (pendingAssistantId) finalizeAssistant("", { hadError: turnHadError });
    cleanupInvocation(invocation);
    currentProcess = null;
    currentProvider = null;
    claudeResultErrored = false;
    resumeRetryInFlight = false;
    claudeModelFallbackInFlight = false;
    claudeModelInvalid = false;
    codexModelFallbackInFlight = false;
    codexReasoningFallbackInFlight = false;
    codexErrorText = "";
    codexErrorSurfaced = false;
    finishTurn(
      cancelled
        ? { cancelled: true, silent: silentTurn || undefined }
        : { silent: silentTurn || undefined }
    );
  });
}

// Stop the running turn (CLI subprocess or built-in backend request). The
// turn's own close/onError callback reports idle(cancelled) once the process
// is really gone; meanwhile the slot is free so the next send is not blocked.
// `sync` (quit/restart paths) makes the Windows taskkill complete before
// returning — app.exit() follows and would otherwise orphan the CLI tree.
function cancel({ sync = false } = {}) {
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  codexErrorText = "";
  codexErrorSurfaced = false;
  if (!currentProcess) return;
  cancelRequested = true;
  const proc = currentProcess;
  currentProcess = null; // unblock future sends immediately
  killProcessTree(proc, { sync });
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
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  codexErrorText = "";
  codexErrorSurfaced = false;
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
  codexModelFallbackInFlight = false;
  codexReasoningFallbackInFlight = false;
  codexErrorText = "";
  codexErrorSurfaced = false;
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
// Without a screenshot (老婆模式 off, VS Code editor context only) the prompt
// must not claim she looked at the screen, and asks for no observation —
// the observation journal is a 老婆模式 feature too.
const PROACTIVE_TEXT_ONLY_PROMPT = [
  "（PRTS 系统提示——这不是博士说的话，博士也看不到这条提示。这一轮没有屏幕截图，你只能看到下面来自 VS Code 的编辑器上下文。这是你对他安静的、不被察觉的照看。",
  "- 沉默是常态，开口是例外。没有值得说的，必须只回复 [[silent]]，不带任何其他文字；真正的关心多数时候不需要出声。",
  "- 绝不要暴露「定时检查」这层机制。不说「检测到」「系统提示」这类话——你只是恰好注意到了，像一直坐在他旁边的人那样自然。",
  "- 除阅读下面的上下文外，这一轮不要做任何其他操作。）"
].join("\n");

function buildProactivePrompt({ screenshot = true } = {}) {
  if (!screenshot) return PROACTIVE_TEXT_ONLY_PROMPT;
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
  "- 写回之前先重新读一遍 MEMORY.md：整理期间可能有新条目被追加进来，不要把它们覆盖掉。",
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
function sendProactive(opts) {
  const gate = canRunSilentTurn();
  if (!gate.ok) return gate;
  silentTurnKind = "proactive";
  proactiveEditorContext = Boolean(
    opts && (opts.diagnosticContext || opts.diagnosticImprovement || opts.terminalEvent || opts.activityContext)
  );
  proactiveWantsScreenshot = silentTurnWantsScreenshot("proactive", { waifuMode: settings.get("waifuMode") });
  const prompt = buildVibeProactivePrompt(opts, { screenshot: proactiveWantsScreenshot });
  const result = dispatchSend(prompt, { silentUser: true });
  if (!result?.ok) silentTurnKind = null;
  return result;
}

// Build a proactive prompt that may include diagnostic or activity context
// from the VS Code extension.
function buildVibeProactivePrompt(opts, promptOpts = {}) {
  if (opts?.diagnosticContext) {
    return buildDiagnosticProactivePrompt(opts.diagnosticContext, promptOpts);
  }
  if (opts?.diagnosticImprovement) {
    return buildImprovementPrompt(opts.diagnosticImprovement, promptOpts);
  }
  if (opts?.terminalEvent) {
    return buildTerminalPrompt(opts.terminalEvent, promptOpts);
  }
  if (opts?.activityContext) {
    return buildActivityProactivePrompt(promptOpts);
  }
  return buildProactivePrompt(promptOpts);
}

function buildImprovementPrompt(diag, promptOpts) {
  const lines = [
    buildProactivePrompt(promptOpts),
    "",
    "博士刚刚修好了代码——编辑器的报错数量降到了 0。",
    "这是他采纳了你的建议、或者自己努力的结果。",
    "用你自然的风格，给一句真诚的、属于普瑞赛斯的肯定。不用长，一两句就够了。",
    "如果只是偶然清零（比如关了文件），可以说 [[silent]]。",
  ];
  return lines.join("\n");
}

// evt comes from ws-policy.normalizeTerminalEvent: a canonical command label
// and an exit code only — raw terminal output never reaches the prompt.
function buildTerminalPrompt(evt, promptOpts) {
  const lines = [
    buildProactivePrompt(promptOpts),
    "",
    `另外，博士刚才在 VS Code 终端里运行的「${evt.command}」失败了（退出码 ${evt.exitCode}）。`,
  ];
  if (evt.kind === "build-error") {
    lines.push("", "看起来构建/编译出错了。用你自然的风格轻声告知博士，可以帮他一起看看错误原因。如果你觉得只是暂时性问题，可以说 [[silent]]。");
  } else if (evt.kind === "test-fail") {
    lines.push("", "看起来测试没通过。用你自然的风格提醒博士，建议他看看失败的测试。如果你觉得只是暂时性问题，可以说 [[silent]]。");
  }
  return lines.join("\n");
}

function buildDiagnosticProactivePrompt(diag, promptOpts) {
  const lines = [
    buildProactivePrompt(promptOpts),
    "",
    "另外，博士的 VS Code 编辑器刚刚检测到以下问题：",
    `- ${diag.errors} 个错误，${diag.warnings} 个警告，涉及 ${diag.totalFilesWithProblems} 个文件`,
  ];
  // Diagnostics arrive from VS Code unasked, and a message can quote the line
  // it flags: entries for blacklisted files (relative to the VS Code
  // workspace) are left out.
  const patterns = parseBlacklist(settings.get("advisorFileBlacklist"));
  let root = "";
  try { root = require("./ws-server").getVscodeWorkspace() || ""; } catch (_) { /* bridge not loaded */ }
  if (!root) root = resolveCwd();
  const top5 = (diag.details || [])
    .filter((d) => d && (!patterns.length || !d.file || matchBlacklist(String(d.file), patterns, { root }) === null))
    .slice(0, 5);
  for (const d of top5) {
    const file = (d.file || "").split(/[\\/]/).pop();
    lines.push(`  - [${d.severity}] ${file}:${d.line}: ${d.message}`);
  }
  lines.push(
    "",
    "请用你自然的风格轻声提醒博士这些错误——你注意到了，可以帮他看看。",
    "不要逐条罗列，用你的话概括最值得关注的。如果你觉得只是小问题，也可以只说 [[silent]]。"
  );
  return lines.join("\n");
}

function buildActivityProactivePrompt(promptOpts) {
  const wsServer = require("./ws-server");
  const activities = wsServer.getRecentActivities();
  const lines = [
    buildProactivePrompt(promptOpts),
    "",
    "博士最近的编辑器活动：",
  ];
  const recent = (activities || []).slice(-5);
  for (const a of recent) {
    const time = new Date(a.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    lines.push(`  - [${time}] ${a.detail}`);
  }
  lines.push(
    "",
    "请根据博士最近的操作，自然地给一句鼓励、提醒或轻松的话。",
    "若觉得没什么值得说的，可直接回复 [[silent]]。"
  );
  return lines.join("\n");
}

// A memory-curation pass: she tidies MEMORY.md with her file tools and stays
// silent. The reply is always discarded.
function sendMaintenance() {
  // The VS Code bridge runs its own turns and appends to MEMORY.md through
  // [[remember:]]; rewriting the file underneath one would drop those entries.
  if (vscodeTurnRunning()) return { ok: false, reason: "vscode-busy" };
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

// Lazy: vscode-chat requires this module at load time.
function vscodeTurnRunning() {
  try {
    return Boolean(require("./vscode-chat").isBusy());
  } catch {
    return false; // bridge not loaded
  }
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
  // Exported for tests: the proactive prompt must not claim a screenshot
  // that was never taken.
  buildVibeProactivePrompt,
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
  setChatCatMode,
  getOutboundQueueLength: () => outboundQueue.length,
  // Exported for vscode-chat.js (VS Code extension independent sessions)
  buildProviderInvocation,
  cleanupInvocation,
  // Exported for tests
  buildVibeProactivePrompt,
  consumeDirectives,
  stripDirectiveTags,
  // Test-only: start a fake turn (fresh directive state) of the given silent kind.
  _beginTurnForTests(kind = null) {
    resetDirectiveParsing();
    silentTurnKind = kind;
  },
};

