/// <reference types="mocha" />
import * as assert from "assert";
import { ContextCapture } from "../../context-capture";
import { vscodeStub, resetVscodeStub } from "./helpers/vscode-stub";

// ContextCapture depends on vscode listeners (stubbed) and a ws client
// (mocked). The high-value logic here is pure: terminal output parsing,
// editor context snapshots and diagnostics aggregation.

function makeWsMock() {
  const listeners: Record<string, Function> = {};
  const calls: any[] = [];
  return {
    listeners,
    calls,
    on(type: string, cb: Function) { listeners[type] = cb; },
    notify(type: string, data?: any) { calls.push({ type, data }); },
    request(type: string, data?: any) { calls.push({ type, data }); return Promise.resolve(); },
    isConnected() { return true; },
  };
}

function makeInstance() {
  const ws = makeWsMock();
  const cc = new ContextCapture(ws as any);
  ws.calls.length = 0; // drop the constructor-time vscode:workspace send
  return { ws, cc };
}

function fakeEditor(overrides?: any) {
  const doc = {
    fileName: "C:\\work\\app.ts",
    languageId: "typescript",
    getText: () => "const x = 1;",
  };
  const selection = {
    isEmpty: false,
    active: { line: 4, character: 7 },
    start: { line: 2, character: 0 },
    end: { line: 4, character: 12 },
  };
  return { document: doc, selection, ...(overrides || {}) };
}

