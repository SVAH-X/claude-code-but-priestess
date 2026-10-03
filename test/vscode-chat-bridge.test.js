const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Drives real VS Code bridge turns (vscode-chat.send) through the real
// chat.buildProviderInvocation / persona prompt, with the CLI subprocess
// replaced by an in-memory fake that replays stream-json. Pins:
//   - the assistant placeholder is published before the first chunk, so the
//     webview can apply chunks as they stream;
//   - the shared transcript goes out on the first turn of a CLI session only;
//   - the persona-prompt temp dir is removed after a turn and after cancel;
//   - popover state (attachments, cat mode) never reaches a VS Code turn;
//   - archive writes are pruned like the popover's;
//   - validator notices land in the VS Code history, not the popover's;
//   - Codex reasoning summaries stay out of the reply and the archive;
//   - a selection already inlined in the message is sent and stored once.
//
// electron is a devDependency and absent on CI, so it is intercepted via
// Module._load; src/main modules are purged from the require cache before and
// after so other test files' electron fakes never bleed in.

const SRC_MAIN = path.resolve(__dirname, "..", "src", "main") + path.sep;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-vscode-bridge-"));
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
for (const name of ["claude", "codex"]) {
  // Never run: cli-spawn is stubbed. They only have to exist on PATH so the
  // provider scan reports both CLIs as installed.
  for (const file of process.platform === "win32" ? [`${name}.cmd`] : [name]) {
    fs.writeFileSync(path.join(binDir, file), "", "utf8");
    fs.chmodSync(path.join(binDir, file), 0o755);
  }
}
const previousPath = process.env.PATH;
process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;

function purgeSrcMain() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_MAIN)) delete require.cache[key];
  }
}

const electronMock = {
  app: { getPath: () => tmp, getVersion: () => "0.0.0", isPackaged: false },
  shell: { openExternal: async () => {}, openPath: async () => {} },
  Notification: class { show() {} static isSupported() { return false; } },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1, height: 1 }, scaleFactor: 1 }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  net: { fetch: async () => { throw new Error("network is not used in this test"); } }
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronMock;
  return originalLoad.apply(this, arguments);
};
purgeSrcMain();

function installModuleStub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
}

// A ChildProcess stand-in: stdout is fed by the test, stdin is captured.
function fakeProc() {
  const proc = new EventEmitter();
  let stdinText = "";
  proc.stdin = new PassThrough();
  proc.stdin.on("data", (chunk) => { stdinText += chunk.toString(); });
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 4242;
  proc.kill = () => true;
  proc.emitLine = (event) => proc.stdout.write(JSON.stringify(event) + "\n");
  proc.finish = (code = 0) => { proc.stdout.end(); proc.stderr.end(); proc.emit("close", code); };
  proc.stdinText = () => stdinText;
  return proc;
}

