const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

// killProcessTree must take down the whole tree on Windows (cmd.exe -> node ->
// codex.exe for .cmd shims), where proc.kill() only ends cmd.exe. Windows is
// simulated here by overriding process.platform and stubbing spawn.

function loadWithSpawn(spawnStub) {
  const id = require.resolve("../src/main/cli-spawn");
  const original = childProcess.spawn;
  childProcess.spawn = spawnStub;
  delete require.cache[id];
  try {
    return require("../src/main/cli-spawn");
  } finally {
    childProcess.spawn = original;
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
  return { pid, kills: 0, kill() { this.kills++; } };
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
