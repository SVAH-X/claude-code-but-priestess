const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Runs real VS Code bridge turns (vscode-chat.send) against a fake Codex CLI
// that replays a scripted JSONL stream, to pin two things:
//   - only session/thread ids are kept as the Codex resume id; a per-event `id`
//     on a session-typed event must not be stored (it would make the next turn
//     `codex exec resume` a session that does not exist);
//   - a finished Codex turn reaches "idle" (the close handler used to throw a
//     ReferenceError on `errorText`, crashing out of the Electron main process).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-vscode-codex-"));

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
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
}

// The fake CLI reads the prompt from stdin (as `codex exec ... -` does), then
// prints the JSONL file named by FAKE_CODEX_EVENTS and exits normally.
function writeFakeCodex(binDir) {
  const script = path.join(binDir, "fake-codex.js");
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(fs.readFileSync(process.env.FAKE_CODEX_EVENTS, 'utf8'));",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  if (process.platform === "win32") {
    // Goes through cli-spawn's cmd.exe path, like an npm-installed codex.cmd.
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

const invocations = [];
installModuleStub("../src/main/chat", {
  getProviderAvailability: () => ({
    activeProvider: "codex",
    providers: {
      codex: { available: true, command: fakeCodex },
      claude: { available: false, command: null },
      priestess: { available: false }
    }
  }),
  buildProviderInvocation: (provider, message, cwd, mode, screenshot, transcript, plan, sessionIds) => {
    invocations.push({ provider, mode, resumeId: sessionIds?.codex || null });
    return { command: fakeCodex, args: ["exec", "--json", "-"], stdin: message };
  }
});
installModuleStub("../src/main/ws-server", { getVscodeWorkspace: () => null });

const vscodeChat = require("../src/main/vscode-chat");

test.after(() => {
  Module._load = originalLoad;
  if (previousEventsEnv === undefined) delete process.env.FAKE_CODEX_EVENTS;
  else process.env.FAKE_CODEX_EVENTS = previousEventsEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runTurn(text, events) {
  fs.writeFileSync(eventsFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("the Codex turn never went idle"));
    }, 15000);
    const unsubscribe = vscodeChat.subscribe((event) => {
      if (event.kind !== "status" || event.status !== "idle") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
    const result = vscodeChat.send(text, null);
    if (!result?.ok) {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error(`send failed: ${JSON.stringify(result)}`));
    }
  });
}

const reply = (text) => ({ type: "item.completed", item: { type: "agent_message", text } });

test("a per-event id on a session event is never kept as the Codex resume id", async () => {
  const idle = await runTurn("第一轮", [
    { type: "session.created", id: "evt_not_a_session" },
    reply("收到"),
    { type: "turn.completed" }
  ]);
  assert.equal(idle.error, undefined);
  assert.equal(vscodeChat.getSessionId(), null);
});

test("the thread id from thread.started is kept and resumed next turn", async () => {
  const idle = await runTurn("第二轮", [
    { type: "thread.started", thread_id: "thread_42", id: "evt_other" },
    reply("好的"),
    { type: "turn.completed" }
  ]);
  assert.equal(idle.error, undefined);
  assert.equal(vscodeChat.getSessionId(), "thread_42");

  await runTurn("第三轮", [reply("继续"), { type: "turn.completed" }]);
  assert.equal(invocations[invocations.length - 1].resumeId, "thread_42");
  // The VS Code side never runs Codex with full permissions.
  assert.ok(invocations.every((call) => call.mode !== "agent"));
});
