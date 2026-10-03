const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Pins the read-only chat:state request the VS Code extension uses before it
// offers "restore / start fresh": the answer must say whether a turn is
// running and how many windows share the conversation (asker included), and
// asking must change nothing. ws-server.js is loaded against stubbed
// electron / ws / chat / vscode-chat / settings, so no socket is opened.

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

function loadWsServer(t, { busy = false, hasPrevious = true, history = [] } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "prts-ws-state-"));
  const servers = [];
  class FakeWebSocketServer extends EventEmitter {
    constructor() { super(); servers.push(this); }
    address() { return { port: 4321 }; }
    close() {}
  }
  const mutations = [];
  const restores = [
    installModuleStub("electron", { app: { getPath: () => userData, getVersion: () => "0.0.0-test" } }),
    installModuleStub("ws", { WebSocketServer: FakeWebSocketServer }),
    installModuleStub("../src/main/chat", { getProviderAvailability: () => ({ activeProvider: "claude" }) }),
    installModuleStub("../src/main/vscode-chat", {
      isBusy: () => busy,
      hasPreviousConversation: () => hasPrevious,
      getHistory: () => history.slice(),
      getSessionId: () => null,
      subscribe: () => () => {},
      init: () => {},
      cancel: () => mutations.push("cancel"),
      clear: () => mutations.push("clear"),
      startFresh: () => mutations.push("startFresh"),
      loadConversation: () => mutations.push("loadConversation"),
      send: () => { mutations.push("send"); return { ok: true }; },
      complete: async () => null
    }),
    installModuleStub("../src/main/settings", {
      getAll: () => ({}), get: () => undefined, set: () => mutations.push("settings.set"), subscribe: () => () => {}
    })
  ];
  const wsServerPath = require.resolve("../src/main/ws-server");
  delete require.cache[wsServerPath];
  const wsServer = require("../src/main/ws-server");
  t.after(() => {
    try { wsServer.stop(); } catch { /* ignore */ }
    delete require.cache[wsServerPath];
    for (const restore of restores.reverse()) restore();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  wsServer.start();
  const wss = servers[0];
  wss.emit("listening");
  const { token } = JSON.parse(fs.readFileSync(path.join(userData, "ws-port.json"), "utf8"));

  // A fake authenticated socket: `sent` collects what the server pushed to it.
  function connect() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.sent = [];
    ws.send = (raw) => ws.sent.push(JSON.parse(raw));
    ws.close = () => { ws.readyState = 3; ws.emit("close"); };
    ws.ask = (msg) => {
      ws.emit("message", Buffer.from(JSON.stringify(msg)));
      return ws.sent.filter((m) => m.type === "chat:state:result" && m.reqId === msg.reqId).pop();
    };
    wss.emit("connection", ws);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "auth", token })));
    assert.ok(ws.sent.some((m) => m.type === "auth:ok"), "fake socket must authenticate");
    return ws;
  }
  return { connect, mutations };
}

test("chat:state reports idle state and counts every connected window, the asker included", (t) => {
  const { connect, mutations } = loadWsServer(t, { history: [{ role: "user", text: "hi" }] });
  const a = connect();
  assert.deepEqual(a.ask({ type: "chat:state", reqId: "r1" }), {
    type: "chat:state:result", reqId: "r1", busy: false, clients: 1, hasPrevious: true, historyLength: 1
  });

  const b = connect();
  assert.equal(b.ask({ type: "chat:state", reqId: "r2" }).clients, 2, "second window is counted");
  assert.equal(a.ask({ type: "chat:state", reqId: "r3" }).clients, 2);

  b.close();
  assert.equal(a.ask({ type: "chat:state", reqId: "r4" }).clients, 1, "a closed window is no longer counted");

  // Read-only: nothing on the conversation or settings side was touched.
  assert.deepEqual(mutations, []);
  // No reqId: nothing to correlate, so nothing is sent.
  const before = a.sent.length;
  a.emit("message", Buffer.from(JSON.stringify({ type: "chat:state" })));
  assert.equal(a.sent.length, before);
});

test("chat:state reports a running turn", (t) => {
  const { connect } = loadWsServer(t, { busy: true, hasPrevious: false });
  const reply = connect().ask({ type: "chat:state", reqId: "r1" });
  assert.equal(reply.busy, true);
  assert.equal(reply.hasPrevious, false);
  assert.equal(reply.historyLength, 0);
});
