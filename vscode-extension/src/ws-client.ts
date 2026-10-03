import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { EventEmitter } from "events";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
export const PRTS_WS_ORIGIN = "vscode-webview://prts";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

interface PortFile {
  port: number;
  token: string;
  version: string;
}

/**
 * A message queued while the socket is not yet ready to send.
 * Requests carry a reqId and an expiry: if the 30s request timeout fires
 * while the message is still buffered, the buffered copy must be dropped -
 * otherwise a stale request (whose Promise already rejected) would be
 * replayed and executed on the next connection.
 */
interface BufferedMessage {
  raw: string;
  reqId?: string;
  expiresAt?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

// Release builds use "PRTS" as the app name; dev builds use the repo name.
// Try the release name first, then the dev name.
const APP_NAMES = ["PRTS", "claude-code-but-priestess"];

function dataDirFor(appName: string): string {
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", appName);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
  }
}

function readPortFile(): PortFile | null {
  for (const name of APP_NAMES) {
    try {
      const filePath = path.join(dataDirFor(name), "ws-port.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      if (typeof data.port === "number" && typeof data.token === "string") {
        return data as PortFile;
      }
    } catch {
      // try next name
    }
  }
  return null;
}

// Read the manual port config from VS Code settings (prts.electronPort).
// When set, the extension connects directly to that port but still requires
// the auth token from a ws-port.json file in one of the known data dirs.
function manualPortConfig(): { port: number; token: string } | null {
  const cfg = vscode.workspace.getConfiguration("prts");
  const port = cfg.get<number>("electronPort");
  if (!port || port <= 0) return null;
  // When using a manual port, we still need the token from a port file.
  for (const name of APP_NAMES) {
    try {
      const filePath = path.join(dataDirFor(name), "ws-port.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      if (typeof data.token === "string") {
        return { port, token: data.token };
      }
    } catch {
      // try next name
    }
  }
  return null;
}


export class WsClient extends EventEmitter {
  private ws: any = null;
  private connected = false;
  private authenticated = false;
  private disposed = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private reqCounter = 0;
  private statusBarItem: vscode.StatusBarItem;
  private bufferedMessages: BufferedMessage[] = [];
  /** Request timeout in ms; overridable in tests to exercise expiry paths. */
  private readonly requestTimeoutMs: number;
  private static readonly MAX_BUFFERED = 200;
  private manualPort: number | null = null;
  private manualToken: string | null = null;

  /**
   * Snapshot of CLI provider availability as last reported by the server via
   * a `chat:status` message (see ws-server.js / vscode-chat.js). `null` means
   * "unknown": no chat:status has arrived yet. The inline completion provider
   * reads this to avoid firing CLI completions when no usable CLI backend is
   * configured (e.g. priestess-only mode).
   */
  providerAvailability: { activeProvider: string | null } | null = null;

  constructor(
    context: vscode.ExtensionContext,
    options?: { requestTimeoutMs?: number }
  ) {
    super();
    this.requestTimeoutMs = options?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.text = "$(sync~spin) PRTS: connecting…";
    this.statusBarItem.tooltip = "Connecting to the PRTS tray app";
    this.statusBarItem.command = "prts.openChat";
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);

