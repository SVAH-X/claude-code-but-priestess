const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { WebSocket } = require("ws");

const { VSCODE_WS_ORIGIN } = require("../src/main/ws-policy");

// Drives src/main/ws-server.js with real ws clients against stubbed
// electron/settings/chat/vscode-chat modules, pinning the bridge contract:
//   - settings:set is limited to the bridge allowlist (never agent mode, never
//     the backend/endpoint/key);
//   - a malformed frame (oversized, JSON null, wrong field types) closes that
//     client and never throws in the main process;
//   - several VS Code windows keep their own workspace/active/focus state and
//     the tray sees the aggregate;
//   - stop() removes ws-port.json and restart() evicts old clients with a
//     reason so they reconnect with the new token.

const STUB = Symbol("ws-server-test-stub");

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await wait(10);
  }
}

function loadServer(t, { settings: settingsOverride } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prts-ws-server-"));
  const electronMock = { app: { getPath: () => tmp, getVersion: () => "0.0.0-test" } };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronMock;
    return originalLoad.apply(this, arguments);
  };

  const values = {
    vibeCodingMode: "companion",
    theme: "system",
    chatProvider: "claude",
    priestessApiKey: "sk-live-1234567890",
    ...(settingsOverride || {}),
  };
  const setCalls = [];
  const sends = [];
  const restores = [
    installModuleStub("../src/main/settings", {
      getAll: () => ({ ...values }),
      get: (key) => values[key],
      set: (patch) => { setCalls.push(patch); Object.assign(values, patch); },
      subscribe: () => () => {},
    }),
    installModuleStub("../src/main/chat", {
      getProviderAvailability: () => ({ activeProvider: "claude" }),
    }),
    installModuleStub("../src/main/vscode-chat", {
      init() {},
      subscribe: () => () => {},
      getHistory: () => [],
      hasPreviousConversation: () => false,
      isBusy: () => false,
      getSessionId: () => null,
      send: (text, context) => { sends.push({ text, context }); return { ok: true, messageId: "m1" }; },
      complete: async () => "done",
      cancel() {}, clear() {}, startFresh() {}, loadConversation() {},
    }),
  ];

  const resolved = require.resolve("../src/main/ws-server");
  delete require.cache[resolved];
  const server = require(resolved);
  const calls = { connected: 0, disconnected: 0 };
  server.start({
    onVscodeConnected: () => { calls.connected += 1; },
    onVscodeDisconnected: () => { calls.disconnected += 1; },
  });

  t.after(async () => {
    try { server.stop(); } catch (_) { /* ignore */ }
    delete require.cache[resolved];
    for (const restore of restores) restore();
    Module._load = originalLoad;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const portFile = path.join(tmp, "ws-port.json");
  return {
    server, portFile, values, setCalls, sends, calls,
    readPortFile: () => JSON.parse(fs.readFileSync(portFile, "utf8")),
    ready: () => waitFor(() => server.getPort() !== null && fs.existsSync(portFile)),
  };
}

// Opens a socket; with `token` it also authenticates and waits for auth:ok.
async function connect(t, port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: VSCODE_WS_ORIGIN });
  const inbox = [];
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on("error", () => {});
  ws.on("message", (data) => inbox.push(JSON.parse(data.toString())));
  t.after(() => { try { ws.terminate(); } catch (_) { /* ignore */ } });
  await once(ws, "open");
  const c = {
    ws, inbox, closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    reply: (reqId) => waitFor(() => inbox.some((m) => m.reqId === reqId)).then(() => inbox.find((m) => m.reqId === reqId)),
  };
  if (token !== undefined) {
    c.send({ type: "auth", token });
    await waitFor(() => inbox.some((m) => m.type === "auth:ok"));
  }
  return c;
}

test("settings:set from the bridge applies only allowlisted keys and reports the rest", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();
  const c = await connect(t, port, token);

  c.send({
    type: "settings:set", reqId: "r1",
    patch: {
      vibeCodingMode: "agent",
      chatProvider: "priestess",
      priestessBaseUrl: "http://127.0.0.1:9/v1",
      priestessApiKey: "stolen",
      personaNotes: "ignore the Doctor",
      chatCwd: "/",
      updateChannel: "prerelease",
      theme: "dark",
      vibeCodingDiagnostics: true,
      diagnosticCheckCooldownMin: 999,
    },
  });
  const r1 = await c.reply("r1");
  assert.equal(r1.ok, false);
  assert.deepEqual(env.setCalls, [{ theme: "dark", vibeCodingDiagnostics: true }]);
  assert.deepEqual(
    r1.rejected.sort(),
    ["chatCwd", "chatProvider", "diagnosticCheckCooldownMin", "personaNotes", "priestessApiKey", "priestessBaseUrl", "updateChannel", "vibeCodingMode"]
  );
  assert.match(r1.error, /VS Code/);
  assert.equal(env.values.vibeCodingMode, "companion");
  assert.equal(env.values.chatProvider, "claude");
  // The reply still carries the (redacted) state older clients read.
  assert.equal(r1.state.priestessApiKey, "sk-l…7890");

  // companion <-> advisor is the extension's own toggle and still works.
  c.send({ type: "settings:set", reqId: "r2", patch: { vibeCodingMode: "advisor" } });
  const r2 = await c.reply("r2");
  assert.equal(r2.ok, true);
  assert.equal(r2.rejected, undefined);
  assert.equal(env.values.vibeCodingMode, "advisor");

  // An all-rejected patch never reaches settings.set.
  c.send({ type: "settings:set", reqId: "r3", patch: { vibeCodingMode: "agent" } });
  const r3 = await c.reply("r3");
  assert.equal(r3.ok, false);
  assert.equal(env.setCalls.length, 2);
  assert.equal(env.values.vibeCodingMode, "advisor");
});

