const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Vibe modes are enforced by the CLI, not by the prompt (see
// claudeModeToolArgs): a non-agent Claude turn pins --permission-mode default
// and cuts the built-in tools down to the mode's allowlist, so defaultMode and
// allow rules in ~/.claude/settings.json cannot widen it. VS Code turns never
// get the agent flags on either backend. A fake `claude` in a fake home stands
// in for the CLI; nothing real is ever launched.

const SRC = path.join(__dirname, "..", "src", "main");
const {
  CLAUDE_BUILTIN_TOOLS,
  claudeHelpSupportsTools,
  claudeModeToolArgs
} = require(path.join(SRC, "claude-capabilities.js"));

const FAKE_HELP = "Usage: claude [options]\n  --tools <tools...>   Specify the list of available tools\n";

function fakeClaudeScript() {
  return String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(${JSON.stringify(FAKE_HELP)}); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.PRTS_FAKE_CLAUDE_LOG, JSON.stringify({ args }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: '11111111-1111-4111-8111-111111111111' }) + '\n');
  process.exit(0);
});
`;
}

function installFakeClaude(home) {
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-claude.js"), fakeClaudeScript(), "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(binDir, "claude.cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(binDir, "claude");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.js" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

function purgeMainModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }
}

function setup(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prts-perm-")));
  const home = path.join(tmp, "home");
  const userData = path.join(tmp, "userData");
  const scratchTmp = path.join(tmp, "tmp");
  const workspace = path.join(tmp, "ws");
  for (const dir of [home, userData, scratchTmp, workspace]) fs.mkdirSync(dir, { recursive: true });

  const savedEnv = {};
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: scratchTmp,
    TEMP: scratchTmp,
    TMP: scratchTmp,
    PRTS_FAKE_CLAUDE_LOG: path.join(tmp, "claude-calls.log")
  };
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const fakeClaude = installFakeClaude(home);

  const electronMock = {
    app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    Notification: class { show() {} static isSupported() { return false; } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronMock;
    return originalLoad.apply(this, arguments);
  };
  purgeMainModules();

  t.after(() => {
    Module._load = originalLoad;
    purgeMainModules();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const settings = require(path.join(SRC, "settings.js"));
  settings.init();
  settings.set({ chatCwd: workspace, advisorFileBlacklist: "" });
  const chat = require(path.join(SRC, "chat.js"));
  return { tmp, workspace, scratchTmp, fakeClaude, settings, chat, logFile: env.PRTS_FAKE_CLAUDE_LOG };
}

async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The value after `flag`, or null when absent; `count` guards against a flag
// appearing twice with different values.
function flagValue(args, flag) {
  const hits = args.map((a, i) => (a === flag ? i : -1)).filter((i) => i >= 0);
  assert.ok(hits.length <= 1, `${flag} given ${hits.length} times`);
  return hits.length ? args[hits[0] + 1] : null;
}

function without(list) {
  return CLAUDE_BUILTIN_TOOLS.filter((tool) => !list.includes(tool)).join(",");
}

function cleanup(invocation) {
  for (const dir of invocation.cleanupDirs || []) fs.rmSync(dir, { recursive: true, force: true });
}

test("claudeModeToolArgs: exact argv per mode", () => {
  assert.deepEqual(claudeModeToolArgs("companion"), [
    "--permission-mode", "default",
    "--tools", "",
    "--disallowedTools", CLAUDE_BUILTIN_TOOLS.join(","),
    "--strict-mcp-config"
  ]);
  assert.deepEqual(claudeModeToolArgs("companion", { needsRead: true }), [
    "--permission-mode", "default",
    "--tools", "Read",
    "--disallowedTools", without(["Read"]),
    "--strict-mcp-config"
  ]);
  assert.deepEqual(claudeModeToolArgs("advisor"), [
    "--permission-mode", "default",
    "--tools", "Read,Grep,Glob",
    "--disallowedTools", without(["Read", "Grep", "Glob"]),
    "--allowedTools", "Read,Grep,Glob"
  ]);
  assert.deepEqual(claudeModeToolArgs("maintenance"), [
    "--permission-mode", "default",
    "--tools", "Read,Edit,Write,Glob,Grep",
    "--disallowedTools", without(["Read", "Edit", "Write", "Glob", "Grep"]),
    "--allowedTools", "Read,Edit,Write,Glob,Grep"
  ]);
  // An image never widens advisor/maintenance beyond their allowlist.
  assert.deepEqual(claudeModeToolArgs("advisor", { needsRead: true }), claudeModeToolArgs("advisor"));
  // Every deny list keeps Bash and the write/network tools out of non-agent turns.
  for (const mode of ["companion", "advisor"]) {
    const denied = flagValue(claudeModeToolArgs(mode), "--disallowedTools").split(",");
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]) {
      assert.ok(denied.includes(tool), `${mode} denies ${tool}`);
    }
  }
  assert.ok(flagValue(claudeModeToolArgs("maintenance"), "--disallowedTools").split(",").includes("Bash"));
});

test("claudeModeToolArgs: a CLI without --tools keeps the mode pinned by deny rules", () => {
  const args = claudeModeToolArgs("companion", { toolsFlag: false });
  assert.equal(args.includes("--tools"), false);
  assert.deepEqual(args.slice(0, 2), ["--permission-mode", "default"]);
  assert.equal(flagValue(args, "--disallowedTools"), CLAUDE_BUILTIN_TOOLS.join(","));
  assert.equal(claudeHelpSupportsTools(FAKE_HELP), true);
  assert.equal(claudeHelpSupportsTools("Usage: claude [options]\n  --allowedTools <tools...>\n"), false);
  assert.equal(claudeHelpSupportsTools(""), false);
});

test("Claude turns carry the mode's flags; the agent flag stays agent-only", (t) => {
  const { workspace, chat } = setup(t);
  const screenshot = path.join(workspace, "..", "tmp", "prts", "screen.png");

  for (const mode of ["companion", "advisor", "maintenance", "agent"]) {
    const invocation = chat.buildProviderInvocation("claude", "hi", workspace, mode, null, "", null, {});
    try {
      const { args } = invocation;
      assert.equal(args[0], "-p", `${mode}: print mode`);
      if (mode === "agent") {
        assert.ok(args.includes("--dangerously-skip-permissions"), "agent bypasses permissions");
        for (const flag of ["--permission-mode", "--tools", "--disallowedTools", "--allowedTools"]) {
          assert.equal(args.includes(flag), false, `agent: no ${flag}`);
        }
        continue;
      }
      assert.equal(args.includes("--dangerously-skip-permissions"), false, `${mode}: no bypass`);
      const expected = claudeModeToolArgs(mode);
      const at = args.indexOf("--permission-mode");
      assert.ok(at >= 0, `${mode}: --permission-mode present`);
      assert.deepEqual(args.slice(at, at + expected.length), expected, `${mode}: exact mode argv`);
      assert.equal(args.includes("--add-dir"), false, `${mode}: no --add-dir without images`);
    } finally {
      cleanup(invocation);
    }
  }

  // A screenshot is the one thing a companion turn may Read; the deny list
  // still covers everything else and Read is granted the capture's folder.
  const shot = chat.buildProviderInvocation("claude", "hi", workspace, "companion", screenshot, "", null, {});
  try {
    assert.equal(flagValue(shot.args, "--tools"), "Read");
    assert.equal(flagValue(shot.args, "--disallowedTools"), without(["Read"]));
    assert.equal(flagValue(shot.args, "--permission-mode"), "default");
    assert.equal(flagValue(shot.args, "--add-dir"), path.dirname(screenshot));
  } finally {
    cleanup(shot);
  }
  const advisorShot = chat.buildProviderInvocation("claude", "hi", workspace, "advisor", screenshot, "", null, {});
  try {
    assert.equal(flagValue(advisorShot.args, "--tools"), "Read,Grep,Glob");
    assert.equal(flagValue(advisorShot.args, "--add-dir"), path.dirname(screenshot));
  } finally {
    cleanup(advisorShot);
  }
});

test("a companion turn with an attached image gets Read, nothing more", async (t) => {
  const { workspace, chat, fakeClaude, logFile, settings } = setup(t);
  settings.set({ vibeCodingMode: "companion", chatProvider: "claude" });
  const image = path.join(workspace, "pics", "cat.png");
  fs.mkdirSync(path.dirname(image), { recursive: true });
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const availability = chat.refreshProviderAvailability();
  if (availability.providers.claude.command !== fakeClaude) {
    t.skip(`fake claude not selected (${availability.providers.claude.command}); not launching a real CLI`);
    return;
  }
  assert.equal(availability.providers.claude.toolsFlag, true, "the --help probe saw --tools");

  const result = chat.send("看看这张", [image]);
  assert.equal(result.ok, true, `send accepted: ${JSON.stringify(result)}`);
  await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("\n"));
  await waitFor(() => !chat.isBusy());
  const { args } = JSON.parse(fs.readFileSync(logFile, "utf8").split("\n")[0]);
  assert.equal(flagValue(args, "--permission-mode"), "default");
  assert.equal(flagValue(args, "--tools"), "Read");
  assert.equal(flagValue(args, "--disallowedTools"), without(["Read"]));
  assert.equal(flagValue(args, "--add-dir"), path.dirname(image), "Read is granted the image's folder");
  assert.equal(args.includes("--allowedTools"), false, "no allow rule beyond the working dirs");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("VS Code turns never get agent or bypass flags on either backend", (t) => {
  const { workspace, chat } = setup(t);
  const vscode = { vscodeTurn: true, workspacePath: workspace };

  const claude = chat.buildProviderInvocation("claude", "hi", workspace, "agent", null, "", null, {}, vscode);
  try {
    assert.equal(claude.args.includes("--dangerously-skip-permissions"), false);
    const expected = claudeModeToolArgs("advisor");
    const at = claude.args.indexOf("--permission-mode");
    assert.deepEqual(claude.args.slice(at, at + expected.length), expected, "capped at advisor");
  } finally {
    cleanup(claude);
  }

  const codex = chat.buildProviderInvocation("codex", "hi", workspace, "agent", null, "", null, {}, vscode);
  assert.equal(codex.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(flagValue(codex.args, "-s"), "read-only", "codex capped at the read-only sandbox");
});

test("the companion prompt only claims to be tool-less where the CLI makes it so", (t) => {
  setup(t);
  const persona = require(path.join(SRC, "persona.js"));
  const claude = persona.buildPersonaPrompt({ vibeCodingMode: "companion", provider: "claude", includeLongMemory: false });
  const codex = persona.buildPersonaPrompt({ vibeCodingMode: "companion", provider: "codex", includeLongMemory: false });
  assert.ok(claude.includes("没有任何文件或终端工具"), "Claude companion is tool-less");
  assert.ok(!codex.includes("没有任何文件或终端工具"), "Codex companion keeps its read-only sandbox");
  assert.ok(codex.includes("只读沙箱"), "Codex companion names the sandbox");
  assert.ok(codex.includes("【陪伴模式】") && !codex.includes("文件黑名单"), "the companion prompt stays flat");
});
