/// <reference types="mocha" />
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebSocketServer } from "ws";
import { WsClient } from "../../ws-client";
import { InlineCompletionProvider } from "../../inline-provider";
import { vscodeStub, resetVscodeStub } from "./helpers/vscode-stub";

// WsClient talks to a real ws:// endpoint, so these tests spin up a genuine
// WebSocketServer and hand the client its connection details through the same
// ws-port.json discovery path the shipped app uses. This exercises auth,
// request/response correlation, buffering and reconnection for real.

const TOKEN = "unit-test-token";
const ROOTS: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await wait(20);
  }
}

function makeDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prts-unit-"));
  ROOTS.push(root);
  if (process.platform === "win32") process.env.APPDATA = root;
  else if (process.platform === "darwin") process.env.HOME = root;
  else process.env.XDG_CONFIG_HOME = root;
  return root;
}

/** Mirrors dataDirFor() in ws-client.ts for the given app name. */
function dataDir(root: string, appName = "PRTS"): string {
  if (process.platform === "win32") return path.join(root, appName);
  if (process.platform === "darwin") return path.join(root, "Library", "Application Support", appName);
  return path.join(root, appName);
}

function writePortFile(root: string, port: number, token = TOKEN) {
  const dir = dataDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ws-port.json"), JSON.stringify({ port, token, version: "test" }));
}

async function startServer(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  return wss;
}

async function listenOn(port: number, timeoutMs = 4000): Promise<WebSocketServer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const wss = new WebSocketServer({ port, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      return wss;
    } catch {
      if (Date.now() > deadline) throw new Error(`could not bind port ${port}`);
      await wait(100);
    }
  }
}

function serverPort(wss: WebSocketServer): number {
  return (wss.address() as any).port;
}

function wireAuth(wss: WebSocketServer, token = TOKEN) {
  const received: any[] = [];
  const sockets: any[] = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(String(data));
      received.push(msg);
      if (msg.type === "auth" && msg.token === token) {
        ws.send(JSON.stringify({ type: "auth:ok", version: "test" }));
      }
    });
  });
  return { received, sockets };
}

function waitForMsg(received: any[], predicate: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
  const existing = received.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const m = received.find(predicate);
      if (m) {
        clearInterval(timer);
        clearTimeout(tout);
        resolve(m);
      }
    }, 20);
    const tout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error("timed out waiting for message"));
    }, timeoutMs);
  });
}

function waitForConnected(client: WsClient, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for connected")), timeoutMs);
    if (client.isConnected()) { clearTimeout(timer); resolve(); return; }
    client.on("connected", () => { clearTimeout(timer); resolve(); });
  });
}

function makeContext() {
  return { subscriptions: [] as any[] };
}

