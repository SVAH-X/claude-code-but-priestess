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
//     (complete() parses plain text, not the event stream);
//   - claude: prompt via `-p` (correct for the Claude CLI).
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
// Claude feeds the prompt via -p (no stdin); emit on a short timer too.
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

test("vscode-chat complete() uses stdin for codex and cleans the output", async (t) => {
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

  const vscodeChat = require("../src/main/vscode-chat");

  // --- codex branch ---
  availabilityState.activeProvider = "codex";
  availabilityState.providers = {
    codex: { available: true, command: fakeCommand },
    claude: { available: false, command: null },
    priestess: { available: false },
  };
  let text = await vscodeChat.complete("function add(a, b) {", "verify.ts", "typescript");
  assert.equal(text, "return a + b;");
  const log = fs.readFileSync(logFile, "utf8");
  const argsLine = log.split("\n").find((l) => l.startsWith("["));
  assert.ok(argsLine, "fake CLI should log its args");
  assert.ok(!argsLine.includes('"-p"'), "codex args must not use -p (it is --profile)");
  assert.ok(!argsLine.includes("--json"), "codex completion should use plain text output");
  assert.ok(log.includes("STDIN:"), "codex prompt must be fed through stdin");
  assert.ok(log.includes("function add(a, b) {"), "stdin must contain the code prefix");

  // --- claude branch ---
  availabilityState.activeProvider = "claude";
  availabilityState.providers = {
    codex: { available: false, command: null },
    claude: { available: true, command: fakeCommand },
    priestess: { available: false },
  };
  text = await vscodeChat.complete("function add(a, b) {", "verify.ts", "typescript");
  assert.equal(text, "return a + b;");
  const log2 = fs.readFileSync(logFile, "utf8");
  const claudeLine = log2.split("\n").filter((l) => l.startsWith("[")).pop();
  assert.ok(claudeLine.includes('"-p"'), "claude args use -p for the prompt");
});