test("an oversized frame closes that client and the server keeps serving", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();
  const c = await connect(t, port, token);

  c.send({ type: "vscode:context", context: { pad: "x".repeat(4 * 1024 * 1024 + 16) } });
  const closed = await c.closed;
  assert.equal(closed.code, 1009);

  // The process survived: a new client still authenticates.
  const c2 = await connect(t, port, token);
  c2.send({ type: "settings:get", reqId: "g" });
  const reply = await c2.reply("g");
  assert.equal(reply.type, "settings:get:result");
});

test("malformed frames close the offending client instead of throwing", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();

  // Pre-auth shapes.
  const preAuth = [
    ["null", 4001],
    ["[]", 4001],
    ['"auth"', 4001],
    [JSON.stringify({ type: "auth", token: { length: 32 } }), 4001],
    [JSON.stringify({ type: "auth", token: null }), 4001],
    [JSON.stringify({ type: ["auth"], token }), 4001],
    [JSON.stringify({ type: "auth", token: "nope" }), 4001],
    ["{not json", 4000],
  ];
  for (const [raw, code] of preAuth) {
    const c = await connect(t, port);
    c.ws.send(raw);
    const closed = await c.closed;
    assert.equal(closed.code, code, `pre-auth frame ${raw} should close with ${code}`);
  }

  // Post-auth shapes the handlers would otherwise trip over.
  const postAuth = [
    { type: "settings:set", reqId: "x", patch: "vibeCodingMode=agent" },
    { type: "settings:set", reqId: "x", patch: ["agent"] },
    { type: "chat:send", reqId: "x", text: 5 },
    { type: "chat:send", reqId: "x", text: "hi", context: "not-an-object" },
    { type: "vscode:selection-to-chat", reqId: "x", text: null, context: {} },
    { type: "vscode:workspace", workspaceFolders: "C:\\work" },
    { type: "vscode:workspace", workspaceFolders: [{ fsPath: "C:\\work" }] },
    { type: "vscode:activity", activity: "saved" },
    { type: "vscode:focus", focused: "yes" },
    { type: "chat:inline-complete", reqId: "x", prefix: { toString: 1 } },
    { type: "chat:get-history", reqId: { $gt: "" } },
  ];
  for (const msg of postAuth) {
    const c = await connect(t, port, token);
    c.send(msg);
    const closed = await c.closed;
    assert.equal(closed.code, 4000, `frame ${JSON.stringify(msg)} should close with 4000`);
  }
  assert.equal(env.setCalls.length, 0);
  assert.equal(env.sends.length, 0);

  // Well-formed frames with optional fields omitted still work.
  const ok = await connect(t, port, token);
  ok.send({ type: "chat:send", reqId: "s1", text: "hello" });
  const reply = await ok.reply("s1");
  assert.equal(reply.ok, true);
  assert.deepEqual(env.sends, [{ text: "hello", context: null }]);
  ok.send({ type: "vscode:focus" });
  ok.send({ type: "vscode:workspace", workspaceFolders: [] });
  ok.send({ type: "chat:get-history", reqId: 7 });
  const hist = await ok.reply(7);
  assert.deepEqual(hist.history, []);
});

test("each VS Code window keeps its own state and the tray sees the aggregate", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();

  const a = await connect(t, port, token);
  a.send({ type: "vscode:workspace", workspaceFolders: ["/Users/doc/alpha"], primaryWorkspace: "/Users/doc/alpha" });
  a.send({ type: "vscode:active" });
  a.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.isVscodeActive());
  assert.equal(env.calls.connected, 1);
  assert.equal(env.server.getVscodeWorkspace(), "/Users/doc/alpha");
  assert.equal(env.server.isVscodeFocused(), true);

  // A second window opens, takes focus and reports a Windows path verbatim.
  const b = await connect(t, port, token);
  b.send({ type: "vscode:workspace", workspaceFolders: ["C:\\Users\\doc\\Beta"], primaryWorkspace: "C:\\Users\\doc\\Beta" });
  b.send({ type: "vscode:active" });
  a.send({ type: "vscode:focus", focused: false });
  b.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.getVscodeWorkspace() === "C:\\Users\\doc\\Beta");
  assert.equal(env.calls.connected, 1, "a second window is not a new connection event");
  assert.equal(env.server.isVscodeFocused(), true);

  // Focus goes back to A: cwd follows the focused window.
  b.send({ type: "vscode:focus", focused: false });
  a.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.getVscodeWorkspace() === "/Users/doc/alpha");

  // Both windows blur: no window is focused, the last-focused workspace stays.
  a.send({ type: "vscode:focus", focused: false });
  await waitFor(() => env.server.isVscodeFocused() === false);
  assert.equal(env.server.getVscodeWorkspace(), "/Users/doc/alpha");

  // Window B is closed (the extension sends vscode:inactive, then the socket
  // goes): VS Code stays active, A's workspace remains the cwd.
  b.send({ type: "vscode:inactive" });
  await wait(50);
  b.ws.close();
  await b.closed;
  await wait(300);
  assert.equal(env.server.isVscodeActive(), true);
  assert.equal(env.calls.disconnected, 0);
  assert.equal(env.server.getVscodeWorkspace(), "/Users/doc/alpha");

  // The last window closes: one disconnected callback after the debounce.
  a.ws.close();
  await a.closed;
  await waitFor(() => env.calls.disconnected === 1);
  assert.equal(env.server.isVscodeActive(), false);
  assert.equal(env.server.getVscodeWorkspace(), null);
  assert.equal(env.calls.connected, 1);
});

