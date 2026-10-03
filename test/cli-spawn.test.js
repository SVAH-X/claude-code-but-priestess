const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { quoteForCmd, windowsCommandArgs, windowsCommandLine } = require("../src/main/cli-spawn");
const { buildCodexExecArgs } = require("../src/main/chat-runtime");

// killProcessTree must take down the whole tree on Windows (cmd.exe -> node ->
// codex.exe for .cmd shims), where proc.kill() only ends cmd.exe. Windows is
// simulated here by overriding process.platform and stubbing spawn.

function loadWithSpawn(spawnStub, spawnSyncStub = null) {
  const id = require.resolve("../src/main/cli-spawn");
  const original = childProcess.spawn;
  const originalSync = childProcess.spawnSync;
  childProcess.spawn = spawnStub;
  if (spawnSyncStub) childProcess.spawnSync = spawnSyncStub;
  delete require.cache[id];
  try {
    return require("../src/main/cli-spawn");
  } finally {
    childProcess.spawn = original;
    childProcess.spawnSync = originalSync;
    delete require.cache[id];
  }
}

function withPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function fakeProc(pid) {
  return { pid, kills: 0, signals: [], exitCode: null, signalCode: null, kill(signal) { this.kills++; this.signals.push(signal); } };
}

test("killProcessTree uses taskkill /T /F on Windows", () => {
  const calls = [];
  const killer = new EventEmitter();
  const { killProcessTree } = loadWithSpawn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return killer;
  });
  const previousRoot = process.env.SystemRoot;
  process.env.SystemRoot = "C:\\Windows";
  try {
    const proc = fakeProc(4321);
    withPlatform("win32", () => killProcessTree(proc));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "C:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(calls[0].args, ["/pid", "4321", "/T", "/F"]);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.windowsHide, true);
    killer.emit("exit", 0);
    assert.equal(proc.kills, 0, "a successful taskkill needs no fallback");
    killer.emit("exit", 128);
    assert.equal(proc.kills, 1, "a failed taskkill falls back to proc.kill()");
    killer.emit("error", new Error("ENOENT"));
    assert.equal(proc.kills, 2, "a taskkill that cannot start falls back to proc.kill()");
  } finally {
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
  }
});

test("killProcessTree kills the child directly elsewhere", () => {
  const calls = [];
  const { killProcessTree } = loadWithSpawn((...args) => { calls.push(args); return new EventEmitter(); });
  const proc = fakeProc(4321);
  withPlatform("darwin", () => killProcessTree(proc));
  assert.equal(calls.length, 0, "no taskkill off Windows");
  assert.equal(proc.kills, 1);
  // A process whose spawn failed has no pid; a missing proc is a no-op.
  const noPid = fakeProc(undefined);
  withPlatform("win32", () => killProcessTree(noPid));
  assert.equal(noPid.kills, 1);
  assert.doesNotThrow(() => killProcessTree(null));
});

// The quit/restart paths need the kill to be done before app.exit(): a sync
// taskkill with the same argv, falling back to proc.kill() when it fails.
test("killProcessTree sync mode runs taskkill synchronously on Windows", () => {
  const spawned = [];
  const syncCalls = [];
  let syncResult = { status: 0 };
  const { killProcessTree } = loadWithSpawn(
    (...args) => { spawned.push(args); return new EventEmitter(); },
    (cmd, args, opts) => { syncCalls.push({ cmd, args, opts }); return syncResult; }
  );
  const previousRoot = process.env.SystemRoot;
  process.env.SystemRoot = "D:\\WINDOWS";
  try {
    const proc = fakeProc(777);
    withPlatform("win32", () => killProcessTree(proc, { sync: true }));
    assert.equal(spawned.length, 0, "nothing fire-and-forget on the sync path");
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].cmd, "D:\\WINDOWS\\System32\\taskkill.exe");
    assert.deepEqual(syncCalls[0].args, ["/pid", "777", "/T", "/F"]);
    assert.equal(syncCalls[0].opts.windowsHide, true);
    assert.ok(syncCalls[0].opts.timeout > 0, "a hung taskkill cannot block the quit forever");
    assert.equal(proc.kills, 0, "a successful taskkill needs no fallback");

    syncResult = { status: 1 };
    withPlatform("win32", () => killProcessTree(proc, { sync: true }));
    assert.equal(proc.kills, 1, "a failed taskkill falls back to proc.kill()");
    syncResult = { error: new Error("ENOENT"), status: null };
    withPlatform("win32", () => killProcessTree(proc, { sync: true }));
    assert.equal(proc.kills, 2, "a taskkill that cannot start falls back to proc.kill()");
  } finally {
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
  }
});

