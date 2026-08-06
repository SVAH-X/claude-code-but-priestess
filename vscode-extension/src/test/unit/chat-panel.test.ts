/// <reference types="mocha" />
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatPanelProvider } from "../../chat-panel";
import { vscodeStub, resetVscodeStub } from "./helpers/vscode-stub";

// ChatPanelProvider relays webview messages to the ws client. These tests pin
// the request/response contract: every server round-trip must reply to the
// webview (success or an error envelope) so the UI never hangs and failures
// never become unhandled promise rejections.

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingCall {
  type: string;
  data: any;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

function makeWsClient() {
  const pending: PendingCall[] = [];
  const notifyCalls: Array<{ type: string; data: any }> = [];
  return {
    pending,
    notifyCalls,
    request: (type: string, data?: any) =>
      new Promise<any>((resolve, reject) => {
        pending.push({ type, data, resolve, reject });
      }),
    notify: (type: string, data?: any) => {
      notifyCalls.push({ type, data });
    },
  };
}

function makeHarness() {
  const ws = makeWsClient();
  const provider = new ChatPanelProvider({} as any, ws as any);
  const posted: any[] = [];
  const webview = { postMessage: (m: any) => posted.push(m) };
  return { ws, provider, posted, webview };
}

describe("chat-panel message routing", () => {
  beforeEach(() => resetVscodeStub());

  it("forwards chat:send and relays the server result to the webview", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "chat:send", text: "hi", reqId: "1" }, webview);

    assert.strictEqual(ws.pending.length, 1);
    assert.strictEqual(ws.pending[0].type, "chat:send");
    assert.strictEqual(ws.pending[0].data.text, "hi");

    ws.pending[0].resolve({ ok: true, queued: false, queueLength: 0 });
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "chat:send:result",
      reqId: "1",
      ok: true,
      queued: false,
      queueLength: 0,
    });
  });

  it("sends an error envelope to the webview when chat:send fails", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "chat:send", text: "hi", reqId: "7" }, webview);

    ws.pending[0].reject(new Error("connection closed"));
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "chat:send:result",
      reqId: "7",
      ok: false,
      error: "connection closed",
    });
  });

  it("sends an error envelope for settings:get failures", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "settings:get", reqId: "9" }, webview);

    ws.pending[0].reject(new Error("timed out"));
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "settings:get:result",
      reqId: "9",
      ok: false,
      error: "timed out",
    });
  });

  it("catches settings:set failures instead of leaving an unhandled rejection", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "settings:set", patch: { vibeCodingMode: "advisor" }, reqId: "3" }, webview);

    assert.strictEqual(ws.pending.length, 1);
    ws.pending[0].reject(new Error("no server"));
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "settings:set:result",
      reqId: "3",
      ok: false,
      error: "no server",
    });
  });

  it("forwards chat:get-history results with the history payload", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "chat:get-history", reqId: "5" }, webview);

    ws.pending[0].resolve({ history: [{ role: "user", text: "a" }] });
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "chat:get-history:result",
      reqId: "5",
      history: [{ role: "user", text: "a" }],
    });
  });
  describe("html preview", () => {
    it("opens generated HTML in the Simple Browser with a tracked temp file", () => {
      resetVscodeStub();
      const { provider } = makeHarness();
      (provider as any).openHtmlInBrowser("<h1>hi</h1>");
      const tempDirs = (provider as any).tempDirs as string[];
      assert.strictEqual(tempDirs.length, 1);
      const executed = vscodeStub.commands._executed as any[];
      assert.strictEqual(executed[0].cmd, "vscode.openWith");
      assert.strictEqual(executed[0].args[1], "simpleBrowser");
      (provider as any).dispose();
      assert.ok(!fs.existsSync(tempDirs[0]), "dispose should remove the preview dir");
    });

    it("rejects empty HTML without creating temp files", () => {
      resetVscodeStub();
      const { provider } = makeHarness();
      (provider as any).openHtmlInBrowser("   ");
      assert.strictEqual((provider as any).tempDirs.length, 0);
      const errors = (vscodeStub.window._messages as any[]).filter((m) => m.kind === "error");
      assert.ok(errors.some((m) => m.text.includes("没有可预览")), "empty HTML must be rejected");
    });
  });

  describe("applyFix", () => {
    it("rejects files outside the workspace without creating temp files", () => {
      resetVscodeStub();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prts-m3-"));
      const file = path.join(dir, "app.ts");
      fs.writeFileSync(file, "old", "utf8");
      try {
        vscodeStub.workspace._getWorkspaceFolder = () => undefined;
        const { provider } = makeHarness();
        (provider as any).applyFix(file, "new code", 0);
        const errors = (vscodeStub.window._messages as any[]).filter((m) => m.kind === "error");
        assert.ok(
          errors.some((m) => m.text.includes("outside the workspace")),
          "outside files must be rejected"
        );
        assert.strictEqual((provider as any).tempDirs.length, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("tracks the temp diff dir and cleans it up on dispose", () => {
      resetVscodeStub();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prts-m3-"));
      const file = path.join(dir, "app.ts");
      fs.writeFileSync(file, "old", "utf8");
      try {
        vscodeStub.workspace._getWorkspaceFolder = () => ({ uri: { fsPath: dir } });
        const { provider } = makeHarness();
        (provider as any).applyFix(file, "new code", 0);
        const tempDirs = (provider as any).tempDirs as string[];
        assert.strictEqual(tempDirs.length, 1);
        assert.ok(fs.existsSync(tempDirs[0]), "temp dir should exist");
        const executed = vscodeStub.commands._executed as any[];
        assert.strictEqual(executed[0].cmd, "vscode.diff");

        (provider as any).dispose();
        assert.ok(!fs.existsSync(tempDirs[0]), "dispose should remove the temp dir");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
