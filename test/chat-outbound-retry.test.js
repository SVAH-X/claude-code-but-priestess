const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Drives the popover chat (chat.js) into "a message is queued behind a running
// turn, then no backend is available any more" and checks the queue retry is
// bounded: it backs off, gives up after a few attempts, and leaves the UI idle
// with a visible note instead of re-probing the CLIs every 5s forever.
//
// The built-in backend (priestess-provider, stubbed) runs the first turn so no
// real CLI is needed; disabling it in settings mid-turn leaves nothing
// available. CLI probes are stubbed to fail, so the test behaves the same on a
// machine with or without Claude Code / Codex installed.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-queue-retry-"));

const electronMock = {
  app: { getPath: () => tmp },
  shell: { openExternal: async () => {}, openPath: async () => {} },
  Notification: class { show() {} },
  net: { fetch: async () => { throw new Error("network is not used in this test"); } }
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

installModuleStub("../src/main/cli-spawn", {
  spawnCli: () => { throw new Error("no CLI turn should start in this test"); },
  spawnCliSync: () => ({ status: 1, stdout: "", stderr: "" })
});

const turns = [];
installModuleStub("../src/main/priestess-provider", {
  startTurn: (opts) => {
    turns.push(opts);
    return { kill() {} };
  },
  chatCompletionsUrl: () => null,
  testConnection: async () => ({ ok: false })
});

// Hand chat.js a retry helper on fake timers. chat.js destructures the factory
// when it loads, so the wrapper must be in place before the first require.
const timers = [];
const runtime = require("../src/main/chat-runtime");
const realCreateBackoffRetry = runtime.createBackoffRetry;
runtime.createBackoffRetry = (options) =>
  realCreateBackoffRetry({
    ...options,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    }
  });

const settings = require("../src/main/settings");
const chat = require("../src/main/chat");

const events = [];
chat.subscribe((event) => events.push(event));

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function fireNextTimer() {
  const timer = timers.shift();
  assert.ok(timer, "a retry timer should be pending");
  timer.fn();
  await settle();
  return timer.ms;
}

// Starts a built-in-backend turn, queues a second message behind it, then
// turns the only backend off and lets the first turn finish.
async function queueBehindTurnThenLoseBackend(queuedText) {
  settings.set({ chatProvider: "priestess", priestessEnabled: true, priestessBaseUrl: "http://127.0.0.1:9" });
  const first = chat.send("第一条");
  assert.equal(first.ok, true);
  await settle();
  const turn = turns[turns.length - 1];
  assert.ok(turn, "the first turn should have started");
  const queued = chat.send(queuedText);
  assert.equal(queued.queued, true);
  settings.set({ priestessEnabled: false });
  turn.onDone();
  await settle();
}

test("a queued message backs off and is dropped visibly when no backend returns", async () => {
  events.length = 0;
  await queueBehindTurnThenLoseBackend("第二条");
  assert.equal(chat.getOutboundQueueLength(), 1);

  // Bounded loop: a regression that re-arms the retry forever must fail the
  // deepEqual below instead of hanging the test run.
  const delays = [];
  for (let attempt = 0; attempt < 8 && timers.length; attempt += 1) {
    delays.push(await fireNextTimer());
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000]);
  assert.equal(timers.length, 0, "no retry may stay armed after giving up");

  assert.equal(chat.getOutboundQueueLength(), 0);
  assert.equal(chat.isBusy(), false, "proactive turns must not stay blocked by a dead queue");
  const queueEvents = events.filter((event) => event.kind === "queue");
  assert.equal(queueEvents[queueEvents.length - 1].length, 0);
  const statuses = events.filter((event) => event.kind === "status");
  assert.deepEqual(
    { status: statuses[statuses.length - 1].status, error: statuses[statuses.length - 1].error },
    { status: "idle", error: "missing-cli" }
  );
  // The renderer ignores "idle" while anything is queued, so the queue must
  // be emptied (queue event with length 0) before the idle status goes out.
  const emptiedAt = events.findIndex((event) => event.kind === "queue" && event.length === 0);
  const idleAt = events.lastIndexOf(statuses[statuses.length - 1]);
  assert.ok(emptiedAt !== -1 && emptiedAt < idleAt, "queue must be cleared before idle is emitted");
  const notes = chat.getHistory().filter((entry) => entry.role === "system");
  assert.match(notes[notes.length - 1].text, /排队中的 1 条消息没有发出/);
});

test("a queued message is sent once a backend comes back during the backoff", async () => {
  chat.clear();
  events.length = 0;
  const turnsBefore = turns.length;
  await queueBehindTurnThenLoseBackend("第三条");
  assert.equal(await fireNextTimer(), 5000);
  assert.equal(chat.getOutboundQueueLength(), 1, "still no backend after the first retry");

  settings.set({ priestessEnabled: true });
  assert.equal(await fireNextTimer(), 10000);
  assert.equal(chat.getOutboundQueueLength(), 0);
  assert.equal(timers.length, 0, "success must cancel the backoff");
  assert.equal(turns.length, turnsBefore + 2, "the queued message should start its own turn");
  const replay = turns[turns.length - 1];
  assert.ok(
    replay.messages.some((message) => message.role === "user" && String(message.content).includes("第三条")),
    "the replayed turn should carry the queued text"
  );
  replay.onDone();
  await settle();
  assert.equal(chat.isBusy(), false);

  // The budget starts over for the next stall.
  await queueBehindTurnThenLoseBackend("第四条");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
  chat.clear();
  assert.equal(timers.length, 0, "clearing the chat cancels a pending retry");
});