    this.connect();
  }

  private connect() {
    if (this.disposed) return;

    // Check manual port config first
    const manual = manualPortConfig();
    if (manual) {
      this.manualPort = manual.port;
      this.manualToken = manual.token;
    }

    let url: string;
    let authToken: string;

    if (this.manualPort) {
      url = `ws://127.0.0.1:${this.manualPort}`;
      authToken = this.manualToken!;
    } else {
      const portFile = readPortFile();
      if (!portFile) {
        this.scheduleReconnect();
        return;
      }
      url = `ws://127.0.0.1:${portFile.port}`;
      authToken = portFile.token;
    }

    try {
      const WebSocket = require("ws");
      // Node's ws client sends no Origin by default. The PRTS bridge rejects
      // origin-less sockets before token auth, so identify this local client.
      this.ws = new WebSocket(url, { origin: PRTS_WS_ORIGIN });

      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ type: "auth", token: authToken }));
        const now = Date.now();
        for (const msg of this.bufferedMessages) {
          // Drop requests whose timeout already fired while we were
          // disconnected - replaying them would execute a turn the caller
          // already gave up on.
          if (msg.expiresAt && msg.expiresAt < now) continue;
          this.ws.send(msg.raw);
        }
        this.bufferedMessages = this.bufferedMessages.filter(
          (m) => !(m.expiresAt && m.expiresAt < now)
        );
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", (_code: number) => {
        this.connected = false;
        this.authenticated = false;
        this.ws = null;
        this.rejectAllPending(new Error("Connection closed"));
        this.updateStatusBar("disconnected");
        if (!this.disposed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err: Error) => {
        console.error("PRTS: WebSocket error:", err.message);
        this.updateStatusBar("error");
      });
    } catch (error) {
      console.error("PRTS: failed to create WebSocket client", error);
      this.updateStatusBar("error");
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "auth:ok") {
      this.authenticated = true;
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.updateStatusBar("connected");
      this.emit("connected");
      return;
    }

    if (!this.authenticated) return;

    // Handle request-response correlation
    if (msg.reqId && this.pending.has(msg.reqId)) {
      const pending = this.pending.get(msg.reqId)!;
      clearTimeout(pending.timer);
      this.pending.delete(msg.reqId);
      pending.resolve(msg);
      return;
    }

    // Track CLI provider availability so inline completion can avoid wasted
    // requests. This runs before the generic emit so subscribers observe an
    // already-updated snapshot.
    if (msg.type === "chat:status") {
      this.providerAvailability = { activeProvider: msg.provider || null };
    }

    // Emit generic events for the API shim
    this.emit(msg.type, msg);
  }

  /** Fire-and-forget notification — no response expected, no timeout. */
  notify(type: string, data?: Record<string, any>): void {
    const msgObj: any = { type, ...(data || {}) };
    // Notifications carry no reqId — they won't be correlated with a response.
    const msg = JSON.stringify(msgObj);
    if (this.ws && this.authenticated && this.ws.readyState === 1) {
      this.ws.send(msg);
    } else {
      if (this.bufferedMessages.length < WsClient.MAX_BUFFERED) {
        // Notifications are fire-and-forget: buffer them indefinitely (a
        // reconnect flushes them), since they carry no deadline.
        this.bufferedMessages.push({ raw: msg });
      }
    }
  }

  /** Request that expects a response. Creates a Promise with a timeout. */
  request(type: string, data?: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = String(++this.reqCounter);
      const msg = JSON.stringify({ type, reqId, ...(data || {}) });

      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        // Remove the buffered copy too: the caller already gave up, so a
        // later reconnect must not execute this request (e.g. chat:send
        // would start a real CLI turn the user never sees).
        this.bufferedMessages = this.bufferedMessages.filter((b) => b.reqId !== reqId);
        reject(new Error(`Request ${type} timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(reqId, { resolve, reject, timer });

      if (this.ws && this.authenticated && this.ws.readyState === 1) {
        this.ws.send(msg);
      } else {
        if (this.bufferedMessages.length < WsClient.MAX_BUFFERED) {
          this.bufferedMessages.push({ raw: msg, reqId, expiresAt: Date.now() + this.requestTimeoutMs });
        }
      }
    });
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    if (this.reconnectTimer) return;

    this.updateStatusBar("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        RECONNECT_MAX_MS
      );
      this.manualPort = null;
      this.manualToken = null;
      this.connect();
    }, this.reconnectDelay);
  }

  private rejectAllPending(reason: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private updateStatusBar(state: "connected" | "disconnected" | "error" | "reconnecting") {
    switch (state) {
      case "connected":
        this.statusBarItem.text = "$(heart) PRTS";
        this.statusBarItem.tooltip = "PRTS is connected";
        break;
      case "disconnected":
        this.statusBarItem.text = "$(debug-disconnect) PRTS: waiting…";
        this.statusBarItem.tooltip = "Waiting for the PRTS tray app";
        break;
      case "error":
        this.statusBarItem.text = "$(error) PRTS: error";
        this.statusBarItem.tooltip = "Connection error — retrying automatically";
        break;
      case "reconnecting":
        this.statusBarItem.text = "$(sync~spin) PRTS: reconnecting…";
        this.statusBarItem.tooltip = "Reconnecting to the PRTS tray app";
        break;
    }
  }

  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: "vscode:inactive" }));
      } catch {}
      try {
        this.ws.close(1000, "extension deactivated");
      } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.statusBarItem.hide();
    this.statusBarItem.dispose();
    this.rejectAllPending(new Error("Client disposed"));
    this.removeAllListeners();
  }
}
