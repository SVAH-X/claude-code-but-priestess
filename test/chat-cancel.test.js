const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Stop/Clear correctness in chat.js (see cancel() and the per-turn token):
//   - a cancelled CLI turn whose process lingers after SIGTERM still ends with
//     exactly one idle(cancelled), its late output is dropped (a late `result`
//     must not re-adopt the session id "New Conversation" just cleared), and
//     the next turn starts clean (cancelRequested does not leak into it);
//   - a turn sent while the cancelled process is still dying is never touched
//     by the dying process's close handler (no second idle, no stray text);
//   - the built-in priestess backend: cancel() aborts the request and the
//     AbortError still finishes the turn with idle(cancelled), once.
// A fake `claude` in a fake home stands in for the CLI; the CLI tests refuse
// to run unless that fake is the one selected, so no real CLI is ever launched.

const SRC = path.join(__dirname, "..", "src", "main");
const LATE_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLEAN_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// With the PRTS_FAKE_STUBBORN flag file present the fake ignores SIGTERM for a
// while, then flushes a final `result` on its way out — like a real CLI that
// writes its last event during shutdown. Without the flag it answers at once.
function fakeClaudeScript() {
  return String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write('Usage: claude [options]\n'); process.exit(0); }
const log = (entry) => fs.appendFileSync(process.env.PRTS_FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n');
const result = (text, sessionId) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }) + '\n';
const stubborn = fs.existsSync(process.env.PRTS_FAKE_STUBBORN);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  log({ started: true, stubborn });
  if (!stubborn) {
    process.stdout.write(result('clean reply', '${CLEAN_SESSION}'));
    process.exit(0);
  }
  process.on('SIGTERM', () => {
    setTimeout(() => {
      process.stdout.write(result('late output', '${LATE_SESSION}'));
      process.exit(143);
    }, 300);
  });
  setTimeout(() => process.exit(0), 20000);
});
`.replace("${CLEAN_SESSION}", CLEAN_SESSION).replace("${LATE_SESSION}", LATE_SESSION);
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
// src/main modules (scripts/run-tests.js may load several files per process).
function setup(t, { net = null } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prts-cancel-")));
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
    PRTS_FAKE_CLAUDE_LOG: path.join(tmp, "claude-calls.log"),
    PRTS_FAKE_STUBBORN: path.join(tmp, "stubborn.flag")
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
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    net: net || { fetch: async () => { throw new Error("net.fetch not stubbed"); } }
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
  settings.set({ chatCwd: workspace, vibeCodingMode: "companion" });
  const chat = require(path.join(SRC, "chat.js"));
  const statuses = [];
  chat.subscribe((event) => {
    if (event.kind === "status") statuses.push(event);
  });
  const idles = () => statuses.filter((event) => event.status === "idle");
  const startedTurns = () =>
    (fs.existsSync(env.PRTS_FAKE_CLAUDE_LOG) ? fs.readFileSync(env.PRTS_FAKE_CLAUDE_LOG, "utf8") : "")
      .split("\n").filter(Boolean).length;
  return { chat, settings, fakeClaude, stubbornFlag: env.PRTS_FAKE_STUBBORN, statuses, idles, startedTurns };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

function selectFakeClaude(t, ctx) {
  ctx.settings.set({ chatProvider: "claude" });
  const availability = ctx.chat.refreshProviderAvailability();
  if (availability.providers.claude.command !== ctx.fakeClaude) {
    t.skip(`fake claude not selected (${availability.providers.claude.command}); not launching a real CLI`);
    return false;
  }
  return true;
}

function historyText(chat) {
  return chat.getHistory().map((entry) => entry.text || "").join("\n");
}

test("cancel on a lingering CLI turn: one idle(cancelled), late output dropped, next turn clean", async (t) => {
  const ctx = setup(t);
  if (!selectFakeClaude(t, ctx)) return;
  const { chat, stubbornFlag, idles, startedTurns } = ctx;

  fs.writeFileSync(stubbornFlag, "1");
  assert.equal(chat.send("first").ok, true);
  await waitFor(() => startedTurns() === 1);
  assert.equal(chat.isBusy(), true);

  // "New Conversation" while the turn runs: cancel + drop the session ids.
  chat.clear();
  assert.equal(chat.isBusy(), false, "the slot is free right away");
  await waitFor(() => idles().length > 0);
  await sleep(200); // room for a duplicate idle from the close handler
  assert.equal(idles().length, 1, "exactly one idle for the cancelled turn");
  assert.equal(idles()[0].cancelled, true);
  assert.equal(chat.getSessionIds().claude, null, "the dying process's late result must not re-adopt its session id");
  assert.ok(!historyText(chat).includes("late output"), "late output from the cancelled process is dropped");

  // Next turn: the Stop from the previous turn must not end this one as cancelled.
  fs.rmSync(stubbornFlag);
  ctx.statuses.length = 0;
  assert.equal(chat.send("second").ok, true);
  await waitFor(() => idles().length > 0);
  await sleep(100);
  // A Claude turn reports idle at its `result` event and again at close.
  assert.ok(idles().length <= 2, JSON.stringify(ctx.statuses));
  assert.ok(idles().every((idle) => idle.cancelled === undefined), "a clean turn is not reported as cancelled");
  assert.ok(idles().every((idle) => idle.error === undefined));
  assert.ok(historyText(chat).includes("clean reply"));
  assert.equal(chat.getSessionIds().claude, CLEAN_SESSION);
});

test("a turn sent while the cancelled process is still dying is never touched by it", async (t) => {
  const ctx = setup(t);
  if (!selectFakeClaude(t, ctx)) return;
  const { chat, stubbornFlag, idles, startedTurns } = ctx;

  fs.writeFileSync(stubbornFlag, "1");
  assert.equal(chat.send("first").ok, true);
  await waitFor(() => startedTurns() === 1);
  chat.cancel();
  // Resend immediately: the first process is still alive for ~300ms.
  fs.rmSync(stubbornFlag);
  assert.equal(chat.send("second").ok, true);
  await waitFor(() => startedTurns() === 2);
  await waitFor(() => idles().length > 0);
  // Wait past the first process's exit so its close handler had its chance.
  await sleep(700);
  // Only the live turn reports idle (result event + close); the dying one
  // must not add a cancelled idle or any other.
  assert.ok(idles().length <= 2, JSON.stringify(ctx.statuses));
  assert.ok(idles().every((idle) => idle.cancelled === undefined), JSON.stringify(ctx.statuses));
  assert.ok(historyText(chat).includes("clean reply"));
  assert.ok(!historyText(chat).includes("late output"));
  assert.equal(chat.getSessionIds().claude, CLEAN_SESSION);
  assert.equal(chat.isBusy(), false);
});

test("priestess backend: cancel aborts the request and still finishes the turn once", async (t) => {
  const fetchCalls = [];
  let mode = "hang";
  const net = {
    fetch: (_url, options) =>
      new Promise((_resolve, reject) => {
        fetchCalls.push(options);
        if (mode === "fail") {
          reject(new Error("boom"));
          return;
        }
        // Hangs until cancel() aborts the signal, like a server that never answers.
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      })
  };
  const ctx = setup(t, { net });
  const { chat, settings, idles } = ctx;
  settings.set({ priestessEnabled: true, priestessBaseUrl: "http://127.0.0.1:9/", chatProvider: "priestess" });
  const availability = chat.refreshProviderAvailability();
  assert.equal(availability.activeProvider, "priestess");

  assert.equal(chat.send("hi").ok, true);
  await waitFor(() => fetchCalls.length === 1);
  assert.equal(chat.isBusy(), true);
  chat.cancel();
  assert.equal(chat.isBusy(), false);
  await waitFor(() => idles().length > 0);
  await sleep(100);
  assert.equal(idles().length, 1, "the AbortError finishes the cancelled turn exactly once");
  assert.equal(idles()[0].cancelled, true);

  // The next turn fails on its own terms — not as a leftover "cancelled".
  mode = "fail";
  ctx.statuses.length = 0;
  assert.equal(chat.send("again").ok, true);
  await waitFor(() => idles().length > 0);
  await sleep(100);
  assert.equal(idles().length, 1);
  assert.equal(idles()[0].cancelled, undefined);
  assert.match(String(idles()[0].error), /boom/);
  assert.equal(chat.isBusy(), false);
});