test("killProcessTree off Windows: SIGTERM, then SIGKILL after the grace period unless it exited", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { killProcessTree, KILL_GRACE_MS } = loadWithSpawn(() => new EventEmitter());

  const stubborn = fakeProc(1);
  withPlatform("darwin", () => killProcessTree(stubborn));
  assert.deepEqual(stubborn.signals, ["SIGTERM"]);
  t.mock.timers.tick(KILL_GRACE_MS - 1);
  assert.deepEqual(stubborn.signals, ["SIGTERM"], "no SIGKILL before the grace period");
  t.mock.timers.tick(1);
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);

  const polite = fakeProc(2);
  withPlatform("linux", () => killProcessTree(polite));
  polite.exitCode = 0; // exited on SIGTERM
  t.mock.timers.tick(KILL_GRACE_MS);
  assert.deepEqual(polite.signals, ["SIGTERM"], "a process that exited is not SIGKILLed");

  // The built-in backend's turn handle has no pid: kill() just aborts.
  const handle = { kills: 0, kill() { this.kills++; } };
  withPlatform("darwin", () => killProcessTree(handle));
  assert.equal(handle.kills, 1);

  // Sync mode (app.exit() follows): deliver SIGTERM, arm nothing.
  const quitting = fakeProc(3);
  withPlatform("darwin", () => killProcessTree(quitting, { sync: true }));
  t.mock.timers.tick(KILL_GRACE_MS * 2);
  assert.deepEqual(quitting.signals, ["SIGTERM"]);
});

// Windows .cmd shims run through `cmd.exe /d /s /c "<line>"`, the shim's `%*`,
// and finally node.exe's C-runtime argv parser. cmd.exe toggles its quote
// state on every `"` and only honours `^` outside quotes, so a token's quoting
// has to be exact — the old `^"` form left carets inside the quotes for
// node.exe to read literally.

test("quoteForCmd leaves plain tokens and spaced paths alone", () => {
  assert.equal(quoteForCmd("--json"), '"--json"');
  assert.equal(
    quoteForCmd("C:\\Users\\Dr\\AppData\\Roaming\\npm\\codex.cmd"),
    '"C:\\Users\\Dr\\AppData\\Roaming\\npm\\codex.cmd"'
  );
  // Parentheses and `&` inside cmd's quotes are literal there; a caret would
  // reach node.exe as part of the path.
  assert.equal(
    quoteForCmd("C:\\Program Files (x86)\\nodejs\\codex.cmd"),
    '"C:\\Program Files (x86)\\nodejs\\codex.cmd"'
  );
  assert.equal(quoteForCmd("a&b|c"), '"a&b|c"');
  assert.equal(quoteForCmd(""), '""');
});

test("quoteForCmd escapes embedded quotes for node.exe and keeps cmd's state straight", () => {
  // node.exe: `\"` is a literal quote; cmd.exe: each `"` still toggles.
  assert.equal(quoteForCmd('model_reasoning_effort="high"'), '"model_reasoning_effort=\\"high\\""');
  // Backslashes only count in front of a quote (doubled) or at the end.
  assert.equal(quoteForCmd('dir\\\\"q'), '"dir\\\\\\\\\\"q"');
  assert.equal(quoteForCmd("C:\\"), '"C:\\\\"');
  assert.equal(quoteForCmd("D:\\work\\"), '"D:\\work\\\\"');
  // Between an odd pair of embedded quotes cmd is outside quotes, so its
  // metacharacters need escaping — twice, because the shim's `%*` re-parses.
  assert.equal(quoteForCmd('x"a&b"y'), '"x\\"a^^^&b\\"y"');
  // A token that starts while cmd is still inside quotes is the mirror image.
  assert.equal(quoteForCmd("c&d", { quoted: true }), '"c^^^&d"');
});

test("windowsCommandLine threads cmd's quote state across tokens", () => {
  // After the odd-quoted token cmd stays inside quotes, so the following
  // tokens' own quotes put their bodies outside — until another odd token.
  assert.equal(
    windowsCommandLine("x.cmd", ['say "hi', "c&d", "e(f)", 'back"', "g|h"]),
    '"x.cmd" "say \\"hi" "c^^^&d" "e^^^(f^^^)" "back\\"" "g|h"'
  );
});

test("the Codex effort override survives a Windows .cmd shim", () => {
  const shim = "C:\\Users\\Dr\\AppData\\Roaming\\npm\\codex.cmd";
  const { args } = buildCodexExecArgs({
    cwd: "C:\\Users\\Dr\\Projects\\Rhodes Island",
    mode: "advisor",
    model: "gpt-5-codex",
    reasoningEffort: "high"
  });
  const cmdArgs = windowsCommandArgs(shim, args);
  assert.deepEqual(cmdArgs.slice(0, 3), ["/d", "/s", "/c"]);
  const line = cmdArgs[3];
  assert.ok(line.startsWith(`""${shim}" "exec"`), line);
  assert.ok(line.endsWith('"-""'), line);
  assert.ok(line.includes('"-c" "model_reasoning_effort=high"'), line);
  assert.ok(line.includes('"-C" "C:\\Users\\Dr\\Projects\\Rhodes Island"'), line);
  // No caret anywhere: every token sits inside cmd's quotes, where carets
  // would be literal and reach the CLI.
  assert.equal(line.includes("^"), false, line);
  assert.equal(line.includes("\\\""), false, "no embedded quotes to flip cmd's state");
});
