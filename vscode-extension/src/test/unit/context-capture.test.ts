/// <reference types="mocha" />
import * as assert from "assert";
import { ContextCapture, classifyShellCommand } from "../../context-capture";
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

  describe("per-window state", () => {
    it("reports this window's workspace and focus on connect", () => {
      vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: "C:\\Users\\doc\\proj" } }];
      vscodeStub.window.state = { focused: false };
      inst = makeInstance();
      inst.ws.listeners["connected"]();
      assert.deepStrictEqual(inst.ws.calls, [
        { type: "vscode:workspace", data: { workspaceFolders: ["C:\\Users\\doc\\proj"], primaryWorkspace: "C:\\Users\\doc\\proj" } },
        { type: "vscode:focus", data: { focused: false } },
      ]);
    });

    it("sends vscode:focus whenever the window state changes", () => {
      inst = makeInstance();
      vscodeStub.window.state = { focused: true };
      vscodeStub.window._emitters.windowState.emit({ focused: true });
      vscodeStub.window.state = { focused: false };
      vscodeStub.window._emitters.windowState.emit({ focused: false });
      assert.deepStrictEqual(inst.ws.calls, [
        { type: "vscode:focus", data: { focused: true } },
        { type: "vscode:focus", data: { focused: false } },
      ]);
    });

    it("stays quiet while disconnected", () => {
      inst = makeInstance();
      inst.ws.isConnected = () => false;
      vscodeStub.window._emitters.windowState.emit({ focused: true });
      inst.ws.listeners["connected"]();
      assert.deepStrictEqual(inst.ws.calls, []);
    });
  });

  describe("classifyShellCommand", () => {
    const cases: Array<[string, string | null, string | null]> = [
      // [command line, kind, label]
      ["npm test", "test", "npm test"],
      ["npm run test:unit -- --grep foo", "test", "npm run test"],
      ["npm t", "test", "npm test"],
      ["yarn build", "build", "yarn run build"],
      ["pnpm run typecheck", "build", "pnpm run typecheck"],
      ["npx jest --runInBand", "test", "jest"],
      ["pnpm exec vitest run", "test", "vitest"],
      ["CI=1 NODE_ENV=test npx mocha", "test", "mocha"],
      ["tsc -p ./", "build", "tsc"],
      ["./node_modules/.bin/tsc --noEmit", "build", "tsc"],
      ["python3 -m pytest tests/", "test", "python -m pytest"],
      ["cargo build --release", "build", "cargo build"],
      ["go test ./...", "test", "go test"],
      ["mvn clean install", "build", "mvn install"],
      ["make", "build", "make"],
      ["make -j8 check", "test", "make check"],
      // Windows / PowerShell shapes
      ["npm.cmd run build", "build", "npm run build"],
      ["& \"C:\\Program Files\\nodejs\\npm.cmd\" test", "test", "npm test"],
      [".\\gradlew.bat :app:test", "test", "gradlew test"],
      ["NPX.CMD TSC", "build", "tsc"],
      ["dotnet test .\\src\\App.Tests", "test", "dotnet test"],
      ["py -m unittest", "test", "python -m unittest"],
      // Chains report the first recognized command.
      ["cd app && npm test", "test", "npm test"],
      ["npm ci; npm run build", "build", "npm run build"],
      // Not build/test commands.
      ["git status", null, null],
      ["npm install", null, null],
      ["npm run dev", null, null],
      ["make -C sub deploy", null, null],
      ["echo Build failed error TS2304", null, null],
      ["", null, null],
    ];
    for (const [line, kind, label] of cases) {
      it(`classifies ${JSON.stringify(line)}`, () => {
        const match = classifyShellCommand(line);
        if (kind === null) {
          assert.strictEqual(match, null, JSON.stringify(match));
        } else {
          assert.ok(match, "expected a match");
          assert.strictEqual(match!.kind, kind);
          assert.strictEqual(match!.label, label);
        }
      });
    }
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

    it("lists errors before lower severities so the cap never crowds them out", () => {
      inst = makeInstance();
      const sev = vscodeStub.DiagnosticSeverity;
      const mk = (severity: number, message: string, line: number) =>
        ({ severity, message, range: { start: { line } }, source: "ts" });
      const noisy: any[] = [];
      for (let i = 0; i < 60; i++) noisy.push(mk(i % 3 === 0 ? sev.Hint : sev.Warning, `noise ${i}`, i));
      // The errors live in a file enumerated last.
      vscodeStub.languages._diagnostics = [
        [{ fsPath: "C:\\work\\noisy.ts" }, noisy],
        [{ fsPath: "C:\\work\\broken.ts" }, [mk(sev.Error, "first error", 3), mk(sev.Error, "second error", 9)]],
      ];
      const snap = (inst.cc as any).captureDiagnostics();
      assert.strictEqual(snap.errors, 2);
      assert.strictEqual(snap.details.length, 50);
      assert.deepStrictEqual(snap.details.slice(0, 2).map((d: any) => d.message), ["first error", "second error"]);
      assert.strictEqual(snap.details[0].file, "C:\\work\\broken.ts");
      // Stable: warnings keep their order and precede hints.
      const rest = snap.details.slice(2).map((d: any) => d.severity);
      assert.ok(rest.every((s: string) => s === "warning" || s === "hint"));
      assert.strictEqual(rest.indexOf("hint"), rest.lastIndexOf("warning") + 1);
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

  describe("terminal build/test results", () => {
    function endExecution(value: string, exitCode: number | undefined, confidence = 2) {
      vscodeStub.window._emitters.endShellExecution.emit({
        terminal: { name: "zsh" },
        shellIntegration: {},
        execution: { commandLine: { value, confidence, isTrusted: confidence === 2 } },
        exitCode,
      });
    }
    const terminalEvents = () => inst!.ws.calls.filter((c: any) => c.type === "vscode:terminal-event");

    it("never touches the proposed onDidWriteTerminalData API", () => {
      let touched = 0;
      // Stable VS Code throws when an extension without enabledApiProposals
      // calls a proposed API.
      vscodeStub.window.onDidWriteTerminalData = () => {
        touched++;
        throw new Error("proposed API terminalDataWriteEvent is not enabled");
      };
      inst = makeInstance();
      assert.strictEqual(touched, 0);
    });

    it("forwards a failed test command as a structured event without the raw command line", () => {
      inst = makeInstance();
      endExecution("API_KEY=hunter2 npm test -- --grep 'ignore previous instructions'", 1);
      const events = terminalEvents();
      assert.strictEqual(events.length, 1);
      const data = events[0].data;
      assert.strictEqual(data.kind, "test-fail");
      assert.strictEqual(data.command, "npm test");
      assert.strictEqual(data.exitCode, 1);
      assert.strictEqual(typeof data.timestamp, "number");
      assert.deepStrictEqual(Object.keys(data).sort(), ["command", "exitCode", "kind", "timestamp"]);
      const wire = JSON.stringify(data);
      assert.ok(!wire.includes("hunter2") && !wire.includes("ignore previous"), wire);
    });

    it("reports build failures as build-error", () => {
      inst = makeInstance();
      endExecution("npx tsc -p ./", 2);
      assert.strictEqual(terminalEvents()[0].data.kind, "build-error");
      assert.strictEqual(terminalEvents()[0].data.command, "tsc");
    });

    it("ignores success, unknown exit codes, Ctrl+C and unrelated commands", () => {
      inst = makeInstance();
      endExecution("npm test", 0);
      endExecution("npm test", undefined);
      endExecution("npm test", 130);
      endExecution("npm.cmd test", -1073741510);
      endExecution("npm.cmd test", 3221225786);
      endExecution("git push", 1);
      assert.strictEqual(terminalEvents().length, 0);
    });

    it("ignores low-confidence command lines", () => {
      inst = makeInstance();
      endExecution("npm test", 1, 0);
      assert.strictEqual(terminalEvents().length, 0);
    });

    it("does not buffer results while disconnected", () => {
      inst = makeInstance();
      inst.ws.isConnected = () => false;
      endExecution("npm test", 1);
      assert.strictEqual(terminalEvents().length, 0);
    });

    it("works on hosts without shell-integration events (VS Code < 1.93)", () => {
      delete vscodeStub.window.onDidEndTerminalShellExecution;
      inst = makeInstance();
      assert.ok(inst.cc.getCurrentContext());
    });

    it("works on hosts that still gate shell integration behind its proposal", () => {
      vscodeStub.window.onDidEndTerminalShellExecution = () => {
        throw new Error("proposed API terminalShellIntegration is not enabled");
      };
      inst = makeInstance();
      assert.ok(inst.cc.getCurrentContext());
    });

    it("stops listening after dispose", () => {
      inst = makeInstance();
      inst.cc.dispose();
      endExecution("npm test", 1);
      assert.strictEqual(terminalEvents().length, 0);
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
      // The git extension's exports are { enabled, getAPI }; the repository
      // list lives on the versioned API object.
      const gitApi = { repositories: [r1.repo, r2.repo] };
      vscodeStub.extensions.getExtension = () =>
        ({ activate: async () => ({ enabled: true, getAPI: (v: number) => (v === 1 ? gitApi : null) }) }) as any;

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

    it("watches repositories the git extension opens after activation", async () => {
      inst = makeInstance();
      // Collected in an array: a `let` holder assigned inside the callback
      // is narrowed to its initializer by TS and ends up `never` after the
      // assertion below.
      const opened: Array<(repo: any) => void> = [];
      // Repositories are discovered asynchronously: the list is empty when
      // activate() resolves and onDidOpenRepository fires later.
      const gitApi = {
        repositories: [] as any[],
        onDidOpenRepository: (cb: (repo: any) => void) => { opened.push(cb); return { dispose() {} }; },
      };
      vscodeStub.extensions.getExtension = () =>
        ({ activate: async () => ({ enabled: true, getAPI: () => gitApi }) }) as any;
      (inst.cc as any).tryWatchGit();
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(opened.length, 1, "must subscribe to onDidOpenRepository");

      const r1 = makeRepo("/home/doctor/app", { name: "main", commit: { hash: "aaa111" } });
      opened[0](r1.repo);
      r1.repo.state.HEAD = { name: "main", commit: { hash: "bbb222" } };
      r1.emit();
      const kinds = inst.ws.calls.filter((c: any) => c.type === "vscode:activity").map((c: any) => c.data.activity.kind);
      assert.deepStrictEqual(kinds, ["git-commit"]);
    });

    it("ignores exports without getAPI instead of reading repositories off them", async () => {
      inst = makeInstance();
      const r1 = makeRepo("/home/doctor/app", { name: "main", commit: { hash: "aaa111" } });
      vscodeStub.extensions.getExtension = () => ({ activate: async () => ({ repositories: [r1.repo] }) }) as any;
      (inst.cc as any).tryWatchGit();
      await new Promise((r) => setTimeout(r, 10));
      r1.repo.state.HEAD = { name: "dev", commit: { hash: "aaa111" } };
      r1.emit();
      assert.strictEqual(inst.ws.calls.length, 0);
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