const spawns = [];
installModuleStub("../src/main/cli-spawn", {
  spawnCli: (command, args) => {
    const proc = fakeProc();
    // The prompt file is removed when the turn ends: read it now.
    const fileAt = args.indexOf("--append-system-prompt-file");
    const inlineAt = args.indexOf("--append-system-prompt");
    const systemPrompt = fileAt >= 0
      ? fs.readFileSync(args[fileAt + 1], "utf8")
      : inlineAt >= 0 ? args[inlineAt + 1] : "";
    // The temp dir this turn's prompt file lives in. Checked by path, never by
    // scanning os.tmpdir(): other test files create prts-claude-* dirs of
    // their own in parallel `node --test` processes.
    const promptDir = fileAt >= 0 ? path.dirname(args[fileAt + 1]) : null;
    spawns.push({ command, args, proc, systemPrompt, promptDir });
    return proc;
  },
  spawnCliSync: (command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
    if (args[0] === "--help") {
      return { status: 0, stdout: "  --effort <level>  Effort level (choices: low, medium, high)\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "", error: new Error("not stubbed") };
  },
  killProcessTree: () => {}
});
installModuleStub("../src/main/ws-server", { getVscodeWorkspace: () => null });

const settings = require("../src/main/settings");
const persona = require("../src/main/persona");
const chat = require("../src/main/chat");
const vscodeChat = require("../src/main/vscode-chat");
settings.set({ chatProvider: "claude", chatCwd: tmp, vibeCodingMode: "companion", claudeReasoningEffort: "" });

const events = [];
// History events carry the live entry objects (a placeholder's text fills in
// as chunks arrive), so each one is snapshotted as it is emitted.
vscodeChat.subscribe((event) => {
  events.push(event.kind === "history"
    ? { kind: "history", history: event.history.map((entry) => ({ ...entry })) }
    : event);
});

test.after(() => {
  vscodeChat.cancel();
  chat.cancel();
  Module._load = originalLoad;
  process.env.PATH = previousPath;
  purgeSrcMain();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startTurn(text, context = null) {
  const before = spawns.length;
  const result = vscodeChat.send(text, context);
  assert.equal(result.ok, true, `send failed: ${JSON.stringify(result)}`);
  await waitFor(() => spawns.length > before, "the CLI to be spawned");
  return spawns[spawns.length - 1];
}

async function finishTurn(spawn, lines) {
  for (const line of lines) spawn.proc.emitLine(line);
  await settle();
  spawn.proc.finish(0);
  await waitFor(() => !vscodeChat.isBusy(), "the turn to go idle");
}

const promptDirExists = (spawn) => Boolean(spawn.promptDir) && fs.existsSync(spawn.promptDir);
const lastAssistant = () => [...vscodeChat.getHistory()].reverse().find((entry) => entry.role === "assistant");
const archiveLines = () => fs.readFileSync(persona.conversationArchivePath(), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const TRANSCRIPT_HEADER = "【当前共享对话摘录】";

test("a fresh VS Code Claude turn streams behind its placeholder and leaves no temp dir", async () => {
  vscodeChat.hydrate({
    history: [
      { role: "user", text: "昨天那个 bug 修了吗", ts: 1 },
      { role: "assistant", text: "修了，在 parser.js。", ts: 2 }
    ],
    sessionIds: {}
  });
  events.length = 0;

  const spawn = await startTurn("帮我看看这个函数");
  assert.ok(spawn.args.includes("--append-system-prompt-file"), "the persona prompt travels by file");
  assert.ok(path.basename(spawn.promptDir).startsWith("prts-claude-"), "the prompt file lives in a prts-claude-* temp dir");
  assert.ok(!spawn.args.includes("--resume"), "a fresh session is not resumed");
  assert.ok(spawn.systemPrompt.includes(TRANSCRIPT_HEADER), "the first turn of a session carries the transcript");
  assert.ok(spawn.systemPrompt.includes("昨天那个 bug 修了吗"));
  assert.ok(promptDirExists(spawn), "the prompt file's temp dir exists while the CLI runs");

  await finishTurn(spawn, [
    { type: "system", subtype: "init", session_id: "sess-1" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "好的，" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "博士。" } } },
    { type: "result", session_id: "sess-1", is_error: false, result: "好的，博士。" }
  ]);

  const placeholderAt = events.findIndex((event) =>
    event.kind === "history" && event.history.at(-1)?.role === "assistant" && event.history.at(-1).text === "");
  const firstChunkAt = events.findIndex((event) => event.kind === "chunk");
  assert.ok(placeholderAt >= 0, "the assistant placeholder is published as history");
  assert.ok(firstChunkAt > placeholderAt, "chunks arrive after the placeholder the webview applies them to");
  assert.equal(events.at(-1).kind, "status");
  assert.equal(events.at(-1).status, "idle");
  assert.equal(events.at(-1).error, undefined);
  assert.equal(lastAssistant().text, "好的，博士。");
  assert.equal(vscodeChat.getSessionId(), "sess-1");
  assert.equal(promptDirExists(spawn), false, "the persona prompt temp dir is removed when the turn ends");

  const archived = archiveLines();
  assert.deepEqual(archived.slice(-2).map((entry) => [entry.role, entry.text]), [
    ["user", "帮我看看这个函数"],
    ["assistant", "好的，博士。"]
  ]);
});

test("a resumed turn carries no transcript, and cancel releases the temp dir too", async () => {
  const spawn = await startTurn("继续");
  assert.ok(promptDirExists(spawn), "the prompt file's temp dir exists while the CLI runs");
  assert.deepEqual(spawn.args.slice(spawn.args.indexOf("--resume"), spawn.args.indexOf("--resume") + 2), ["--resume", "sess-1"]);
  assert.ok(!spawn.systemPrompt.includes(TRANSCRIPT_HEADER), "a resumed session is not re-sent the transcript");
  assert.ok(!spawn.systemPrompt.includes("昨天那个 bug 修了吗"));

  vscodeChat.cancel();
  await settle();
  assert.equal(vscodeChat.isBusy(), false);
  assert.equal(promptDirExists(spawn), false, "cancel removes the persona prompt temp dir");
});

test("popover attachments and cat mode never reach a VS Code turn", async () => {
  const attachDir = path.join(tmp, "attach");
  fs.mkdirSync(attachDir, { recursive: true });
  const doc = path.join(attachDir, "notes.txt");
  fs.writeFileSync(doc, "POPOVER_ATTACHMENT_MARKER", "utf8");
  const image = path.join(attachDir, "pic.png");
  fs.writeFileSync(image, "");
  chat.setChatCatMode({ cat: true, mood: "normal" });

  const before = spawns.length;
  assert.equal(chat.send("看看这些", [doc, image]).ok, true);
  await waitFor(() => spawns.length > before, "the popover turn to spawn");
  const popover = spawns[spawns.length - 1];
  assert.ok(popover.systemPrompt.includes("POPOVER_ATTACHMENT_MARKER"), "sanity: the popover turn carries its attachment");
  assert.ok(popover.args.includes("--add-dir"), "sanity: the popover turn grants the image dir");
  assert.ok(popover.systemPrompt.includes("普猫猫"), "sanity: the popover turn is in cat mode");

  const spawn = await startTurn("这个函数怎么样");
  assert.ok(!spawn.systemPrompt.includes("POPOVER_ATTACHMENT_MARKER"), "no popover attachment in the VS Code prompt");
  assert.ok(!spawn.args.includes("--add-dir"), "no popover image dir in the VS Code argv");
  assert.ok(!spawn.systemPrompt.includes("普猫猫"), "no popover cat mode in the VS Code prompt");
  assert.ok(spawn.systemPrompt.includes("【编程时的你】"), "the coding voice still rides on the VS Code turn");

  vscodeChat.cancel();
  chat.cancel();
  chat.setChatCatMode({ cat: false });
  await settle();
});

test("validator notices raised for a VS Code turn land in the VS Code history", async () => {
  settings.set({ claudeReasoningEffort: "max" });
  const popoverBefore = chat.getHistory().length;
  const spawn = await startTurn("再看一眼");
  assert.ok(!spawn.args.includes("--effort"), "the unsupported effort is dropped");
  const history = vscodeChat.getHistory();
  const noticeAt = history.findIndex((entry) => entry.role === "system" && entry.text.includes("max"));
  assert.ok(noticeAt >= 0, "the effort notice is in the VS Code history");
  assert.equal(history[noticeAt + 1]?.role, "assistant", "the notice precedes the reply placeholder");
  assert.equal(chat.getHistory().length, popoverBefore, "nothing landed in the popover history");
  assert.equal(settings.get("claudeReasoningEffort"), "");
  vscodeChat.cancel();
  await settle();
});

test("Codex reasoning summaries stay out of the reply, and archive writes are pruned", async () => {
  settings.set({ chatProvider: "codex" });
  // Bloat the shared archive past the 5MB cap: the bridge's own writes must
  // trigger the same prune the popover uses.
  const archive = persona.ensureConversationArchiveFile();
  const filler = JSON.stringify({ ts: 1, role: "user", provider: "claude", text: "x".repeat(1000) }) + "\n";
  fs.writeFileSync(archive, filler.repeat(Math.ceil((5.5 * 1024 * 1024) / filler.length)), "utf8");
  assert.ok(fs.statSync(archive).size > 5 * 1024 * 1024);

  const spawn = await startTurn("解释一下这段");
  assert.equal(spawn.args[0], "exec");
  await finishTurn(spawn, [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "**Weighing the options**" } },
    { type: "item.started", item: { id: "m1", type: "agent_message", text: "" } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "这是答案。" } },
    { type: "turn.completed" }
  ]);
  assert.equal(lastAssistant().text, "这是答案。");
  assert.equal(vscodeChat.getSessionId(), "thread-1");

  assert.ok(fs.statSync(archive).size <= 4 * 1024 * 1024 + filler.length, "the archive was pruned to its target size");
  const archived = archiveLines();
  assert.equal(archived.at(-1).text, "这是答案。");
  assert.equal(archived.at(-2).text, "解释一下这段");
  assert.ok(archived.every((entry) => entry.text !== "**Weighing the options**"), "no reasoning summary was archived");
  settings.set({ chatProvider: "claude" });
});

test("a selection already inlined in the message is sent and stored once", async () => {
  const code = "const a = 1;\nconst b = 2;";
  const spawn = await startTurn(`【来自 a.ts L1-L2】\n${code}`, {
    activeFile: path.join(tmp, "a.ts"),
    activeFileLanguage: "typescript",
    cursorLine: 1,
    cursorColumn: 1,
    selection: { text: code, startLine: 1, endLine: 2 }
  });
  await settle();
  const prompt = spawn.proc.stdinText();
  assert.equal(prompt.split("const a = 1;").length - 1, 1, "the selection appears once in the prompt");
  assert.ok(prompt.includes("活动文件: a.ts"), "the rest of the editor context still goes through");
  const user = [...vscodeChat.getHistory()].reverse().find((entry) => entry.role === "user");
  assert.ok(user.text.includes(code));
  assert.equal(user.context.selection, undefined, "the history entry does not store the selection a second time");
  assert.equal(user.context.activeFileLanguage, "typescript");
  vscodeChat.cancel();
  await settle();
});
