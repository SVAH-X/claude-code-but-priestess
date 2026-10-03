const test = require("node:test");
const assert = require("node:assert/strict");

const {
  attachmentTempName,
  buildCodexExecArgs,
  codexSessionIdFromEvent,
  createBackoffRetry,
  normalizeCwd,
  resolveResumeSessionId,
  silentTurnVibeMode
} = require("../src/main/chat-runtime");

test("downscaled attachments from different folders keep distinct names", () => {
  // Same basename, different folders: without the index the second write lands
  // on the first file and the backend sees one picture twice.
  assert.notEqual(
    attachmentTempName("/a/shot.png", 0),
    attachmentTempName("/b/shot.png", 1)
  );
  assert.equal(attachmentTempName("/a/shot.png", 0), "00-shot.png");
  assert.equal(attachmentTempName("/b/shot.jpeg", 1), "01-shot.png");
  assert.equal(attachmentTempName("C:\\pics\\shot.PNG", 2), "02-shot.png");
  // Ordering stays lexicographic past nine so temp listings read in turn order.
  assert.ok(attachmentTempName("/a/x.png", 9) < attachmentTempName("/a/x.png", 10));
});

test("session plans can force a fresh main-window session", () => {
  assert.equal(
    resolveResumeSessionId("codex", { resumeSessionId: null }, null),
    null
  );
  assert.equal(
    resolveResumeSessionId("codex", { resumeSessionId: "main-session" }, null),
    "main-session"
  );
});

test("custom session maps stay isolated from the main window", () => {
  assert.equal(
    resolveResumeSessionId(
      "codex",
      { resumeSessionId: "main-session" },
      { codex: "vscode-session" }
    ),
    "vscode-session"
  );
  assert.equal(
    resolveResumeSessionId(
      "claude",
      { resumeSessionId: "main-session" },
      {}
    ),
    null
  );
});

test("resumed Codex invocations put parent options before resume", () => {
  const invocation = buildCodexExecArgs({
    cwd: "/workspace",
    mode: "advisor",
    resumeSessionId: "00000000-0000-0000-0000-000000000000",
    model: "gpt-test",
    reasoningEffort: "ultra",
    screenshotPath: "/tmp/screen.png",
    attachmentArgs: ["-i", "/tmp/photo.png"],
    memoryDir: "/memory"
  });

  const resumeIndex = invocation.args.indexOf("resume");
  assert.ok(resumeIndex > 0);
  assert.ok(invocation.args.indexOf("-C") < resumeIndex);
  assert.ok(invocation.args.indexOf("-s") < resumeIndex);
  assert.ok(invocation.args.indexOf("--model") < resumeIndex);
  assert.ok(invocation.args.indexOf("-c") < resumeIndex);
  assert.equal(
    invocation.args[invocation.args.indexOf("-c") + 1],
    'model_reasoning_effort="ultra"'
  );
  assert.ok(invocation.args.indexOf("-i") > resumeIndex);
  assert.equal(invocation.args.includes("--add-dir"), false);
  assert.equal(invocation.resumed, true);
});

test("fresh Codex invocations never receive an empty cwd", () => {
  const invocation = buildCodexExecArgs({
    cwd: "",
    mode: "companion",
    memoryDir: "/memory"
  });
  const cwdIndex = invocation.args.indexOf("-C");
  assert.notEqual(invocation.args[cwdIndex + 1], "");
  assert.equal(invocation.args.includes("resume"), false);
  assert.equal(invocation.resumed, false);
  assert.equal(normalizeCwd("", "/safe/home"), "/safe/home");
});

test("maintenance confines its writable workspace to the memory directory", () => {
  const invocation = buildCodexExecArgs({
    cwd: "/project",
    mode: "maintenance",
    memoryDir: "/memory"
  });
  const cwdIndex = invocation.args.indexOf("-C");
  const sandboxIndex = invocation.args.indexOf("-s");
  assert.equal(invocation.args[cwdIndex + 1], "/memory");
  assert.equal(invocation.args[sandboxIndex + 1], "workspace-write");
  assert.equal(invocation.args.includes("--add-dir"), false);
});

test("silent turns pick their permission mode; editor-context checks never run as agent", () => {
  // Plain 老婆模式 look-ins keep the Doctor's agent mode, as before.
  assert.equal(silentTurnVibeMode("proactive", "agent"), "agent");
  assert.equal(silentTurnVibeMode("proactive", "advisor"), "advisor");
  assert.equal(silentTurnVibeMode("proactive", "companion"), "advisor");
  // Checks carrying VS Code context are capped at read-only.
  for (const mode of ["companion", "advisor", "agent"]) {
    assert.equal(silentTurnVibeMode("proactive", mode, { editorContext: true }), "advisor");
  }
  assert.equal(silentTurnVibeMode("maintenance", "agent"), "maintenance");
  assert.equal(silentTurnVibeMode(null, "agent"), null);
});

test("Codex session ids come only from session/thread/conversation fields", () => {
  assert.equal(codexSessionIdFromEvent({ type: "thread.started", thread_id: "t-1" }), "t-1");
  assert.equal(codexSessionIdFromEvent({ type: "session.created", session_id: "s-1", thread_id: "t-1" }), "s-1");
  assert.equal(codexSessionIdFromEvent({ type: "session", conversationId: " c-1 " }), "c-1");
  // A per-event id is not a session id — never resume it.
  assert.equal(codexSessionIdFromEvent({ type: "session.created", id: "evt-1" }), null);
  assert.equal(codexSessionIdFromEvent({ type: "thread.started", thread_id: "", id: "evt-2" }), null);
  assert.equal(codexSessionIdFromEvent({ type: "thread.started", thread_id: 42 }), null);
  assert.equal(codexSessionIdFromEvent(null), null);
});

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    fire() {
      const timer = pending.shift();
      timer.fn();
      return timer.ms;
    }
  };
}

test("backoff retry doubles up to its cap and then stops scheduling", () => {
  const timers = fakeTimers();
  const retry = createBackoffRetry({ baseMs: 5000, maxMs: 30000, maxAttempts: 5, ...timers });
  let runs = 0;
  const delays = [];
  const again = () => {
    runs += 1;
    retry.schedule(again);
  };
  assert.equal(retry.schedule(again), true);
  while (timers.pending.length) delays.push(timers.fire());
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000]);
  assert.equal(runs, 5);
  assert.equal(retry.pending, false);
  assert.equal(retry.schedule(again), false, "exhausted retries must report it");
  assert.equal(timers.pending.length, 0);
});

test("backoff retry keeps a single timer and reset restores the budget", () => {
  const timers = fakeTimers();
  const retry = createBackoffRetry({ baseMs: 100, maxMs: 1000, maxAttempts: 2, ...timers });
  retry.schedule(() => {});
  retry.schedule(() => {});
  assert.equal(timers.pending.length, 1, "rescheduling replaces the pending timer");
  assert.equal(timers.pending[0].ms, 200);
  assert.equal(retry.schedule(() => {}), false);
  assert.equal(timers.pending.length, 0, "giving up cancels the pending timer");

  retry.reset();
  assert.equal(retry.attempts, 0);
  assert.equal(retry.schedule(() => {}), true);
  assert.equal(timers.pending[0].ms, 100);
  retry.reset();
  assert.equal(timers.pending.length, 0, "reset cancels the pending timer");
  assert.equal(retry.pending, false);
});
