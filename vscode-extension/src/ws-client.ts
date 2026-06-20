import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { EventEmitter } from "events";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

function electronUserDataDir(): string {
  const appName = "claude-code-but-priestess";
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
  try {
    const filePath = path.join(electronUserDataDir(), "ws-port.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data.port === "number" && typeof data.token === "string") {
      return data as PortFile;
    }
    return null;
  } catch {
    return null;
  }
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
  private bufferedMessages: string[] = [];

  constructor(private context: vscode.ExtensionContext) {
    super();
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

    const portFile = readPortFile();
    if (!portFile) {
      this.scheduleReconnect();
      return;
    }

    try {
      const url = `ws://127.0.0.1:${portFile.port}`;
      // Dynamic import of ws — VS Code extensions bundle their own node_modules
      const WebSocket = require("ws");
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        // Send auth immediately
        this.ws.send(JSON.stringify({ type: "auth", token: portFile.token }));
        // Flush any buffered messages
        for (const msg of this.bufferedMessages) {
          this.ws.send(msg);
        }
        this.bufferedMessages.length = 0;
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", (code: number) => {
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
        // Will trigger 'close' — just log
        this.updateStatusBar("error");
      });
    } catch {
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

    // Handle auth response
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

    // Emit generic events for the API shim
    this.emit(msg.type, msg);
  }

  send(type: string, data?: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = String(++this.reqCounter);
      const msg = JSON.stringify({ type, reqId, ...(data || {}) });

      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Request ${type} timed out`));
      }, 30000);

      this.pending.set(reqId, { resolve, reject, timer });

      if (this.ws && this.authenticated && this.ws.readyState === 1) {
        this.ws.send(msg);
      } else {
        // Buffer for when we connect/authenticate
        this.bufferedMessages.push(msg);
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
      this.connect();
    }, this.reconnectDelay);
  }

  private rejectAllPending(reason: Error) {
    for (const [id, pending] of this.pending) {
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
      // Best-effort: tell the server we're going away
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
