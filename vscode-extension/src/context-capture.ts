/**
 * Vibe coding: captures VS Code editor context, diagnostics, workspace info,
 * and activity events.  Sends snapshots to the Electron backend via WebSocket
 * so Priestess can participate in the coding session.
 */

import * as vscode from "vscode";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorContext {
  activeFile: string | null;
  activeFileLanguage: string | null;
  cursorLine: number;
  cursorColumn: number;
  selection: SelectionSnapshot | null;
}

export interface SelectionSnapshot {
  text: string;
  startLine: number;
  endLine: number;
}

export interface DiagnosticsSnapshot {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  totalFilesWithProblems: number;
  details: DiagnosticDetail[];
}

export interface DiagnosticDetail {
  file: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  source: string;
}

export interface ActivityEvent {
  kind: "save" | "task-start" | "task-end" | "task-error" | "git-commit" | "git-branch-switch" | "file-open" | "terminal-output";
  detail: string;
  timestamp: number;
  file: string;
}

export interface TerminalEvent {
  kind: "build-error" | "test-fail" | "test-pass" | "lint-warning";
  detail: string;
  source: string; // terminal name
  timestamp: number;
}

/**
 * Upper bound for selection text attached to chat context. The selection is
 * sent over the WS bridge (server maxPayload is 4MB) and included in every
 * prompt; a full-file selection on a huge file would blow both. Truncate
 * with a marker so the model knows the selection was cut off.
 */
const MAX_SELECTION_CHARS = 20_000;

/**
 * Cap for the terminal-output buffer. Long-running streams (e.g.
 * `npm run watch`) never pause, so the 500ms silence debounce would never
 * fire and the buffer would grow without bound. When the cap is hit the
 * buffer is flushed immediately (keeping the most recent output).
 */
const MAX_TERMINAL_BUFFER = 64 * 1024;

// ---------------------------------------------------------------------------
// ContextCapture
// ---------------------------------------------------------------------------

