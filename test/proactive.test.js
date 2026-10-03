const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Pins the proactive gating matrix:
//   - 老婆模式 (waifuMode) runs in every vibeCodingMode, as before PR #32;
//   - each coding check needs its own opt-in, in every mode
//     (vibeCodingDiagnostics; vibeCodingActivityNarration also covers
//     terminal build/test failures);
//   - a terminal failure is consumed once and dropped when stale.
// proactive.js is loaded against stubbed settings/chat/persona/ws-server, so
// no electron, CLI or VS Code is needed.

const MIN = 60 * 1000;
const MODES = ["companion", "advisor", "agent"];
// Captured once: restores go back to the real clock and the real modules
// whatever order after-hooks run in, so nothing leaks into later test files
// when test/run.js runs them all in one process.
const REAL_DATE_NOW = Date.now;
const STUB = Symbol("proactive-test-stub");

function installModuleStub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const current = require.cache[resolved];
  const original = current && current[STUB] ? current[STUB].original : current;
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  stub[STUB] = { original };
  require.cache[resolved] = stub;
  return () => {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  };
}

function loadProactive(t, { settings = {}, ws = {}, now = Date.now() } = {}) {
  const clock = { now };
  const values = {
    waifuMode: false,
    vibeCodingMode: "companion",
    vibeCodingDiagnostics: false,
    vibeCodingActivityNarration: false,
    // start === end disables quiet hours so the test never depends on the wall clock.
    proactiveQuietStart: "00:00",
    proactiveQuietEnd: "00:00",
    ...settings
  };
  const calls = [];
  let pendingTerminalEvent = ws.terminalEvent || null;
  const restores = [
    installModuleStub("../src/main/settings", { get: (key) => values[key], set: () => {} }),
    installModuleStub("../src/main/chat", {
      getProviderAvailability: () => ({ activeProvider: "claude" }),
      isBusy: () => false,
      getLastConversationTs: () => 0,
      sendProactive: (opts) => {
        calls.push(opts);
        return { ok: true };
      },
      sendMaintenance: () => ({ ok: false })
    }),
    installModuleStub("../src/main/persona", { memoryPath: () => "/nonexistent/MEMORY.md" }),
    installModuleStub("../src/main/ws-server", {
      isVscodeActive: () => ws.vscodeActive !== false,
      getLatestDiagnostics: () => ws.diagnostics || null,
      getRecentActivities: () => (ws.activities || []).slice(),
      getLatestTerminalEvent: () => pendingTerminalEvent,
      takeTerminalEvent: () => {
        const evt = pendingTerminalEvent;
        pendingTerminalEvent = null;
        return evt;
      }
    })
  ];
  Date.now = () => clock.now;
  const proactivePath = require.resolve("../src/main/proactive");
  delete require.cache[proactivePath];
  const proactive = require("../src/main/proactive");
  t.after(() => {
    Date.now = REAL_DATE_NOW;
    delete require.cache[proactivePath];
    for (const restore of restores.reverse()) restore();
  });
  return {
    calls,
    clock,
    tick: () => proactive.tick(),
    pendingTerminalEvent: () => pendingTerminalEvent
  };
}

const kindOf = (opts) => {
  if (!opts) return "waifu";
  if (opts.diagnosticContext) return "diagnostics";
  if (opts.diagnosticImprovement) return "improvement";
  if (opts.terminalEvent) return "terminal";
  if (opts.activityContext) return "activity";
  return "unknown";
};

