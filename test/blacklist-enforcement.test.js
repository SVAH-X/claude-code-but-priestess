const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// End-to-end checks of where the file blacklist applies (see file-blacklist.js):
//   - the advisor prompt names the patterns but never walks the workspace;
//   - Claude companion/advisor turns get Read deny rules through a --settings
//     file (argv stays free of globs), agent/maintenance turns get none;
//   - a tray attachment is never dropped: a hit inside the cwd is flagged, and
//     an image the deny rules would cover reaches Claude as a neutral temp copy;
//   - VS Code diagnostics for blacklisted files stay out of proactive prompts.
// A fake `claude` in a fake home stands in for the CLI; the send test refuses
// to run unless that fake is the one selected, so no real CLI is ever launched.

const SRC = path.join(__dirname, "..", "src", "main");
const DEFAULT_RULES = [
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/*.p12)",
  "Read(**/*.pfx)",
  "Read(**/id_rsa*)",
  "Read(**/id_ed25519*)",
  "Read(**/id_ecdsa*)",
  "Read(**/.npmrc)",
  "Read(**/.netrc)",
  "Read(**/.pgpass)",
  "Read(**/.git-credentials)",
  "Read(**/secrets/**)"
];

function fakeClaudeScript() {
  return String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write('Usage: claude [options]\n'); process.exit(0); }
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const read = (p) => { try { return p ? fs.readFileSync(p, 'utf8') : null; } catch (_) { return null; } };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.PRTS_FAKE_CLAUDE_LOG, JSON.stringify({
    args,
    settings: read(at('--settings')),
    prompt: read(at('--append-system-prompt-file')),
    stdin: input
  }) + '\n');
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

// Isolated environment: temp home/userData/tmpdir, electron mocked, fresh
// src/main modules (test/run.js loads every test file into one process).
function setup(t, { nativeImage = null } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prts-blacklist-")));
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
    // Default: every image reads as "not decodable", so no downscale.
    nativeImage: nativeImage || { createFromPath: () => ({ isEmpty: () => true }) }
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
  return { tmp, home, workspace, scratchTmp, fakeClaude, settings, logFile: env.PRTS_FAKE_CLAUDE_LOG };
}

async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("advisor prompt names the blacklist without walking the workspace", (t) => {
  const { workspace, settings } = setup(t);
  fs.writeFileSync(path.join(workspace, ".env"), "API_KEY=1");
  fs.mkdirSync(path.join(workspace, "src", "tokenizer"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "tokenizer", "lexer.ts"), "");
  settings.set({ chatCwd: workspace, vibeCodingMode: "advisor" });
  const persona = require(path.join(SRC, "persona.js"));

  const realReaddir = fs.readdirSync;
  const listed = [];
  fs.readdirSync = function (dir, ...rest) {
    listed.push(String(dir));
    return realReaddir.call(this, dir, ...rest);
  };
  let advisor;
  let companion;
  try {
    advisor = persona.buildPersonaPrompt({ vibeCodingMode: "advisor", provider: "claude", includeLongMemory: false });
    companion = persona.buildPersonaPrompt({ vibeCodingMode: "companion", provider: "claude", includeLongMemory: false });
  } finally {
    fs.readdirSync = realReaddir;
  }

  assert.deepEqual(listed.filter((dir) => dir.startsWith(workspace)), [], "no directory listing under the workspace");
  assert.ok(advisor.includes("文件黑名单") && advisor.includes("*.pem"), "advisor prompt names the patterns");
  assert.ok(!advisor.includes(workspace), "no workspace paths in the prompt");
  assert.ok(!companion.includes("文件黑名单"), "the always-on companion prompt stays flat");
});