describe("context-capture", () => {
  let inst: ReturnType<typeof makeInstance> | null = null;

  beforeEach(() => resetVscodeStub());
  afterEach(() => {
    if (inst) { try { inst.cc.dispose(); } catch { /* ignore */ } inst = null; }
  });

  describe("parseTerminalOutput", () => {
    it("detects build/compilation failures", () => {
      inst = makeInstance();
      const evt = (inst.cc as any).parseTerminalOutput("Build failed\nsrc/main.ts:12:3 error TS2304");
      assert.ok(evt);
      assert.strictEqual(evt.kind, "build-error");
      assert.ok(evt.detail.includes("error TS2304"));
    });

    it("counts failing tests", () => {
      inst = makeInstance();
      const evt = (inst.cc as any).parseTerminalOutput("  4 failing\n  AssertionError ...");
      assert.ok(evt);
      assert.strictEqual(evt.kind, "test-fail");
      assert.ok(evt.detail.includes("4"), evt.detail);
    });

    it("detects passing tests", () => {
      inst = makeInstance();
      const evt = (inst.cc as any).parseTerminalOutput("  All tests passed");
      assert.ok(evt);
      assert.strictEqual(evt.kind, "test-pass");
    });

    it("ignores unrelated terminal noise", () => {
      inst = makeInstance();
      const evt = (inst.cc as any).parseTerminalOutput("hello world");
      assert.strictEqual(evt, null);
    });
  });

  describe("editor context", () => {
    it("snapshots the active editor with selection", () => {
      inst = makeInstance();
      (inst.cc as any).refreshContext(fakeEditor());
      const ctx = inst.cc.getCurrentContext();
      assert.strictEqual(ctx.activeFile, "C:\\work\\app.ts");
      assert.strictEqual(ctx.activeFileLanguage, "typescript");
      assert.strictEqual(ctx.cursorLine, 5);
      assert.strictEqual(ctx.cursorColumn, 8);
      assert.ok(ctx.selection);
      assert.strictEqual(ctx.selection!.startLine, 3);
      assert.strictEqual(ctx.selection!.endLine, 5);
    });

    it("truncates oversized selection text", () => {
      inst = makeInstance();
      const big = "x".repeat(25_000);
      const doc = { fileName: "a.ts", languageId: "typescript", getText: () => big };
      const selection = {
        isEmpty: false,
        active: { line: 1, character: 5 },
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
      };
      (inst.cc as any).refreshContext({ document: doc, selection });
      const text = inst.cc.getCurrentContext().selection!.text;
      assert.ok(text.length <= 20_020, "selection must be capped");
      assert.ok(text.includes("已截断"), "truncation marker must be present");
    });

    it("clears context when no editor is active", () => {
      inst = makeInstance();
      (inst.cc as any).refreshContext(undefined);
      assert.strictEqual(inst.cc.getCurrentContext().activeFile, null);
      assert.strictEqual(inst.cc.getCurrentContext().selection, null);
    });
  });

  describe("diagnostics", () => {
    it("aggregates counts and caps detail entries at 50", () => {
      inst = makeInstance();
      const diags: any[] = [];
      for (let i = 0; i < 60; i++) {
        diags.push({
          severity: i % 2 === 0 ? vscodeStub.DiagnosticSeverity.Error : vscodeStub.DiagnosticSeverity.Warning,
          message: `problem ${i}`,
          range: { start: { line: i } },
          source: "ts",
        });
      }
      vscodeStub.languages._diagnostics = [["file:///a.ts", diags]];
      const snap = (inst.cc as any).captureDiagnostics();
      assert.strictEqual(snap.errors, 30);
      assert.strictEqual(snap.warnings, 30);
      assert.strictEqual(snap.totalFilesWithProblems, 1);
      assert.strictEqual(snap.details.length, 50, "details must be capped to avoid blowing the WS payload");
    });
  });

  describe("task events", () => {
    it("reports success/failure from the real process exit code", () => {
      inst = makeInstance();
      const emitters = vscodeStub.tasks._emitters;
      const execution = {
        task: { name: "build", definition: { program: "npm" } },
      };

      emitters.processEnd.emit({ execution, exitCode: 0 });
      assert.strictEqual(inst.ws.calls[0].type, "vscode:activity");
      assert.strictEqual(inst.ws.calls[0].data.activity.kind, "task-end");

      emitters.processEnd.emit({ execution, exitCode: 1 });
      assert.strictEqual(inst.ws.calls[1].data.activity.kind, "task-error");
    });
  });

  describe("terminal monitoring", () => {
    it("parses buffered output after a silence period", async () => {
      inst = makeInstance();
      const emitters = vscodeStub.window._emitters;
      emitters.writeTerminalData.emit({ data: "Build failed\nsrc/main.ts:1:3 error TS1000" });
      await new Promise((r) => setTimeout(r, 600));
      const evt = inst.ws.calls.find((c: any) => c.type === "vscode:terminal-event");
      assert.ok(evt, "build error should be forwarded");
      assert.strictEqual(evt.data.kind, "build-error");
    });

    it("caps the buffer and flushes immediately when the stream never pauses", async () => {
      inst = makeInstance();
      const emitters = vscodeStub.window._emitters;
      const big = "x".repeat(70_000) + " Build failed";
      emitters.writeTerminalData.emit({ data: big });
      const evt = inst.ws.calls.find((c: any) => c.type === "vscode:terminal-event");
      assert.ok(evt, "overflow should flush immediately without waiting for silence");
      assert.strictEqual((inst.cc as any).terminalBuffer.length, 0, "buffer must be drained");
    });
  });

  describe("git events", () => {
    function makeRepo(root: string, head: any) {
      const listeners: any[] = [];
      const repo = {
        rootUri: { fsPath: root },
        state: {
          HEAD: head,
          onDidChange: (cb: any) => {
            listeners.push(cb);
            return { dispose() {} };
          },
        },
      };
      return { repo, emit: () => listeners.forEach((cb) => cb()) };
    }

    it("watches every repository and classifies branch switches vs new commits", async () => {
      inst = makeInstance();
      const r1 = makeRepo("C:\\work\\a", { name: "main", commit: { hash: "aaa111" } });
      const r2 = makeRepo("C:\\work\\b", { name: "dev", commit: { hash: "bbb222" } });
      const gitApi = { repositories: [r1.repo, r2.repo] };
      vscodeStub.extensions.getExtension = () => ({ activate: async () => gitApi }) as any;

      (inst.cc as any).tryWatchGit({});
      await new Promise((r) => setTimeout(r, 10)); // let activate() resolve

      // Branch switch on repo 1: name changes main -> feature.
      r1.repo.state.HEAD = { name: "feature", commit: { hash: "aaa111" } };
      r1.emit();
      // New commit on repo 2: same branch, new hash.
      r2.repo.state.HEAD = { name: "dev", commit: { hash: "ccc333" } };
      r2.emit();
      // Plain working-tree change on repo 1: HEAD unchanged -> no event.
      r1.emit();

      const kinds = inst.ws.calls
        .filter((c: any) => c.type === "vscode:activity")
        .map((c: any) => c.data.activity.kind);
      assert.ok(kinds.includes("git-branch-switch"), JSON.stringify(kinds));
      assert.ok(kinds.includes("git-commit"), JSON.stringify(kinds));
      assert.strictEqual(kinds.length, 2, JSON.stringify(kinds));
    });
  });

  describe("activity", () => {
    it("save events are throttled to one per 3 seconds", () => {
      inst = makeInstance();
      const send = (kind: string) =>
        (inst!.cc as any).sendActivity({ kind, detail: "x", timestamp: Date.now(), file: "f.ts" });

      send("save");
      send("save"); // within the throttle window -> dropped
      assert.strictEqual(inst.ws.calls.length, 1);
      assert.strictEqual(inst.ws.calls[0].type, "vscode:activity");
    });

    it("non-save activity is forwarded immediately", () => {
      inst = makeInstance();
      (inst.cc as any).sendActivity({ kind: "file-open", detail: "opened", timestamp: Date.now(), file: "f.ts" });
      assert.strictEqual(inst.ws.calls.length, 1);
      assert.strictEqual(inst.ws.calls[0].data.activity.kind, "file-open");
    });
  });
});
