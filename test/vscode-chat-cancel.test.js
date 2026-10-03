const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// VS Code bridge Stop/Clear/restore correctness (vscode-chat.js):
//   - cancel() while idle (Clear / New Conversation call it unconditionally)
//     emits no status — the webview would flash a spurious "cancelled";
//   - conversation:restore during a running turn is refused instead of
//     swapping the history out from under the reply (which dropped it);
//   - a real Stop mid-turn still reports idle(cancelled), once, and the next
//     turn is clean.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-vscode-cancel-"));

const electronMock = {
  app: { getPath: () => tmp },
  shell: { openExternal: async () => {}, openPath: async () => {} },
  Notification: class { show() {} }
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronMock;
  return originalLoad.apply(this, arguments);
};

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

// Replies ~400ms after the prompt arrived, so the turn is observably running.
function writeFakeCodex(binDir) {
  const script = path.join(binDir, "fake-codex.js");
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  setTimeout(() => {",
      "    process.stdout.write(fs.readFileSync(process.env.FAKE_CODEX_EVENTS, 'utf8'));",
      "    process.exit(0);",
      "  }, 400);",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  if (process.platform === "win32") {
    const cmd = path.join(binDir, "codex.cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(binDir, "codex");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.js" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const fakeCodex = writeFakeCodex(binDir);
const eventsFile = path.join(tmp, "events.jsonl");
const previousEventsEnv = process.env.FAKE_CODEX_EVENTS;
process.env.FAKE_CODEX_EVENTS = eventsFile;
fs.writeFileSync(
  eventsFile,
  [
    { type: "item.completed", item: { type: "agent_message", text: "回复来了" } },
    { type: "turn.completed" }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  "utf8"
);

installModuleStub("../src/main/chat", {
  getProviderAvailability: () => ({
    activeProvider: "codex",
    providers: {
      codex: { available: true, command: fakeCodex },
      claude: { available: false, command: null },
      priestess: { available: false }
    }
  }),
  buildProviderInvocation: (provider, message) => ({ command: fakeCodex, args: ["exec", "--json", "-"], stdin: message }),
  // The fake invocation above owns no temp dir; the real one is a no-op on it.
  cleanupInvocation: () => {}
});
installModuleStub("../src/main/ws-server", { getVscodeWorkspace: () => null });

const vscodeChat = require("../src/main/vscode-chat");
const statuses = [];
vscodeChat.subscribe((event) => {
  if (event.kind === "status") statuses.push(event);
});
const idles = () => statuses.filter((event) => event.status === "idle");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

test.after(() => {
  Module._load = originalLoad;
  if (previousEventsEnv === undefined) delete process.env.FAKE_CODEX_EVENTS;
  else process.env.FAKE_CODEX_EVENTS = previousEventsEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cancel / clear / startFresh while idle emit no cancelled status", () => {
  statuses.length = 0;
  vscodeChat.cancel();
  vscodeChat.clear();
  vscodeChat.startFresh();
  assert.deepEqual(statuses, []);
});

test("conversation:restore during a running turn is refused and the reply survives", async () => {
  statuses.length = 0;
  const persisted = { history: [{ role: "user", text: "旧对话", id: "old_1" }], sessionIds: {} };
  fs.writeFileSync(path.join(tmp, "vscode-conversation.json"), JSON.stringify(persisted), "utf8");

  assert.equal(vscodeChat.send("你好", null).ok, true);
  await waitFor(() => vscodeChat.isBusy());
  assert.equal(vscodeChat.loadConversation(), false, "refused mid-turn");
  assert.ok(vscodeChat.getHistory().some((entry) => entry.text === "你好"), "the running turn keeps its history");

  await waitFor(() => idles().length > 0);
  assert.equal(idles().length, 1);
  assert.equal(idles()[0].cancelled, undefined);
  assert.ok(vscodeChat.getHistory().some((entry) => entry.role === "assistant" && entry.text === "回复来了"), "the reply landed");
  assert.equal(vscodeChat.loadConversation(), true, "restore works again once idle");
});

test("Stop mid-turn reports idle(cancelled) once and the next turn is clean", async () => {
  statuses.length = 0;
  assert.equal(vscodeChat.send("再来", null).ok, true);
  await waitFor(() => vscodeChat.isBusy());
  vscodeChat.cancel();
  assert.equal(vscodeChat.isBusy(), false);
  await sleep(700); // past the fake's reply — the dead process must stay ignored
  assert.equal(idles().length, 1, JSON.stringify(statuses));
  assert.equal(idles()[0].cancelled, true);

  statuses.length = 0;
  assert.equal(vscodeChat.send("第三轮", null).ok, true);
  await waitFor(() => idles().length > 0);
  assert.equal(idles().length, 1);
  assert.equal(idles()[0].cancelled, undefined);
  assert.equal(idles()[0].error, undefined);
});