async function closeServer(wss: WebSocketServer | null) {
  if (!wss) return;
  for (const ws of (wss as any).clients || []) {
    try { ws.close(); } catch { /* ignore */ }
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

describe("ws-client", () => {
  let wss: WebSocketServer | null = null;
  let client: WsClient | null = null;

  beforeEach(() => {
    resetVscodeStub();
  });

  afterEach(async () => {
    if (client) { try { client.dispose(); } catch { /* ignore */ } client = null; }
    if (wss) { await closeServer(wss); wss = null; }
    for (const root of ROOTS.splice(0)) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("connects, authenticates and updates the status bar", async () => {
    wss = await startServer();
    const auth = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);

    assert.strictEqual(client.isConnected(), true);
    const authMsg = await waitForMsg(auth.received, (m) => m.type === "auth");
    assert.strictEqual(authMsg.token, TOKEN);

    const item = (vscodeStub.window._createdStatusBarItems as any[])[0];
    assert.ok(item, "constructor should create a status bar item");
    assert.ok(item.text.includes("PRTS"), `status bar should show connected state, got "${item.text}"`);
  });

  it("request/response correlation resolves with the server payload", async () => {
    wss = await startServer();
    const auth = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);

    const pending = client.request("settings:get");
    const reqMsg = await waitForMsg(auth.received, (m) => m.type === "settings:get");
    assert.ok(reqMsg.reqId, "request should carry a reqId");

    auth.sockets[0].send(JSON.stringify({
      type: "settings:get:result",
      reqId: reqMsg.reqId,
      state: { vibeCodingMode: "advisor" },
    }));

    const res = await pending;
    assert.strictEqual(res.state.vibeCodingMode, "advisor");
  });

  it("notify is fire-and-forget (no reqId) and buffers before the socket opens", async () => {
    wss = await startServer();
    const auth = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    client = new WsClient(makeContext() as any);
    // Synchronously right after construction the socket is still CONNECTING,
    // so the notification must be buffered and flushed once the socket opens.
    client.notify("vscode:focus", { focused: true });
    await waitForConnected(client);

    const focusMsg = await waitForMsg(auth.received, (m) => m.type === "vscode:focus");
    assert.strictEqual(focusMsg.focused, true);
    assert.strictEqual(focusMsg.reqId, undefined, "notifications carry no reqId");
  });

  it("reconnects after the server closes and resumes authenticated", async () => {
    wss = await startServer();
    const port = serverPort(wss);
    const first = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, port);

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);
    assert.strictEqual(first.received.length > 0, true);

    // Tear down the server; the client's close handler schedules a reconnect.
    await closeServer(wss);
    wss = null;

    // Rebind the same port and wait for the client to come back.
    wss = await listenOn(port);
    const second = wireAuth(wss);
    await waitForMsg(second.received, (m) => m.type === "auth", 6000);
    await waitForConnected(client);
    assert.strictEqual(client.isConnected(), true);
  });

  it("tracks provider availability from chat:status messages", async () => {
    wss = await startServer();
    const received: any[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(String(data));
        received.push(msg);
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok", version: "test" }));
          // The server announces CLI provider availability right after auth.
          ws.send(JSON.stringify({ type: "chat:status", status: "idle", provider: "codex" }));
        }
      });
    });
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);

    const availability = (client as any).providerAvailability;
    assert.ok(availability, "providerAvailability should be recorded from chat:status");
    assert.strictEqual(availability.activeProvider, "codex");
  });

  it("manual electronPort config is honoured but still requires the port-file token", async () => {
    wss = await startServer();
    const auth = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));
    vscodeStub.workspace._config = { electronPort: serverPort(wss) };

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);

    const authMsg = await waitForMsg(auth.received, (m) => m.type === "auth");
    assert.strictEqual(authMsg.token, TOKEN);
  });

  it("missing port file does not throw and shows reconnecting state", async () => {
    const root = makeDataRoot();
    process.env.APPDATA = root; // empty data dir - no ws-port.json anywhere
    client = new WsClient(makeContext() as any);
    assert.strictEqual(client.isConnected(), false);
    const item = (vscodeStub.window._createdStatusBarItems as any[])[0];
    assert.ok(item.text.includes("reconnecting"), `expected reconnecting state, got "${item.text}"`);
  });

  it("drops timed-out requests from the buffer so they are never replayed", async () => {
    makeDataRoot(); // no port file -> the client never connects
    client = new WsClient(makeContext() as any, { requestTimeoutMs: 50 } as any);
    const p = client.request("chat:send", { text: "hi" });
    await assert.rejects(p, /timed out/);
    const buffered = (client as any).bufferedMessages;
    assert.strictEqual(buffered.length, 0, "stale buffered request must be dropped on timeout");
  });

  it("does not replay an expired request after a reconnect", async () => {
    wss = await startServer();
    const port = serverPort(wss);
    wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, port);
    client = new WsClient(makeContext() as any, { requestTimeoutMs: 200 } as any);
    await waitForConnected(client);

    // Drop the connection; the client schedules a reconnect in ~1s. Wait
    // until the client processed the disconnect (close handler rejects all
    // in-flight pending requests) before queueing a new one.
    await closeServer(wss);
    wss = null;
    await waitFor(() => !client!.isConnected());

    // Queue a request while disconnected. Its timeout (200ms) fires well
    // before the reconnect, so the buffered copy must be discarded.
    const p = client.request("chat:get-history");
    await assert.rejects(p, /timed out/);

    wss = await listenOn(port);
    const second = wireAuth(wss);
    await waitForMsg(second.received, (m) => m.type === "auth", 6000);
    await waitForConnected(client);
    await wait(150); // give the open-handler flush a moment
    assert.ok(
      !second.received.some((m) => m.type === "chat:get-history"),
      "an expired request must not be replayed after reconnect"
    );
  });

  it("ignores malformed server messages without crashing", async () => {
    wss = await startServer();
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(String(data));
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok", version: "test" }));
          ws.send("not json {{{ "); // garbage frame must not throw
        }
      });
    });
    client = new WsClient(makeContext() as any);
    await waitForConnected(client);
    await wait(100);
    assert.strictEqual(client.isConnected(), true, "client must survive malformed frames");
  });

  it("survives an auth rejection from the server", async () => {
    wss = await startServer();
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss), "wrong-token"); // client sends TOKEN
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(String(data));
        if (msg.type === "auth" && msg.token !== "unit-test-token") {
          ws.close(4001, "unauthorized");
        }
      });
    });
    client = new WsClient(makeContext() as any);
    await wait(300);
    // No crash; the client stays unauthenticated and keeps reconnecting.
    assert.strictEqual(client.isConnected(), false);
    client.dispose();
    client = null;
  });

﻿  it("end-to-end: inline completion through a real ws connection", async () => {
    wss = await startServer();
    const received: any[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(String(data));
        received.push(msg);
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok", version: "test" }));
          // Announce an available CLI provider, exactly like the real server.
          ws.send(JSON.stringify({ type: "chat:status", status: "idle", provider: "codex" }));
        } else if (msg.type === "chat:inline-complete" && msg.reqId) {
          // Pretend to be vscode-chat.complete(): return a ghost suggestion.
          ws.send(JSON.stringify({
            type: "chat:inline-complete:result",
            reqId: msg.reqId,
            text: "const answer = 42;",
          }));
        }
      });
    });
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    const wsClient = new WsClient(makeContext() as any);
    client = wsClient; // afterEach disposes it
    await waitForConnected(wsClient);

    const provider = new InlineCompletionProvider(wsClient as any);
    const doc = {
      languageId: "typescript",
      fileName: "app.ts",
      getText: () => "const answer = ",
    };
    const items = await provider.provideInlineCompletionItems(
      doc as any, { line: 0, character: 16 } as any, {} as any,
      { isCancellationRequested: false } as any
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].insertText, "const answer = 42;");

    // The server received a well-formed completion request.
    const req = received.find((m) => m.type === "chat:inline-complete");
    assert.ok(req, "server should receive chat:inline-complete");
    assert.strictEqual(req.language, "typescript");
    assert.strictEqual(req.file, "app.ts");
    assert.ok(req.prefix.includes("const answer = "), "prefix must be the typed code");
  });

  it("dispose sends vscode:inactive and closes the socket", async () => {
    wss = await startServer();
    const auth = wireAuth(wss);
    const root = makeDataRoot();
    writePortFile(root, serverPort(wss));

    client = new WsClient(makeContext() as any);
    await waitForConnected(client);
    const socket = auth.sockets[0];

    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    client.dispose();
    client = null;
    await closed;

    const inactive = auth.received.find((m) => m.type === "vscode:inactive");
    assert.ok(inactive, "dispose should announce vscode:inactive");
  });
});
