const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Drives vscode-chat.complete() with a fake codex/claude CLI to pin the
// invocation contract:
//   - codex: prompt via stdin (`-`), NO `-p` (that flag is `--profile` in
//     `codex exec` and makes codex error out with empty stdout), no --json
//     (complete() parses plain text, not the event stream), read-only sandbox;
//   - claude: `-p` print mode with the prompt on stdin (never argv: a Windows
//     .cmd shim cuts argv at the first newline and expands %VAR%), no tools,
//     no MCP servers, pinned permission mode, no saved session.
// Completion is refused in companion mode and for sensitive/blacklisted files.
// The completion text is read from stdout and markdown-fenced output is
// cleaned before being returned.
//
// The fake CLI is built with String.raw so the \n sequences inside it stay
// literal escape sequences in the generated script (i.e. real newlines when
// that script runs) instead of being collapsed at build time.

function fakeCliScript() {
  return String.raw`// Fake codex/claude for tests: answers --version, logs args+stdin,
// and emits a fenced completion for exec/-p invocations.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 9.9.9\n'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\n');
let input = '';
let emitted = false;
const emit = () => {
  if (emitted) return;
  emitted = true;
  if (input) fs.appendFileSync(process.env.FAKE_CODEX_LOG, 'STDIN:' + input.replace(/\n/g, '\\n').slice(0, 400) + '\n');
  process.stdout.write('\`\`\`typescript\nreturn a + b;\n\`\`\`\n');
  process.exit(0);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', emit);
// Fallback in case a caller never closes stdin.
setTimeout(emit, 100);
`;
}