export class ContextCapture {
  private wsClient: any;
  private currentContext: EditorContext;
  private diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private contextDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsSnapshot: DiagnosticsSnapshot | null = null;
  private disposables: vscode.Disposable[] = [];
  private gitWatchers: vscode.Disposable[] = [];
  /**
   * Last observed HEAD per repository root (fsPath -> { name, hash }). Used
   * to classify git state changes into branch switches vs new commits.
   */
  private gitHeadState = new Map<string, { name: string | null; hash: string | null }>();
  private terminalBuffer = "";
  private terminalDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  constructor(wsClient: any) {
    this.wsClient = wsClient;
    this.currentContext = this.emptyContext();

    // Send workspace paths on connect
    this.wsClient.on("connected", () => {
      this.sendWorkspace();
    });

    // ---- Editor context listeners ----

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.refreshContext(editor);
        this.flushContext();
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.refreshContext(e.textEditor);
        this.debounceContextFlush();
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.sendWorkspace();
      })
    );

    // ---- Diagnostics ----

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        this.debounceDiagnosticsFlush();
      })
    );

    // ---- Activity ----

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.sendActivity({
          kind: "save",
          detail: `Saved ${doc.fileName.split(/[\\/]/).pop()}`,
          timestamp: Date.now(),
          file: doc.fileName,
        });
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.sendActivity({
            kind: "file-open",
            detail: `Opened ${editor.document.fileName.split(/[\\/]/).pop()}`,
            timestamp: Date.now(),
            file: editor.document.fileName,
          });
        }
      })
    );

    // ---- Tasks ----

    try {
      this.disposables.push(
        vscode.tasks.onDidStartTask((e) => {
          this.sendActivity({
            kind: "task-start",
            detail: `Task started: ${e.execution.task.name}`,
            timestamp: Date.now(),
            file: e.execution.task.definition?.program || "",
          });
        })
      );
      this.disposables.push(
        // onDidEndTask gives a TaskEndEvent with no process outcome at all;
        // the old code tried to read exitCode from the task *definition*, but
        // that is static JSON from tasks.json and never carries a runtime
        // exit code - so every task end was misreported as "failed".
        // onDidEndTaskProcess exposes the real process exit code, so success
        // (0) and failure (non-zero) are now reported accurately.
        vscode.tasks.onDidEndTaskProcess((e) => {
          this.sendActivity({
            kind: e.exitCode === 0 ? "task-end" : "task-error",
            detail: `Task ${e.execution.task.name} ${e.exitCode === 0 ? "completed" : "failed"}`,
            timestamp: Date.now(),
            file: e.execution.task.definition?.program || "",
          });
        })
      );
    } catch {
      // tasks API unavailable in some VS Code variants
    }

    // ---- Git (optional, best-effort) ----
    this.tryWatchGit();

    // ---- Terminal output monitoring ----
    try {
      this.disposables.push(
        (vscode.window as any).onDidWriteTerminalData((e: any) => {
          this.terminalBuffer += String(e.data || "");
          if (this.terminalBuffer.length > MAX_TERMINAL_BUFFER) {
            // The stream never pauses (e.g. `npm run watch`): flush right
            // away to bound memory instead of waiting for 500ms of silence.
            this.terminalBuffer = this.terminalBuffer.slice(-MAX_TERMINAL_BUFFER);
            this.flushTerminalBuffer();
            return;
          }
          if (this.terminalDebounceTimer) clearTimeout(this.terminalDebounceTimer);
          // Debounce: wait 500ms of silence before parsing.
          this.terminalDebounceTimer = setTimeout(() => this.flushTerminalBuffer(), 500);
        })
      );
    } catch {
      // onDidWriteTerminalData unavailable in some VS Code versions
    }

    // Send initial context
    this.refreshContext(vscode.window.activeTextEditor);
    this.sendWorkspace();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Returns the last captured editor context (for attaching to chat messages). */
  getCurrentContext(): EditorContext {
    return this.currentContext;
  }

  /** Returns the latest diagnostics snapshot (may be null if never captured). */
  getDiagnostics(): DiagnosticsSnapshot | null {
    return this.diagnosticsSnapshot;
  }

  /** Forces an immediate context flush to the Electron backend. */
  flushContext(): void {
    if (!this.wsClient?.isConnected()) return;
    this.wsClient.notify("vscode:context", { context: this.currentContext });
  }

  dispose(): void {
    for (const d of this.disposables) {
      try { d.dispose(); } catch (_) { /* ignore */ }
    }
    this.disposables.length = 0;
    for (const w of this.gitWatchers) {
      try { w.dispose(); } catch (_) { /* ignore */ }
    }
    this.gitWatchers.length = 0;
    this.gitHeadState.clear();
    if (this.diagnosticsDebounceTimer) {
      clearTimeout(this.diagnosticsDebounceTimer);
      this.diagnosticsDebounceTimer = null;
    }
    if (this.contextDebounceTimer) {
      clearTimeout(this.contextDebounceTimer);
      this.contextDebounceTimer = null;
    }
    if (this.terminalDebounceTimer) {
      clearTimeout(this.terminalDebounceTimer);
      this.terminalDebounceTimer = null;
    }
    this.terminalBuffer = "";
  }

  // -----------------------------------------------------------------------
  // Internals — context
  // -----------------------------------------------------------------------

  private emptyContext(): EditorContext {
    return {
      activeFile: null,
      activeFileLanguage: null,
      cursorLine: 0,
      cursorColumn: 0,
      selection: null,
    };
  }

  private refreshContext(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.currentContext = this.emptyContext();
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    let selectionText = sel.isEmpty
      ? null
      : doc.getText(sel);
    // Cap oversized selections (see MAX_SELECTION_CHARS) so a huge
    // selection cannot blow the WS payload or inflate every prompt.
    if (selectionText && selectionText.length > MAX_SELECTION_CHARS) {
      selectionText = selectionText.slice(0, MAX_SELECTION_CHARS) + "\n…(选中内容过长已截断)";
    }

    this.currentContext = {
      activeFile: doc.fileName,
      activeFileLanguage: doc.languageId,
      cursorLine: sel.active.line + 1,
      cursorColumn: sel.active.character + 1,
      selection: selectionText
        ? {
            text: selectionText,
            startLine: sel.start.line + 1,
            endLine: sel.end.line + 1,
          }
        : null,
    };
  }

  private debounceContextFlush(): void {
    if (this.contextDebounceTimer) clearTimeout(this.contextDebounceTimer);
    this.contextDebounceTimer = setTimeout(() => {
      this.contextDebounceTimer = null;
      this.flushContext();
    }, 800);
  }

  // -----------------------------------------------------------------------
  // Internals — diagnostics
  // -----------------------------------------------------------------------

  private captureDiagnostics(): DiagnosticsSnapshot {
    const all = vscode.languages.getDiagnostics();
    const details: DiagnosticDetail[] = [];
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    let hints = 0;

    for (const [uri, diags] of all) {
      for (const d of diags) {
        const severity =
          d.severity === vscode.DiagnosticSeverity.Error ? "error" :
          d.severity === vscode.DiagnosticSeverity.Warning ? "warning" :
          d.severity === vscode.DiagnosticSeverity.Information ? "info" :
          "hint";

        if (severity === "error") errors++;
        else if (severity === "warning") warnings++;
        else if (severity === "info") infos++;
        else hints++;

        details.push({
          file: uri.fsPath,
          severity,
          message: d.message,
          line: d.range.start.line + 1,
          source: d.source || "",
        });
      }
    }

    // Cap details at 50 entries to avoid blowing up WS payload (large projects
    // can produce thousands of diagnostics, potentially exceeding maxPayload).
    const MAX_DETAILS = 50;
    if (details.length > MAX_DETAILS) details.length = MAX_DETAILS;

    return {
      errors,
      warnings,
      infos,
      hints,
      totalFilesWithProblems: all.filter(([_, ds]) => ds.length > 0).length,
      details,
    };
  }

  private debounceDiagnosticsFlush(): void {
    if (this.diagnosticsDebounceTimer) clearTimeout(this.diagnosticsDebounceTimer);
    this.diagnosticsDebounceTimer = setTimeout(() => {
      this.diagnosticsDebounceTimer = null;
      this.diagnosticsSnapshot = this.captureDiagnostics();
      if (!this.wsClient?.isConnected()) return;
      this.wsClient.notify("vscode:diagnostics", {
        diagnostics: this.diagnosticsSnapshot,
      });
    }, 2000); // 2s debounce — diagnostics can fire in bursts
  }

  // -----------------------------------------------------------------------
  // Internals — workspace
  // -----------------------------------------------------------------------

  private sendWorkspace(): void {
    if (!this.wsClient?.isConnected()) return;
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    this.wsClient.notify("vscode:workspace", {
      workspaceFolders: folders,
      primaryWorkspace: folders[0] || null,
    });
  }

  // -----------------------------------------------------------------------
  // Internals — activity
  // -----------------------------------------------------------------------

  private sendActivity(activity: ActivityEvent): void {
    if (!this.wsClient?.isConnected()) return;
    // Suppress high-frequency saves (only send if > 3s since last save)
    if (activity.kind === "save") {
      this.sendActivityImpl("vscode:activity", { activity });
    } else {
      this.wsClient.notify("vscode:activity", { activity });
    }
  }

  private lastSaveTs = 0;
  private sendActivityImpl(type: string, payload: any): void {
    const now = Date.now();
    if (payload.activity?.kind === "save") {
      if (now - this.lastSaveTs < 3000) return;
      this.lastSaveTs = now;
    }
    this.wsClient.notify(type, payload);
  }

  // -----------------------------------------------------------------------
  // Internals — terminal output parsing
  // -----------------------------------------------------------------------

  private parseTerminalOutput(text: string): TerminalEvent | null {
    // Detect build/test/lint results from terminal output.
    if (/Build failed|Compilation failed|error TS\d+/.test(text)) {
      const lines = text.split("\n").filter((l: string) => /error|Error|FAIL/i.test(l));
      return {
        kind: "build-error",
        detail: lines.slice(0, 5).join("\n") || "Build/compilation error detected",
        source: "terminal",
        timestamp: Date.now(),
      };
    }
    if (/(\d+)\s+failing|Tests:\s+\d+\s+failed|FAIL\s/.test(text)) {
      const failMatch = text.match(/(\d+)\s+failing/);
      const failCount = failMatch ? parseInt(failMatch[1], 10) : 1;
      return {
        kind: "test-fail",
        detail: `${failCount} test${failCount > 1 ? "s" : ""} failing`,
        source: "terminal",
        timestamp: Date.now(),
      };
    }
    if (/All tests passed|Tests:\s+\d+\s+passed.*0\s+failed/.test(text)) {
      return {
        kind: "test-pass",
        detail: "All tests passed",
        source: "terminal",
        timestamp: Date.now(),
      };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Internals — git (best-effort)
  // -----------------------------------------------------------------------

  /**
   * Parses and forwards the accumulated terminal output, then clears the
   * buffer. Used by both the silence debounce and the overflow path.
   */
  private flushTerminalBuffer(): void {
    if (this.terminalDebounceTimer) {
      clearTimeout(this.terminalDebounceTimer);
      this.terminalDebounceTimer = null;
    }
    const txt = this.terminalBuffer;
    this.terminalBuffer = "";
    const parsed = this.parseTerminalOutput(txt);
    if (parsed && this.wsClient?.isConnected()) {
      this.wsClient.notify("vscode:terminal-event", parsed);
    }
  }

  private tryWatchGit(): void {
    try {
      // The git extension API is not directly importable - detect at runtime
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (!gitExt) return;
      Promise.resolve(gitExt.activate()).then((api: any) => {
        if (!api || !api.repositories) return;
        for (const repo of api.repositories) {
          const root = repo.rootUri?.fsPath || "";
          // Remember the current HEAD so state changes can be classified.
          // repo.state fires on ANY change (file status, index, HEAD...), so
          // comparing the HEAD reference lets us report real branch switches
          // and new commits instead of "HEAD changed" for every refresh.
          const snapshot = this.snapshotGitHead(repo);
          if (snapshot) this.gitHeadState.set(root, snapshot);
          this.gitWatchers.push(
            repo.state.onDidChange(() => {
              const next = this.snapshotGitHead(repo);
              if (!next) return;
              const prev = this.gitHeadState.get(root);
              this.gitHeadState.set(root, next);
              if (prev && next.name && prev.name !== next.name) {
                // The branch pointer moved - a real branch switch.
                this.sendActivity({
                  kind: "git-branch-switch",
                  detail: `Branch switched to ${next.name} in ${path.basename(root) || "repo"}`,
                  timestamp: Date.now(),
                  file: root,
                });
              } else if (prev && next.hash && prev.hash !== next.hash) {
                // Same branch, new commit.
                this.sendActivity({
                  kind: "git-commit",
                  detail: `New commit ${next.hash.slice(0, 7)} in ${path.basename(root) || "repo"}`,
                  timestamp: Date.now(),
                  file: root,
                });
              }
              // Otherwise: a plain working-tree/index change - nothing to report.
            })
          );
        }
      }, () => { /* git not available */ });
    } catch {
      // Git extension not available - silently ignore
    }
  }

  /**
   * Reads the current HEAD reference (name + commit hash). Returns null when
   * the repository has no HEAD yet (empty repo / detached with no commit).
   */
  private snapshotGitHead(repo: any): { name: string | null; hash: string | null } | null {
    const head = repo.state?.HEAD;
    if (!head) return null;
    return { name: head.name ?? null, hash: head.commit?.hash ?? null };
  }
}