test("Claude gets Read deny rules via --settings in companion/advisor turns only", (t) => {
  const { workspace, settings } = setup(t);
  settings.set({ chatCwd: workspace });
  const chat = require(path.join(SRC, "chat.js"));

  for (const mode of ["companion", "advisor", "agent", "maintenance"]) {
    const invocation = chat.buildProviderInvocation("claude", "hi", workspace, mode, null, "", null, {});
    try {
      const at = invocation.args.indexOf("--settings");
      assert.ok(!invocation.args.some((arg) => String(arg).includes("Read(")), `${mode}: no rule text in argv`);
      if (mode === "companion" || mode === "advisor") {
        assert.ok(at >= 0, `${mode}: --settings present`);
        const parsed = JSON.parse(fs.readFileSync(invocation.args[at + 1], "utf8"));
        assert.deepEqual(parsed, { permissions: { deny: DEFAULT_RULES } }, `${mode}: deny rules`);
        assert.ok(
          invocation.cleanupDirs.some((dir) => invocation.args[at + 1].startsWith(dir)),
          `${mode}: settings file is cleaned up with the turn`
        );
      } else {
        assert.equal(at, -1, `${mode}: blacklist not applied`);
      }
    } finally {
      for (const dir of invocation.cleanupDirs || []) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  settings.set({ advisorFileBlacklist: "" });
  const bare = chat.buildProviderInvocation("claude", "hi", workspace, "advisor", null, "", null, {});
  assert.equal(bare.args.indexOf("--settings"), -1, "empty blacklist: no --settings");
  for (const dir of bare.cleanupDirs || []) fs.rmSync(dir, { recursive: true, force: true });
});

test("tray attachments are never dropped; a blacklist hit is flagged and stays readable", async (t) => {
  const { workspace, settings, fakeClaude, scratchTmp, logFile } = setup(t);
  const image = path.join(workspace, "design", "secrets", "palette.png");
  fs.mkdirSync(path.dirname(image), { recursive: true });
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  settings.set({ chatCwd: workspace, vibeCodingMode: "advisor", chatProvider: "claude" });
  const chat = require(path.join(SRC, "chat.js"));

  const availability = chat.refreshProviderAvailability();
  if (availability.providers.claude.command !== fakeClaude) {
    t.skip(`fake claude not selected (${availability.providers.claude.command}); not launching a real CLI`);
    return;
  }

  const result = chat.send("", [image]);
  assert.equal(result.ok, true, `send accepted: ${JSON.stringify(result)}`);
  const history = chat.getHistory();
  const user = history.find((entry) => entry.role === "user");
  assert.deepEqual(user.attachments, [image], "the bubble keeps the Doctor's original file");
  const note = history.find((entry) => entry.role === "system" && entry.text.includes("文件黑名单"));
  assert.ok(note && note.text.includes("palette.png") && note.text.includes("secrets/"), "the hit is flagged");

  await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("\n"));
  await waitFor(() => !chat.isBusy());
  const call = JSON.parse(fs.readFileSync(logFile, "utf8").split("\n")[0]);
  assert.deepEqual(JSON.parse(call.settings), { permissions: { deny: DEFAULT_RULES } });
  const copyDir = path.join(scratchTmp, "prts-attach");
  const copy = path.join(copyDir, "00-attachment.png");
  assert.ok(fs.existsSync(copy), "neutral temp copy exists");
  assert.equal(call.args[call.args.indexOf("--add-dir") + 1], copyDir, "Read is granted the copy's folder");
  assert.ok(call.prompt.includes(copy), "the prompt points at the copy");
  assert.ok(!call.prompt.includes(image), "the covered original path is not handed to Claude");
});

// Sends through the tray with the fake CLI and returns what the CLI received.
async function sendAndCapture(t, ctx, text, files) {
  const chat = require(path.join(SRC, "chat.js"));
  const availability = chat.refreshProviderAvailability();
  if (availability.providers.claude.command !== ctx.fakeClaude) {
    t.skip(`fake claude not selected (${availability.providers.claude.command}); not launching a real CLI`);
    return null;
  }
  const result = chat.send(text, files);
  assert.equal(result.ok, true, `send accepted: ${JSON.stringify(result)}`);
  await waitFor(() => fs.existsSync(ctx.logFile) && fs.readFileSync(ctx.logFile, "utf8").includes("\n"));
  await waitFor(() => !chat.isBusy());
  return { chat, call: JSON.parse(fs.readFileSync(ctx.logFile, "utf8").split("\n")[0]) };
}

test("an image outside the cwd keeps its path and raises no notice (B3)", async (t) => {
  const ctx = setup(t);
  const outside = path.join(ctx.tmp, "Desktop");
  fs.mkdirSync(outside, { recursive: true });
  const image = path.join(outside, "id_rsa scan.png");
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  ctx.settings.set({ chatCwd: ctx.workspace, vibeCodingMode: "advisor", chatProvider: "claude" });

  const sent = await sendAndCapture(t, ctx, "", [image]);
  if (!sent) return;
  const { chat, call } = sent;
  assert.ok(!chat.getHistory().some((e) => e.role === "system" && e.text.includes("文件黑名单")), "no notice");
  assert.ok(call.args.includes("--settings"), "the workspace is still guarded");
  if (process.platform === "win32") {
    // Unverified Claude behavior there, so a name match outside the cwd is
    // renamed as a hedge (see claudeAttachmentGuard in chat.js).
    const copyDir = path.join(ctx.scratchTmp, "prts-attach");
    assert.ok(call.prompt.includes(path.join(copyDir, "00-attachment.png")), "neutral copy on Windows");
    assert.equal(call.args[call.args.indexOf("--add-dir") + 1], copyDir);
  } else {
    assert.ok(call.prompt.includes(image), "Claude is pointed at the original");
    assert.equal(call.args[call.args.indexOf("--add-dir") + 1], outside);
  }
});

test("a downscaled copy that would land inside the cwd gets a neutral name", async (t) => {
  // Windows shape: cwd = home, os.tmpdir() = %LOCALAPPDATA%\Temp under it.
  const ctx = setup(t, {
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 4000, height: 3000 }),
        resize: () => ({ toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
      })
    }
  });
  const innerTmp = path.join(ctx.workspace, "AppData", "Local", "Temp");
  fs.mkdirSync(innerTmp, { recursive: true });
  process.env.TMPDIR = innerTmp;
  process.env.TEMP = innerTmp;
  process.env.TMP = innerTmp;
  const outside = path.join(ctx.tmp, "pictures");
  fs.mkdirSync(outside, { recursive: true });
  // A leading-wildcard pattern: the downscaled copy keeps the original's
  // basename, so the covered name has to match after the NN- prefix.
  const image = path.join(outside, "Password Reset Flow.png");
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  ctx.settings.set({ chatCwd: ctx.workspace, vibeCodingMode: "companion", chatProvider: "claude", advisorFileBlacklist: ".env\n*password*" });

  const sent = await sendAndCapture(t, ctx, "看看", [image]);
  if (!sent) return;
  const { call } = sent;
  const copy = path.join(innerTmp, "prts-attach", "00-attachment.png");
  assert.ok(fs.existsSync(copy), "neutral downscaled copy");
  assert.ok(call.prompt.includes(copy), "Claude is pointed at the copy");
  assert.ok(!call.prompt.includes("Password Reset Flow"), "no copy under the covered name");
});