function writeFakeCli(binDir) {
  const fakeJs = path.join(binDir, "fake-codex.js");
  fs.writeFileSync(fakeJs, fakeCliScript(), "utf8");

  let command;
  if (process.platform === "win32") {
    const cmd = path.join(binDir, "codex.cmd");
    fs.writeFileSync(cmd, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n', "utf8");
    command = cmd;
  } else {
    const sh = path.join(binDir, "codex");
    fs.writeFileSync(sh, '#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.js" "$@"\n', "utf8");
    fs.chmodSync(sh, 0o755);
    command = sh;
  }
  return command;
}

function installModuleStub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
  return () => {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

test("vscode-chat complete() is gated, tool-less and stdin-fed", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-complete-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // electron is a devDependency and absent on CI (npm install --omit=dev).
  // Intercept Module._load so vscode-chat.js and its persona/settings deps
  // load without the real electron package - this test must run everywhere.
  const electronMock = {
    app: { getPath: () => tmp },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Notification: class { show() {} },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electronMock;
    return originalLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = originalLoad; });

  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logFile = path.join(tmp, "args.log");
  process.env.FAKE_CODEX_LOG = logFile;
  const fakeCommand = writeFakeCli(binDir);

  const availabilityState = { activeProvider: "codex", providers: {} };
  const restoreChat = installModuleStub("../src/main/chat", {
    getProviderAvailability: () => ({
      activeProvider: availabilityState.activeProvider,
      providers: availabilityState.providers,
    }),
  });
  t.after(restoreChat);

  const settings = require("../src/main/settings");
  // test/run.js loads every test file into one process: restore what we change.
  t.after(() => settings.set({
    vibeCodingMode: settings.DEFAULTS.vibeCodingMode,
    advisorFileBlacklist: settings.DEFAULTS.advisorFileBlacklist,
    chatCwd: settings.DEFAULTS.chatCwd,
  }));
  const vscodeChat = require("../src/main/vscode-chat");
  const readCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "")
    .split("\n")
    .filter((l) => l.startsWith("["));

  // --- companion mode (the default) never spawns a CLI ---
  availabilityState.activeProvider = "codex";
  availabilityState.providers = {
    codex: { available: true, command: fakeCommand },
    claude: { available: false, command: null },
    priestess: { available: false },
  };
  assert.equal(settings.get("vibeCodingMode"), "companion");
  assert.equal(await vscodeChat.complete("function add(a, b) {", "verify.ts", "typescript"), null);
  assert.equal(readCalls().length, 0, "companion mode must not spawn a completion CLI");

  settings.set({ vibeCodingMode: "advisor" });

  // --- codex branch ---
  let text = await vscodeChat.complete("function add(a, b) {", "verify.ts", "typescript");
  assert.equal(text, "return a + b;");
  const log = fs.readFileSync(logFile, "utf8");
  const argsLine = log.split("\n").find((l) => l.startsWith("["));
  assert.ok(argsLine, "fake CLI should log its args");
  assert.ok(!argsLine.includes('"-p"'), "codex args must not use -p (it is --profile)");
  assert.ok(!argsLine.includes("--json"), "codex completion should use plain text output");
  assert.ok(argsLine.includes('"read-only"'), "codex completion runs in the read-only sandbox");
  assert.ok(!argsLine.includes("dangerously"), "codex completion never bypasses the sandbox");
  assert.ok(log.includes("STDIN:"), "codex prompt must be fed through stdin");
  assert.ok(log.includes("function add(a, b) {"), "stdin must contain the code prefix");

  // --- claude branch ---
  availabilityState.activeProvider = "claude";
  availabilityState.providers = {
    codex: { available: false, command: null },
    claude: { available: true, command: fakeCommand },
    priestess: { available: false },
  };
  const multiLine = "function add(a, b) {\n  // 100% %PATH% \"quoted\"\n";
  text = await vscodeChat.complete(multiLine, "verify.ts", "typescript", path.join(tmp, "src", "verify.ts"));
  assert.equal(text, "return a + b;");
  const log2 = fs.readFileSync(logFile, "utf8");
  const claudeArgs = JSON.parse(readCalls().pop());
  assert.equal(claudeArgs[0], "-p", "claude runs in print mode");
  assert.ok(claudeArgs.every((a) => !a.includes("function add") && !a.includes("\n")),
    "the prompt must never travel through argv");
  assert.ok(log2.includes("STDIN:Complete this code."), "claude prompt must be fed through stdin");
  assert.ok(log2.includes("%PATH%"), "stdin carries the prefix verbatim");
  const toolsAt = claudeArgs.indexOf("--tools");
  assert.ok(toolsAt >= 0 && claudeArgs[toolsAt + 1] === "", "claude completion disables all built-in tools");
  const modeAt = claudeArgs.indexOf("--permission-mode");
  assert.ok(modeAt >= 0 && claudeArgs[modeAt + 1] === "default",
    "permission mode is pinned so settings.json defaultMode cannot apply");
  assert.ok(claudeArgs.includes("--strict-mcp-config"), "the Doctor's MCP servers are not loaded");
  assert.ok(claudeArgs.includes("--no-session-persistence"), "no saved session per completion");
  assert.ok(!claudeArgs.some((a) => /dangerously|bypass|allowedTools/i.test(a)), "no permission escalation");

  // --- agent mode is still capped: same tool-less invocation ---
  settings.set({ vibeCodingMode: "agent" });
  text = await vscodeChat.complete("const x = compute(", "x.ts", "typescript");
  assert.equal(text, "return a + b;");
  const agentArgs = JSON.parse(readCalls().pop());
  assert.deepEqual(agentArgs, claudeArgs, "agent mode must not widen the completion invocation");

  // --- sensitive and blacklisted files never reach the CLI ---
  // The blacklist is relative to the workspace root (no VS Code workspace is
  // reported here, so chatCwd is the root).
  settings.set({ vibeCodingMode: "advisor", advisorFileBlacklist: "vault/**", chatCwd: tmp });
  const before = readCalls().length;
  const blocked = [
    [".env", path.join(tmp, ".env")],
    [".env.local", path.join(tmp, ".env.local")],
    ["SERVER.PEM", "C:\\proj\\certs\\SERVER.PEM"],
    ["id_ed25519", path.join(tmp, ".ssh", "id_ed25519")],
    ["prod.key", path.join(tmp, "prod.key")],
    ["a.ts", path.join(tmp, "vault", "a.ts")],
    // No full path from an older extension: the bare name is still checked.
    [".env", undefined],
  ];
  for (const [file, full] of blocked) {
    assert.equal(await vscodeChat.complete("API_KEY=sk-live-123", file, "plaintext", full), null, `${full || file} must be refused`);
  }
  // Windows workspace: backslashes and drive-letter case do not matter.
  settings.set({ chatCwd: "C:\\Users\\Doc\\proj" });
  assert.equal(await vscodeChat.complete("x", "a.ts", "typescript", "c:\\users\\doc\\proj\\Vault\\a.ts"), null,
    "vault/** covers a Windows path under the root");
  assert.equal(readCalls().length, before, "no CLI spawned for sensitive/blacklisted files");

  // Clearing the Doctor's blacklist cannot remove the built-in floor.
  settings.set({ advisorFileBlacklist: "" });
  assert.equal(await vscodeChat.complete("API_KEY=sk-live-123", ".env", "plaintext", path.join(tmp, ".env")), null);
  assert.equal(readCalls().length, before, "the sensitive-file floor survives an empty blacklist");
});
