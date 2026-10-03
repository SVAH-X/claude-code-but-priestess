/// <reference types="mocha" />
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatPanelProvider, vscodeEffectiveState } from "../../chat-panel";
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
      const previewDir = tempDirs[0]; // dispose() empties the array in place
      const executed = vscodeStub.commands._executed as any[];
      assert.strictEqual(executed[0].cmd, "vscode.openWith");
      assert.strictEqual(executed[0].args[1], "simpleBrowser");
      (provider as any).dispose();
      assert.ok(!fs.existsSync(previewDir), "dispose should remove the preview dir");
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
          errors.some((m) => m.text.includes("只能对比当前工作区内的文件")),
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
        const diffDir = tempDirs[0]; // dispose() empties the array in place
        assert.ok(fs.existsSync(diffDir), "temp dir should exist");
        const executed = vscodeStub.commands._executed as any[];
        assert.strictEqual(executed[0].cmd, "vscode.diff");

        (provider as any).dispose();
        assert.ok(!fs.existsSync(diffDir), "dispose should remove the temp dir");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // A lexical workspace, laid out as <tmp>/ws (workspace) + <tmp>/outside.txt.
    // The stub's getWorkspaceFolder mirrors VS Code's: it matches path segments
    // lexically and does not resolve ".." or symlinks.
    function makeWorkspace() {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "prts-b9-"));
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws);
      fs.writeFileSync(path.join(ws, "app.ts"), "old", "utf8");
      const outside = path.join(base, "outside.txt");
      fs.writeFileSync(outside, "secret", "utf8");
      vscodeStub.workspace._getWorkspaceFolder = (uri: any) =>
        uri.fsPath === ws || uri.fsPath.startsWith(ws + path.sep) ? { uri: { fsPath: ws } } : undefined;
      return { base, ws, outside };
    }

    function errorsSeen(): string[] {
      return (vscodeStub.window._messages as any[]).filter((m) => m.kind === "error").map((m) => m.text);
    }

    it("rejects '..' segments that lexically start inside the workspace", () => {
      resetVscodeStub();
      const { base, ws } = makeWorkspace();
      try {
        const { provider } = makeHarness();
        // Built by hand: path.join() would already normalise the "..".
        (provider as any).applyFix(ws + path.sep + ".." + path.sep + "outside.txt", "x", 0);
        assert.ok(errorsSeen().some((t) => t.includes("只能对比当前工作区内的文件")));
        assert.strictEqual((provider as any).tempDirs.length, 0);
        assert.strictEqual((vscodeStub.commands._executed as any[]).length, 0);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("rejects a symlink inside the workspace that points outside it", function () {
      resetVscodeStub();
      const { base, ws, outside } = makeWorkspace();
      try {
        const link = path.join(ws, "link.txt");
        try {
          fs.symlinkSync(outside, link, "file");
        } catch (err: any) {
          // Windows without Developer Mode / admin cannot create file symlinks.
          if (err && (err.code === "EPERM" || err.code === "EACCES")) return this.skip();
          throw err;
        }
        const { provider } = makeHarness();
        (provider as any).applyFix(link, "x", 0);
        assert.ok(errorsSeen().some((t) => t.includes("只能对比当前工作区内的文件")));
        assert.strictEqual((provider as any).tempDirs.length, 0);
        assert.strictEqual((vscodeStub.commands._executed as any[]).length, 0);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("rejects relative paths, non-string input and directories", () => {
      resetVscodeStub();
      const { base, ws } = makeWorkspace();
      try {
        const { provider } = makeHarness();
        (provider as any).applyFix("app.ts", "x", 0);
        (provider as any).applyFix(undefined, "x", 0);
        (provider as any).applyFix(path.join(ws, "app.ts"), { not: "a string" }, 0);
        assert.strictEqual(errorsSeen().filter((t) => t.includes("无效的对比请求")).length, 3);
        (provider as any).applyFix(ws, "x", 0);
        assert.ok(errorsSeen().some((t) => t.includes("目标不是文件")));
        assert.strictEqual((provider as any).tempDirs.length, 0);
        assert.strictEqual((vscodeStub.commands._executed as any[]).length, 0);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("reports a missing workspace file without opening a diff", () => {
      resetVscodeStub();
      const { base, ws } = makeWorkspace();
      try {
        const { provider } = makeHarness();
        (provider as any).applyFix(path.join(ws, "gone.ts"), "x", 0);
        assert.ok(errorsSeen().some((t) => t.includes("找不到文件")));
        assert.strictEqual((provider as any).tempDirs.length, 0);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("diffs a normalised in-workspace path against the suggestion", () => {
      resetVscodeStub();
      const { base, ws } = makeWorkspace();
      try {
        const { provider } = makeHarness();
        // "<ws>/sub/../app.ts" stays inside once resolved.
        (provider as any).applyFix(ws + path.sep + "sub" + path.sep + ".." + path.sep + "app.ts", "new code", 0);
        assert.deepStrictEqual(errorsSeen(), []);
        const executed = vscodeStub.commands._executed as any[];
        assert.strictEqual(executed.length, 1);
        assert.strictEqual(executed[0].cmd, "vscode.diff");
        assert.strictEqual(executed[0].args[0].fsPath, path.join(ws, "app.ts"));
        assert.strictEqual(fs.readFileSync(executed[0].args[1].fsPath, "utf8"), "new code");
        (provider as any).dispose();
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });
});

describe("chat-panel reply correlation", () => {
  beforeEach(() => resetVscodeStub());

  it("answers chat:send with the webview's reqId even though the WS envelope carries its own", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "chat:send", text: "hi", reqId: "1" }, webview);
    // ws-client resolves with the raw server envelope: its reqId is the
    // ws-client counter, not the webview's, and must not win.
    ws.pending[0].resolve({ type: "chat:send:result", reqId: "41", ok: true, queued: false, queueLength: 0 });
    await wait(0);
    assert.strictEqual(posted[0].type, "chat:send:result");
    assert.strictEqual(posted[0].reqId, "1");
    assert.strictEqual(posted[0].ok, true);
  });

  it("answers desktop-pet:cat-mode-get with the webview's reqId", async () => {
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "desktop-pet:cat-mode-get", reqId: "2" }, webview);
    ws.pending[0].resolve({ type: "desktop-pet:cat-mode-get:result", reqId: "7", cat: true, mood: "normal" });
    await wait(0);
    assert.strictEqual(posted[0].reqId, "2");
    assert.strictEqual(posted[0].cat, true);
  });
});

describe("chat-panel VS Code-effective status line", () => {
  beforeEach(() => resetVscodeStub());

  it("vscodeEffectiveState overlays the workspace cwd and caps agent at advisor", () => {
    const tray = { chatCwd: "/Users/doctor/tray", vibeCodingMode: "agent", chatProvider: "claude" };
    assert.deepStrictEqual(vscodeEffectiveState(tray, "C:\\work\\app"), {
      chatCwd: "C:\\work\\app", vibeCodingMode: "advisor", chatProvider: "claude",
    });
    // No workspace open: the tray cwd is what the turn would use.
    assert.deepStrictEqual(vscodeEffectiveState({ chatCwd: "/t", vibeCodingMode: "advisor" }, null),
      { chatCwd: "/t", vibeCodingMode: "advisor" });
    assert.strictEqual(vscodeEffectiveState(null, "/w"), null);
    assert.strictEqual(tray.vibeCodingMode, "agent", "input must not be mutated");
  });

  it("relays settings:get and settings:state with the VS Code-effective values", async () => {
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: "C:\\work\\app" } }];
    const { ws, provider, posted, webview } = makeHarness();
    (provider as any).handleWebviewMessage({ type: "settings:get", reqId: "3" }, webview);
    ws.pending[0].resolve({ type: "settings:get:result", reqId: "1", state: { chatCwd: "/tray", vibeCodingMode: "agent" } });
    await wait(0);
    assert.deepStrictEqual(posted[0], {
      type: "settings:get:result", reqId: "3", state: { chatCwd: "C:\\work\\app", vibeCodingMode: "advisor" },
    });

    // Broadcast path: wireWsEvents subscribes through ws.on().
    const handlers: Record<string, (d: any) => void> = {};
    (ws as any).on = (evt: string, fn: (d: any) => void) => { handlers[evt] = fn; };
    (provider as any).wireWsEvents(webview);
    handlers["settings:state"]({ type: "settings:state", state: { chatCwd: "/tray", vibeCodingMode: "companion" } });
    assert.deepStrictEqual(posted[1], {
      type: "settings:state", state: { chatCwd: "C:\\work\\app", vibeCodingMode: "companion" },
    });
    // Other events pass through untouched.
    handlers["chat:chunk"]({ type: "chat:chunk", text: "x" });
    assert.deepStrictEqual(posted[2], { type: "chat:chunk", text: "x" });
  });
});

describe("chat-panel webview markup", () => {
  beforeEach(() => resetVscodeStub());

  function buildHtml(): string {
    vscodeStub.Uri.joinPath = (base: any, ...parts: string[]) => {
      const p = [base.fsPath, ...parts].join("/");
      return { fsPath: p, path: p, toString: () => p };
    };
    const provider = new ChatPanelProvider({ extensionUri: { fsPath: "/ext" } } as any, makeWsClient() as any);
    return (provider as any).buildHtml({ asWebviewUri: (u: any) => u.toString(), cspSource: "vscode-resource:" });
  }

  it("puts the Stop button in the composer, hidden until the renderer enables it", () => {
    const html = buildHtml();
    const composer = html.slice(html.indexOf('<form id="composer"'), html.indexOf("</form>"));
    assert.ok(/<button type="button" id="cancelBtn" disabled>/.test(composer), "Stop lives next to Send");
    assert.ok(/#cancelBtn\[disabled\]\s*\{\s*display:\s*none/.test(html), "visibility follows the disabled state");
    assert.ok(!/<header class="top-bar"[^]*id="cancelBtn"[^]*<\/header>/.test(html), "not in the hidden header");
  });

  it("keeps the HTML preview panel and its close button renderable", () => {
    const html = buildHtml();
    assert.ok(!/\.html-preview\s*\{\s*display:\s*none/.test(html), "panel must not be display:none");
    assert.ok(!/\.preview-divider\s*\{\s*display:\s*none/.test(html));
    assert.ok(html.includes('id="closePreviewBtn"'));
    assert.ok(html.includes('id="previewFrame"'));
  });
});