test("agent turns carry no deny rules and keep the original attachment", async (t) => {
  const ctx = setup(t);
  const image = path.join(ctx.workspace, "design", "tokens", "palette.png");
  fs.mkdirSync(path.dirname(image), { recursive: true });
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  ctx.settings.set({ chatCwd: ctx.workspace, vibeCodingMode: "agent", chatProvider: "claude", autoScreenshot: false });

  const sent = await sendAndCapture(t, ctx, "", [image]);
  if (!sent) return;
  const { chat, call } = sent;
  assert.equal(call.settings, null, "no --settings in agent mode");
  assert.ok(call.prompt.includes(image), "original path");
  assert.ok(!chat.getHistory().some((e) => e.role === "system" && e.text.includes("文件黑名单")), "no notice");
});

test("proactive diagnostics leave out blacklisted files", (t) => {
  const { workspace, settings } = setup(t);
  settings.set({ chatCwd: workspace });
  const chat = require(path.join(SRC, "chat.js"));
  const prompt = chat.buildVibeProactivePrompt({
    diagnosticContext: {
      errors: 2,
      warnings: 0,
      totalFilesWithProblems: 2,
      details: [
        { file: path.join(workspace, "config", ".env.local"), severity: "error", line: 1, message: "Unexpected token STRIPE_KEY=sk_live_abc" },
        null,
        { file: path.join(workspace, "src", "app.ts"), severity: "error", line: 3, message: "Cannot find name 'answer'." }
      ]
    }
  });
  assert.ok(!prompt.includes("sk_live_abc") && !prompt.includes(".env.local"), "blacklisted diagnostics dropped");
  assert.ok(prompt.includes("app.ts:3: Cannot find name 'answer'."), "other diagnostics kept");
});
