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

module.exports = {
  CLAUDE_REASONING_EFFORTS,
  CLAUDE_BUILTIN_TOOLS,
  CLAUDE_MODE_TOOLS,
  isClaudeReasoningEffort,
  parseClaudeEffortLevels,
  claudeHelpSupportsTools,
  claudeModeToolArgs
};
