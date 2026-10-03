const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Drives the popover chat (chat.js) through the backend-selection paths with
// both CLIs faked: every spawn is captured, every synchronous probe scripted,
// and Date.now() is offset by hand to step over the availability TTLs. Covers
// three things that only show up end to end:
//   - a Codex model/effort rejection replays the turn once, and the replaced
//     turn must not leave a Codex auto-continuation behind (an extra nudge
//     turn after the retry had already answered);
//   - a failed `claude --help` probe is "unknown", not "no levels": the saved
//     claudeReasoningEffort survives and the probe is retried on the next scan;
//   - the send path never runs `codex debug models` synchronously; the catalog
//     comes from Codex's own cache file or a background probe whose failure is
//     remembered for a minute.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-backend-fallbacks-"));
const binDir = path.join(tmp, "bin");
const home = path.join(tmp, "home");
const codexHome = path.join(tmp, "codex-home");
for (const dir of [binDir, home, codexHome]) fs.mkdirSync(dir);
for (const name of ["claude", "codex"]) {
  fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
// Only the fake CLIs are discoverable: a fresh HOME hides ~/.claude/local and
// VS Code's Codex bundles, PATH holds just the fake bin directory.
process.env.PATH = binDir;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = codexHome;

let nowOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + nowOffset;

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

const HELP_WITH_EFFORT = [
  "Options:",
  "  --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)",
  "  --model <model>    Model for the current session"
].join("\n");

let claudeVersion = "2.1.0";
let codexVersion = "codex-cli 0.50.0";
let claudeHelp = () => ({ status: 0, stdout: HELP_WITH_EFFORT, stderr: "" });
const syncCalls = [];
const procs = [];

function cliName(command) {
  return path.basename(String(command)).replace(/\.(cmd|exe|bat)$/i, "");
}

function spawnCliSync(command, args) {
  syncCalls.push({ command, args });
  const name = cliName(command);
  if (args[0] === "--version") {
    return { status: 0, stdout: name === "codex" ? codexVersion : claudeVersion, stderr: "" };
  }
  if (args[0] === "--help" && name === "claude") return claudeHelp();
  return { status: 1, stdout: "", stderr: "" };
}

function spawnCli(command, args) {
  const proc = new EventEmitter();
  proc.command = command;
  proc.args = args;
  proc.pid = 1000 + procs.length;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { on() {}, end() {} };
  proc.kill = () => {};
  procs.push(proc);
  return proc;
}

installModuleStub("../src/main/cli-spawn", { spawnCli, spawnCliSync, killProcessTree() {} });
installModuleStub("../src/main/priestess-provider", {
  startTurn: () => { throw new Error("the built-in backend is not used in this test"); },
  chatCompletionsUrl: () => null,
  testConnection: async () => ({ ok: false })
});

const settings = require("../src/main/settings");
const chat = require("../src/main/chat");

test.after(() => {
  Date.now = realNow;
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const catalogProcs = () => procs.filter((proc) => proc.args[0] === "debug");
const turnProcs = () => procs.filter((proc) => proc.args[0] !== "debug");
const lastTurn = () => turnProcs()[turnProcs().length - 1];
const syncCatalogProbes = () => syncCalls.filter((call) => call.args[0] === "debug");

function emitLines(proc, events) {
  for (const event of events) proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

async function sendAndStart(text) {
  const before = turnProcs().length;
  const result = chat.send(text);
  assert.equal(result.ok, true, `send should be accepted: ${JSON.stringify(result)}`);
  await settle();
  assert.equal(turnProcs().length, before + 1, "the turn should have spawned its CLI");
  return lastTurn();
}

async function answerAndClose(proc, text = "好的。") {
  emitLines(proc, [{ type: "item.delta", delta: text }]);
  proc.emit("close", 0);
  await settle();
  assert.equal(chat.isBusy(), false);
}

test("the send path never probes the Codex catalog synchronously and remembers a failed probe", async () => {
  // A pinned model is what makes a turn consult the catalog at all; with
  // nothing pinned the send path has no reason to look.
  settings.set({ chatProvider: "codex", vibeCodingMode: "companion", codexModel: "gpt-5-codex", codexReasoningEffort: "" });

  let turn = await sendAndStart("第一条");
  assert.equal(syncCatalogProbes().length, 0, "no synchronous `codex debug models` on the send path");
  let probes = catalogProcs();
  assert.equal(probes.length, 1, "one background catalog probe");
  const modelAt = turn.args.indexOf("--model");
  assert.deepEqual(
    turn.args.slice(modelAt, modelAt + 2),
    ["--model", "gpt-5-codex"],
    "without a catalog yet, the pin passes through and the CLI decides"
  );
  probes[0].emit("close", 1);
  await answerAndClose(turn);

  turn = await sendAndStart("第二条");
  assert.equal(catalogProcs().length, 1, "a failed probe is not retried within a minute");
  await answerAndClose(turn);

  nowOffset += 61 * 1000;
  turn = await sendAndStart("第三条");
  probes = catalogProcs();
  assert.equal(probes.length, 2, "the failure expires after a minute");
  probes[1].stdout.emit("data", Buffer.from(JSON.stringify({
    models: [{
      slug: "gpt-5-codex",
      display_name: "GPT-5 Codex",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high"]
    }]
  })));
  probes[1].emit("close", 0);
  await answerAndClose(turn);

  // A stale pin is now rejected from the cached catalog — still without a probe.
  settings.set({ codexModel: "gpt-4-retired" });
  turn = await sendAndStart("第四条");
  assert.equal(turn.args.includes("--model"), false, "the retired model is not passed on");
  assert.equal(settings.get("codexModel"), "");
  assert.equal(catalogProcs().length, 2, "a fresh catalog is served from the cache");
  assert.equal(syncCatalogProbes().length, 0);
  await answerAndClose(turn);
});

test("Codex's own models_cache.json seeds the catalog without any probe", async () => {
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({
    client_version: "0.51.0",
    models: [{
      slug: "gpt-5-codex",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high"]
    }]
  }));
  codexVersion = "codex-cli 0.51.0";
  nowOffset += 61 * 1000;
  settings.set({ codexReasoningEffort: "ultra" });
  const probesBefore = catalogProcs().length;
  const turn = await sendAndStart("第五条");
  assert.equal(catalogProcs().length, probesBefore, "the file catalog is fresh: no probe");
  assert.equal(syncCatalogProbes().length, 0);
  assert.equal(settings.get("codexReasoningEffort"), "", "a level no model offers is cleared from the file catalog");
  assert.equal(turn.args.includes("-c"), false);
  await answerAndClose(turn);
});

test("a Codex effort rejection replays the turn once, without a trailing nudge turn", async () => {
  // "high" is in the catalog, so it survives pre-flight validation and the
  // (final authority) CLI gets to reject it.
  settings.set({ codexReasoningEffort: "high" });
  const turnsBefore = turnProcs().length;
  const first = await sendAndStart("看看这个目录");
  assert.ok(first.args.includes("model_reasoning_effort=high"), first.args.join(" "));
  emitLines(first, [
    { type: "item.delta", delta: "我先看看" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
    { type: "error", message: "unsupported value for model_reasoning_effort: high" }
  ]);
  first.emit("close", 1);
  await settle();

  const retry = lastTurn();
  assert.notEqual(retry, first, "the turn is replayed once");
  assert.equal(turnProcs().length, turnsBefore + 2);
  assert.equal(
    retry.args.some((arg) => String(arg).startsWith("model_reasoning_effort=")),
    false,
    "the retry drops the rejected override"
  );
  assert.equal(settings.get("codexReasoningEffort"), "");

  await answerAndClose(retry, "回答好了");
  assert.equal(turnProcs().length, turnsBefore + 2, "no third (nudge) turn after the retry answered");
  const replies = chat.getHistory().filter((entry) => entry.role === "assistant");
  assert.equal(replies[replies.length - 1].text, "回答好了");
});

test("a failed `claude --help` probe keeps the saved effort; only a definite answer clears it", async () => {
  claudeVersion = "2.1.5";
  claudeHelp = () => ({
    error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    stdout: "",
    stderr: ""
  });
  settings.set({ chatProvider: "claude", claudeReasoningEffort: "high" });
  nowOffset += 61 * 1000;
  let availability = chat.refreshProviderAvailability();
  assert.equal(availability.providers.claude.available, true);
  assert.equal(availability.providers.claude.effortLevels, null, "a failed probe is unknown, not empty");

  let turn = await sendAndStart("claude 一");
  const effortAt = turn.args.indexOf("--effort");
  assert.deepEqual(turn.args.slice(effortAt, effortAt + 2), ["--effort", "high"], turn.args.join(" "));
  assert.equal(settings.get("claudeReasoningEffort"), "high", "the setting survives a probe failure");
  turn.emit("close", 0);
  await settle();

  claudeHelp = () => ({ status: 0, stdout: HELP_WITH_EFFORT, stderr: "" });
  nowOffset += 61 * 1000;
  availability = chat.refreshProviderAvailability();
  assert.deepEqual(
    availability.providers.claude.effortLevels,
    ["low", "medium", "high", "xhigh", "max"],
    "the failure was not cached: the next scan probes again"
  );

  // An older CLI without --effort is a definite answer.
  claudeVersion = "2.2.0";
  claudeHelp = () => ({ status: 0, stdout: "Options:\n  --model <model>", stderr: "" });
  nowOffset += 61 * 1000;
  availability = chat.refreshProviderAvailability();
  assert.deepEqual(availability.providers.claude.effortLevels, []);
  turn = await sendAndStart("claude 二");
  assert.equal(turn.args.includes("--effort"), false);
  assert.equal(settings.get("claudeReasoningEffort"), "");
  turn.emit("close", 0);
  await settle();
  assert.equal(chat.isBusy(), false);
});