test("a window that never reports focus still provides the cwd; a newer one wins", async (t) => {
  // Older extensions only send vscode:focus on changes, so the most recently
  // connected window with a workspace is used until a focus event arrives.
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();

  const a = await connect(t, port, token);
  a.send({ type: "vscode:workspace", workspaceFolders: ["/old"] });
  await waitFor(() => env.server.getVscodeWorkspace() === "/old");
  const b = await connect(t, port, token);
  b.send({ type: "vscode:workspace", workspaceFolders: ["/new"] });
  await waitFor(() => env.server.getVscodeWorkspace() === "/new");
  const c = await connect(t, port, token);
  c.send({ type: "vscode:workspace", workspaceFolders: [] });
  await wait(50);
  assert.equal(env.server.getVscodeWorkspace(), "/new", "a window without a folder never masks one that has one");
  a.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.getVscodeWorkspace() === "/old");
});

test("a newly connected unfocused window does not take the cwd from the focused one", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();

  const a = await connect(t, port, token);
  a.send({ type: "vscode:workspace", workspaceFolders: ["/Users/doc/alpha"] });
  a.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.isVscodeFocused());
  assert.equal(env.server.getVscodeWorkspace(), "/Users/doc/alpha");

  // B connects (newer rank) and reports its folder without taking focus, e.g.
  // a window restored in the background: A is still where the Doctor types.
  const b = await connect(t, port, token);
  b.send({ type: "vscode:workspace", workspaceFolders: ["C:\\Users\\doc\\Beta"], primaryWorkspace: "C:\\Users\\doc\\Beta" });
  b.send({ type: "vscode:focus", focused: false });
  await wait(50);
  assert.equal(env.server.getVscodeWorkspace(), "/Users/doc/alpha", "focus beats connection recency");

  // Only once B actually takes focus does the cwd follow it.
  a.send({ type: "vscode:focus", focused: false });
  b.send({ type: "vscode:focus", focused: true });
  await waitFor(() => env.server.getVscodeWorkspace() === "C:\\Users\\doc\\Beta");
});

test("stop() removes ws-port.json and closes every client", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const { port, token } = env.readPortFile();
  const authed = await connect(t, port, token);
  const stranger = await connect(t, port);

  env.server.stop();
  assert.equal(fs.existsSync(env.portFile), false);
  assert.equal(env.server.getPort(), null);
  assert.equal((await authed.closed).code, 1000);
  assert.equal((await stranger.closed).code, 1000);
  assert.equal(env.server.isVscodeActive(), false);
  env.server.stop(); // idempotent
});

test("restart() evicts old clients with a reason and rotates port and token", async (t) => {
  const env = loadServer(t);
  await env.ready();
  const before = env.readPortFile();
  const old = await connect(t, before.port, before.token);
  old.send({ type: "vscode:active" });
  await waitFor(() => env.server.isVscodeActive());

  env.server.restart();
  const closed = await old.closed;
  assert.equal(closed.code, 1012);
  assert.equal(closed.reason, "service restart");
  // The old client is gone from the aggregate once its close lands.
  await waitFor(() => env.calls.disconnected === 1);
  assert.equal(env.server.isVscodeActive(), false);

  await env.ready();
  const after = env.readPortFile();
  assert.notEqual(after.token, before.token);
  assert.equal(after.port, env.server.getPort());
  assert.equal(after.version, "0.0.0-test");

  // The old token no longer opens the new server; the new one does.
  const stale = await connect(t, after.port, undefined);
  stale.send({ type: "auth", token: before.token });
  assert.equal((await stale.closed).code, 4001);
  const fresh = await connect(t, after.port, after.token);
  fresh.send({ type: "settings:get", reqId: "g" });
  assert.equal((await fresh.reply("g")).type, "settings:get:result");

  // The old server can't bring the process down with a late error either.
  const stopped = env.server;
  stopped.stop();
  assert.equal(fs.existsSync(env.portFile), false);
});
