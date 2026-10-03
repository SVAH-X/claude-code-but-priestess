const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const RealDate = Date;
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

function loadProactive(t, { settings = {}, ws = {}, now = Date.now(), chat = {}, memoryPath = "/nonexistent/MEMORY.md" } = {}) {
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
      sendMaintenance: () => ({ ok: false }),
      ...chat
    }),
    installModuleStub("../src/main/persona", { memoryPath: () => memoryPath }),
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
  // `new Date()` (day key, quiet hours) must follow the fake clock too, so a
  // test can cross midnight.
  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() {
      return clock.now;
    }
  }
  global.Date = FakeDate;
  const proactivePath = require.resolve("../src/main/proactive");
  delete require.cache[proactivePath];
  const proactive = require("../src/main/proactive");
  t.after(() => {
    global.Date = RealDate;
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

// The day rollover refills the daily budget only. It used to zero the attempt
// stamps too, which let a check fire a minute past midnight regardless of the
// proactive interval (and of the boot delay, which is the same stamp).
function lateEvening() {
  const d = new RealDate();
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

test("day rollover does not bypass the proactive interval", (t) => {
  // An opted-in coding check (VS Code connected, nothing to report) reaches
  // the day-rollover code on the first tick of the new day; that must not
  // reset the 老婆模式 interval (the boot delay is the same stamp).
  const h = loadProactive(t, {
    now: lateEvening(),
    settings: { waifuMode: true, vibeCodingDiagnostics: true }
  });
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["waifu"]);
  for (let i = 0; i < 5; i += 1) {
    h.clock.now += MIN; // crosses midnight on the first step
    h.tick();
  }
  assert.deepEqual(h.calls.map(kindOf), ["waifu"], "nothing fires a few minutes into the new day");
  h.clock.now += 15 * MIN; // 20 min since the last attempt: the default interval
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["waifu", "waifu"]);
});

test("day rollover does not bypass the coding-check cooldowns either", (t) => {
  // 老婆模式 reaches the rollover code on the first tick of the new day; the
  // diagnostics cooldown (10 min, started 23:59) must survive it.
  const diagnostics = { errors: 2, warnings: 1, totalFilesWithProblems: 1, details: [] };
  const h = loadProactive(t, {
    now: lateEvening(),
    settings: {
      waifuMode: true,
      vibeCodingMode: "advisor",
      vibeCodingDiagnostics: true,
      diagnosticCheckCooldownMin: 10
    },
    ws: { diagnostics }
  });
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["diagnostics"]);
  for (let i = 0; i < 9; i += 1) {
    h.clock.now += MIN; // 00:00 fires the (never-attempted) 老婆模式 check
    h.tick();
  }
  assert.deepEqual(h.calls.map(kindOf), ["diagnostics", "waifu"], "00:08 — the 10 min cooldown survives midnight");
  h.clock.now += MIN;
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["diagnostics", "waifu", "diagnostics"], "00:09 — cooldown elapsed");
});

test("the daily budget refills on rollover", (t) => {
  const h = loadProactive(t, { now: lateEvening(), settings: { waifuMode: true, proactiveDailyCap: 1, proactiveIntervalMin: 5 } });
  h.tick();
  h.clock.now += 5 * MIN; // past midnight, interval elapsed, yesterday's cap no longer applies
  h.tick();
  assert.deepEqual(h.calls.map(kindOf), ["waifu", "waifu"]);
});

test("maintenance keeps retrying each tick while a VS Code turn is running", (t) => {
  const memFile = path.join(os.tmpdir(), `prts-proactive-maint-${process.pid}.md`);
  fs.writeFileSync(memFile, "x".repeat(16 * 1024 + 1)); // past MAINTENANCE_MEMORY_MIN_BYTES
  t.after(() => fs.rmSync(memFile, { force: true }));
  let reason = "vscode-busy";
  const attempts = [];
  const h = loadProactive(t, {
    settings: { memoryCuratedAt: 0 },
    memoryPath: memFile,
    chat: { sendMaintenance: () => { attempts.push(reason); return { ok: false, reason }; } }
  });
  h.tick();
  h.clock.now += MIN;
  h.tick();
  assert.deepEqual(attempts, ["vscode-busy", "vscode-busy"], "a VS Code turn in flight does not burn the retry window");
  reason = "missing-cli";
  h.clock.now += MIN;
  h.tick();
  h.clock.now += MIN;
  h.tick();
  assert.deepEqual(attempts, ["vscode-busy", "vscode-busy", "missing-cli"], "other failures back off for hours");
});
