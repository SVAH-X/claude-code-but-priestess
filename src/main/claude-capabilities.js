const CLAUDE_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

// Built-in tools Claude Code 2.1 exposes. A mode's --disallowedTools is the
// complement of its allowlist, so a Doctor on a CLI too old for --tools still
// loses the tools the mode forbids (deny rules beat every allow rule, including
// the ones in ~/.claude/settings.json). Names a CLI does not know are inert.
const CLAUDE_BUILTIN_TOOLS = Object.freeze([
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write"
]);

// Tool allowlist per non-agent vibe mode. Companion is tool-less: she only
// gets Read when the turn hands her an image (attachment or screenshot).
const CLAUDE_MODE_TOOLS = Object.freeze({
  companion: Object.freeze([]),
  advisor: Object.freeze(["Read", "Grep", "Glob"]),
  maintenance: Object.freeze(["Read", "Edit", "Write", "Glob", "Grep"])
});

function isClaudeReasoningEffort(value) {
  return value === "" || CLAUDE_REASONING_EFFORTS.includes(String(value || ""));
}

function parseClaudeEffortLevels(helpText) {
  const source = String(helpText || "");
  const flagIndex = source.indexOf("--effort <level>");
  if (flagIndex === -1) return [];

  const excerpt = source.slice(flagIndex, flagIndex + 500);
  const choices = excerpt.match(/\(([^()]*)\)/)?.[1] || "";
  return CLAUDE_REASONING_EFFORTS.filter((effort) => (
    new RegExp(`(?:^|[\\s,])${effort}(?:$|[\\s,])`, "i").test(choices)
  ));
}

// Whether `claude --help` lists the --tools hard allowlist (Claude Code 2.1).
function claudeHelpSupportsTools(helpText) {
  return /^\s*--tools\s+<tools/m.test(String(helpText || ""));
}

// Permission argv for a non-agent Claude turn. Every vibe mode is enforced by
// the CLI itself, not by the prompt:
//   --permission-mode default  pins the mode so a defaultMode of auto /
//                              acceptEdits / bypassPermissions in
//                              ~/.claude/settings.json cannot apply;
//   --tools <list>             the built-in set is cut down to the mode's
//                              allowlist ("" = no tools at all);
//   --disallowedTools <rest>   deny rules for everything else, which no allow
//                              rule in the Doctor's settings can re-enable;
//   --allowedTools <list>      only where a tool would otherwise prompt (and a
//                              -p turn answers every prompt with "no"): Edit
//                              and Write in maintenance, Read outside the
//                              working directories in advisor.
// `needsRead` is a companion turn carrying an image; `toolsFlag: false` is a
// CLI whose --help has no --tools, which then relies on the deny list alone.
// Agent mode is not built here (it keeps --dangerously-skip-permissions).
function claudeModeToolArgs(mode, { needsRead = false, toolsFlag = true } = {}) {
  const base = CLAUDE_MODE_TOOLS[mode] || CLAUDE_MODE_TOOLS.companion;
  const allowed = mode === "companion" && needsRead ? ["Read"] : [...base];
  const denied = CLAUDE_BUILTIN_TOOLS.filter((tool) => !allowed.includes(tool));
  const args = ["--permission-mode", "default"];
  if (toolsFlag) args.push("--tools", allowed.join(","));
  args.push("--disallowedTools", denied.join(","));
  if (mode === "advisor" || mode === "maintenance") {
    args.push("--allowedTools", allowed.join(","));
  }
  if (mode === "companion") {
    // A companion turn has no tools, so the Doctor's MCP servers are not
    // loaded either (and startup is faster for it).
    args.push("--strict-mcp-config");
  }
  return args;
}

// Model presets for the tray's Claude model menu, passed to the CLI as
// `--model` (empty = the CLI/account default). Aliases always follow the
// newest model in a family; full ids pin one. The list keeps the current
// release plus one previous version per family and drops retired or
// deprecated ids. A saved value that is no longer listed still shows up as
// the "current custom" entry, so pruning never silently switches anyone.
const CLAUDE_MODEL_PRESETS = Object.freeze([
  { labelKey: "defaultClaude", value: "" },
  { labelKey: "fableAlias", value: "fable" },
  { labelKey: "opusAlias", value: "opus" },
  { labelKey: "sonnetAlias", value: "sonnet" },
  { labelKey: "haikuAlias", value: "haiku" },
  { type: "separator" },
  { label: "Fable 5.1", value: "claude-fable-5-1" },
  { label: "Fable 5", value: "claude-fable-5" },
  { type: "separator" },
  { label: "Opus 5.5", value: "claude-opus-5-5" },
  { label: "Opus 5", value: "claude-opus-5" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
  { type: "separator" },
  { label: "Sonnet 5.5", value: "claude-sonnet-5-5" },
  { label: "Sonnet 5", value: "claude-sonnet-5" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { type: "separator" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5" }
].map((preset) => Object.freeze(preset)));

// Saved `claudeModel` values rewritten on settings load. Retired ids map to
// "" (the CLI default), which is what chat.js's invalid-model self-heal would
// do anyway, minus the failed first turn. Dated ids that now have a dateless
// alias for the same model map to that alias so the menu shows them checked.
const CLAUDE_MODEL_MIGRATIONS = Object.freeze({
  "claude-opus-4-1-20250805": "",
  "claude-opus-4-1": "",
  "claude-3-haiku-20240307": "",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5"
});

function migrateClaudeModel(value) {
  const model = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(CLAUDE_MODEL_MIGRATIONS, model)
    ? CLAUDE_MODEL_MIGRATIONS[model]
    : model;
}

module.exports = {
  CLAUDE_MODEL_MIGRATIONS,
  CLAUDE_MODEL_PRESETS,
  CLAUDE_REASONING_EFFORTS,
  CLAUDE_BUILTIN_TOOLS,
  CLAUDE_MODE_TOOLS,
  migrateClaudeModel,
  isClaudeReasoningEffort,
  parseClaudeEffortLevels,
  claudeHelpSupportsTools,
  claudeModeToolArgs
};