for (const mode of MODES) {
  test(`waifu mode runs in ${mode} mode`, (t) => {
    const h = loadProactive(t, { settings: { waifuMode: true, vibeCodingMode: mode } });
    h.tick();
    assert.deepEqual(h.calls.map(kindOf), ["waifu"]);
  });

  test(`waifu mode off stays quiet in ${mode} mode, even with editor activity`, (t) => {
    const now = Date.now();
    const h = loadProactive(t, {
      now,
      settings: { vibeCodingMode: mode },
      ws: {
        diagnostics: { errors: 3, warnings: 0, totalFilesWithProblems: 1, details: [] },
        activities: [{ kind: "save", detail: "Saved a.ts", timestamp: now }],
        terminalEvent: { kind: "test-fail", command: "npm test", exitCode: 1, at: now }
      }
    });
    h.tick();
    assert.deepEqual(h.calls, []);
    assert.ok(h.pendingTerminalEvent(), "an un-opted terminal event is not consumed");
  });

  test(`diagnostics check needs its opt-in in ${mode} mode`, (t) => {
    const diagnostics = { errors: 2, warnings: 1, totalFilesWithProblems: 1, details: [] };
    const off = loadProactive(t, { settings: { vibeCodingMode: mode }, ws: { diagnostics } });
    off.tick();
    assert.deepEqual(off.calls, []);
    const on = loadProactive(t, {
      settings: { vibeCodingMode: mode, vibeCodingDiagnostics: true },
      ws: { diagnostics }
    });
    on.tick();
    assert.deepEqual(on.calls.map(kindOf), ["diagnostics"]);
  });

  test(`activity narration needs its opt-in in ${mode} mode`, (t) => {
    const now = Date.now();
    const activities = [{ kind: "git-commit", detail: "New commit abc1234", timestamp: now - 30 * 1000 }];
    const off = loadProactive(t, { now, settings: { vibeCodingMode: mode }, ws: { activities } });
    off.tick();
    assert.deepEqual(off.calls, []);
    const on = loadProactive(t, {
      now,
      settings: { vibeCodingMode: mode, vibeCodingActivityNarration: true },
      ws: { activities }
    });
    on.tick();
    assert.deepEqual(on.calls.map(kindOf), ["activity"]);
  });

  test(`terminal failures need the activity opt-in in ${mode} mode`, (t) => {
    const now = Date.now();
    const terminalEvent = { kind: "build-error", command: "tsc", exitCode: 2, at: now - 10 * 1000 };
    const off = loadProactive(t, { now, settings: { vibeCodingMode: mode }, ws: { terminalEvent } });
    off.tick();
    assert.deepEqual(off.calls, []);
    const on = loadProactive(t, {
      now,
      settings: { vibeCodingMode: mode, vibeCodingActivityNarration: true },
      ws: { terminalEvent: { ...terminalEvent } }
    });
    on.tick();
    assert.deepEqual(on.calls.map(kindOf), ["terminal"]);
    assert.deepEqual(on.calls[0].terminalEvent, terminalEvent);
  });
}

test("a terminal failure is narrated once, not every cooldown until the daily cap", (t) => {
  const now = Date.now();
  const h = loadProactive(t, {
    now,
    settings: { vibeCodingMode: "agent", vibeCodingActivityNarration: true },
    ws: { terminalEvent: { kind: "test-fail", command: "npm test", exitCode: 1, at: now } }
  });
  h.tick();
  assert.equal(h.pendingTerminalEvent(), null, "the event is consumed when used");
  for (let i = 0; i < 24 * 60; i += 1) {
    h.clock.now += MIN;
    h.tick();
  }
  assert.deepEqual(h.calls.map(kindOf), ["terminal"]);
});

test("a stale terminal failure is dropped", (t) => {
  const now = Date.now();
  const h = loadProactive(t, {
    now,
    settings: { vibeCodingMode: "advisor", vibeCodingActivityNarration: true },
    ws: { terminalEvent: { kind: "test-fail", command: "npm test", exitCode: 1, at: now - 10 * MIN } }
  });
  h.tick();
  assert.deepEqual(h.calls, []);
});

test("waifu mode still fires alongside opted-in coding checks", (t) => {
  const now = Date.now();
  const h = loadProactive(t, {
    now,
    settings: { waifuMode: true, vibeCodingMode: "companion", vibeCodingActivityNarration: true },
    ws: { terminalEvent: { kind: "test-fail", command: "npm test", exitCode: 1, at: now } }
  });
  h.tick(); // one self-turn per tick: the terminal failure wins this one
  h.clock.now += MIN;
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["terminal", "waifu"]);
});
