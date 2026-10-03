const os = require("node:os");

function normalizeCwd(value, fallback = os.homedir()) {
  const requested = String(value || "").trim();
  if (requested) return requested;
  const safeFallback = String(fallback || "").trim();
  return safeFallback || process.cwd();
}

function resolveResumeSessionId(provider, sessionPlan, customSessionIds) {
  // Passing a custom map means the caller owns an isolated session namespace
  // (the VS Code bridge). Never fall back to the popover's module-level ids.
  if (customSessionIds !== null && customSessionIds !== undefined) {
    const value = customSessionIds[provider];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const planned = sessionPlan?.resumeSessionId;
  return typeof planned === "string" && planned.trim() ? planned.trim() : null;
}

function appendImageArgs(args, screenshotPath, attachmentArgs) {
  if (screenshotPath) args.push("-i", screenshotPath);
  if (Array.isArray(attachmentArgs)) args.push(...attachmentArgs);
}

function buildCodexExecArgs({
  cwd,
  mode = "companion",
  resumeSessionId = null,
  model = "",
  reasoningEffort = "",
  screenshotPath = null,
  attachmentArgs = [],
  memoryDir = ""
}) {
  const isAgent = mode === "agent";
  const isMaintenance = mode === "maintenance";
  const effectiveCwd = normalizeCwd(isMaintenance ? memoryDir : cwd);
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-C",
    effectiveCwd
  ];

  if (model) args.push("--model", model);
  if (reasoningEffort) {
    // Bare value on purpose: `-c key=value` parses the value as TOML and falls
    // back to the raw string when that fails (`codex exec --help`), so `high`
    // is read as the string "high". The quoted form `"high"` reached cmd.exe
    // on Windows .cmd shims, where the embedded quotes flipped its quote state
    // and the CLI received a mangled override.
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  if (isAgent) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    // What the sandbox can and cannot enforce per mode:
    //   - advisor and companion both get `-s read-only`: no writes, no
    //     network, but the shell tool stays (ls/cat/grep still run). Codex
    //     has no tool-less mode and no documented switch that removes its
    //     shell, so companion on Codex is advisor-level; the companion
    //     persona prompt says so instead of claiming she has no tools
    //     (Claude turns are truly tool-less, see claudeModeToolArgs).
    //   - maintenance gets `workspace-write` with the memory dir as cwd, so
    //     writes stay inside it. Persona and memory are already injected by
    //     PRTS: the memory directory is never a writable root for the rest.
    args.push("-s", isMaintenance ? "workspace-write" : "read-only");
  }

  if (resumeSessionId) {
    // -C/-s are parent `codex exec` options and must precede `resume`.
    // Image flags are accepted by the resume subcommand and stay after it.
    args.push("resume");
    appendImageArgs(args, screenshotPath, attachmentArgs);
    args.push(resumeSessionId, "-");
  } else {
    appendImageArgs(args, screenshotPath, attachmentArgs);
    args.push("-");
  }

  return { args, cwd: effectiveCwd, resumed: Boolean(resumeSessionId) };
}

// Downscaled copies of one turn's images share a directory, so naming them
// after the original alone lets two attachments picked from different folders
// collide — the second write silently replaces the first and the backend is
// handed the same picture twice. The position in the turn disambiguates them.
function attachmentTempName(originalPath, index) {
  const base = String(originalPath || "").split(/[\\/]/).pop() || "image";
  return `${String(index).padStart(2, "0")}-${base.replace(/\.[^.]+$/, "")}.png`;
}

// Permission mode for a silent self-turn, or null for a normal turn (the
// Doctor's own setting applies). Proactive checks need at least Read
// (advisor) and keep the Doctor's agent mode for plain 老婆模式 look-ins. A
// check that carries VS Code editor context (diagnostics, activity, terminal
// results) is capped at advisor: text that arrived over the extension bridge
// must never drive a full-permission turn. Maintenance edits MEMORY.md only.
function silentTurnVibeMode(silentTurnKind, globalMode, { editorContext = false } = {}) {
  if (silentTurnKind === "proactive") {
    return globalMode === "agent" && !editorContext ? "agent" : "advisor";
  }
  if (silentTurnKind === "maintenance") return "maintenance";
  return null;
}

// A silent turn may only look at the screen with 老婆模式 consent: a plain
// 老婆模式 look-in always has it, while a VS Code diagnostic/activity check
// without it runs on the editor text context alone (no full-screen capture).
function silentTurnWantsScreenshot(silentTurnKind, { waifuMode = false } = {}) {
  return silentTurnKind === "proactive" && waifuMode === true;
}

// The resume id of a Codex session, read from a session/thread lifecycle
// event. Only the explicit session/thread/conversation fields count: `event.id`
// is a per-event id, and storing it as the session made the next turn try to
// resume a session that never existed. Shared by the popover (chat.js) and the
// VS Code bridge (vscode-chat.js) so the two can't drift apart again.
const CODEX_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId"
];

function codexSessionIdFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  for (const field of CODEX_SESSION_ID_FIELDS) {
    const value = event[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Bounded exponential backoff with at most one pending timer. schedule()
// returns false once the attempts are used up, so the caller can give up
// visibly instead of polling forever. reset() cancels the pending timer and
// restores the full budget (call it on success or when the work is dropped).
function createBackoffRetry({
  baseMs = 5000,
  maxMs = 60000,
  maxAttempts = 4,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // Never keep the process alive just to retry.
    if (typeof timer?.unref === "function") timer.unref();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer)
} = {}) {
  let attempts = 0;
  let timer = null;

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  return {
    schedule(fn) {
      cancel();
      if (attempts >= maxAttempts) return false;
      const delay = Math.min(baseMs * 2 ** attempts, maxMs);
      attempts += 1;
      timer = setTimer(() => {
        timer = null;
        fn();
      }, delay);
      return true;
    },
    reset() {
      cancel();
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
    get pending() {
      return timer !== null;
    }
  };
}

module.exports = {
  attachmentTempName,
  buildCodexExecArgs,
  codexSessionIdFromEvent,
  createBackoffRetry,
  normalizeCwd,
  resolveResumeSessionId,
  silentTurnVibeMode,
  silentTurnWantsScreenshot
};
