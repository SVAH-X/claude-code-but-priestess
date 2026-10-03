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

/**
 * A build/test command that failed in the integrated terminal. Deliberately
 * structured: `command` is a canonical label ("npm test", "cargo build"),
 * never the typed command line or its output, because the event can end up
 * in a silent proactive prompt on the Electron side.
 */
export interface TerminalEvent {
  kind: "build-error" | "test-fail";
  command: string;
  exitCode: number;
  timestamp: number;
}

export interface ShellCommandMatch {
  kind: "build" | "test";
  label: string;
}

/**
 * Upper bound for selection text attached to chat context. The selection is
 * sent over the WS bridge (server maxPayload is 4MB) and included in every
 * prompt; a full-file selection on a huge file would blow both. Truncate
 * with a marker so the model knows the selection was cut off.
 */
const MAX_SELECTION_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Terminal command classification (pure; exported for tests)
// ---------------------------------------------------------------------------

const TEST_RUNNERS = new Set(["jest", "mocha", "vitest", "pytest", "ava", "jasmine"]);
const BUILD_TOOLS = new Set(["tsc", "webpack", "rollup", "esbuild", "msbuild"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_EXECUTORS = new Set(["npx", "pnpx", "bunx"]);
const TEST_SCRIPTS = new Set(["test", "tests", "t", "tst"]);
const BUILD_SCRIPTS = new Set(["build", "compile", "typecheck", "tsc"]);
/** Tools whose subcommand/target says whether it is a build or a test. */
const SUBCOMMAND_TOOLS: Record<string, { test: string[]; build: string[] }> = {
  cargo: { test: ["test", "nextest"], build: ["build", "check"] },
  go: { test: ["test"], build: ["build"] },
  dotnet: { test: ["test"], build: ["build"] },
  swift: { test: ["test"], build: ["build"] },
  make: { test: ["test", "check"], build: ["build", "all"] },
  gradle: { test: ["test", "check"], build: ["build", "assemble"] },
  gradlew: { test: ["test", "check"], build: ["build", "assemble"] },
  mvn: { test: ["test", "verify"], build: ["compile", "package", "install"] },
  mvnw: { test: ["test", "verify"], build: ["compile", "package", "install"] },
};
/** Prefix tokens that don't name the command itself. */
const PREFIX_TOKENS = new Set(["&", "time", "sudo", "env", "cross-env"]);

/**
 * Normalizes a program token across platforms: strips quotes and the
 * directory (either separator), lowercases (Windows is case-insensitive) and
 * drops Windows launcher extensions, so `& "C:\Program Files\nodejs\npm.cmd"`
 * and `./node_modules/.bin/jest` both resolve to the bare tool name.
 */
function programName(token: string): string {
  const unquoted = token.replace(/^["']+|["']+$/g, "");
  const base = unquoted.split(/[\\/]/).pop() || "";
  return base.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

function classifyTokens(tokens: string[]): ShellCommandMatch | null {
  let i = 0;
  while (i < tokens.length && (PREFIX_TOKENS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  if (i >= tokens.length) return null;
  const prog = programName(tokens[i]);
  const args = tokens.slice(i + 1).map((t) => t.replace(/^["']+|["']+$/g, ""));
  const positional = args.filter((a) => !a.startsWith("-"));

  if (TEST_RUNNERS.has(prog)) return { kind: "test", label: prog };
  if (BUILD_TOOLS.has(prog)) return { kind: "build", label: prog };
  if (PACKAGE_EXECUTORS.has(prog)) return classifyTokens(args);
  if ((prog === "python" || prog === "python3" || prog === "py") && args[0] === "-m") {
    const mod = (args[1] || "").toLowerCase();
    if (mod === "pytest" || mod === "unittest") return { kind: "test", label: `python -m ${mod}` };
    return null;
  }
  if (SCRIPT_RUNNERS.has(prog)) {
    const sub = (positional[0] || "").toLowerCase();
    if (!sub) return null;
    if (sub === "exec" || sub === "dlx" || sub === "x") return classifyTokens(args.slice(args.indexOf(positional[0]) + 1));
    const isRun = sub === "run" || sub === "run-script";
    const script = (isRun ? positional[1] || "" : sub).toLowerCase();
    // "test:unit" / "build:prod" count as their base script.
    const base = script.split(":")[0];
    if (TEST_SCRIPTS.has(base)) return { kind: "test", label: `${prog} ${isRun ? "run " : ""}test` };
    if (BUILD_SCRIPTS.has(base)) return { kind: "build", label: `${prog} run ${base}` };
    // `yarn jest`, `pnpm tsc`: package managers also run binaries directly.
    if (!isRun && (TEST_RUNNERS.has(base) || BUILD_TOOLS.has(base))) {
      return { kind: TEST_RUNNERS.has(base) ? "test" : "build", label: base };
    }
    return null;
  }
  const rules = SUBCOMMAND_TOOLS[prog];
  if (rules) {
    // Gradle task paths like ":app:test" count as their last segment.
    const targets = positional.map((a) => a.toLowerCase().split(":").pop() || "");
    const test = targets.find((t) => rules.test.includes(t));
    if (test) return { kind: "test", label: `${prog} ${test}` };
    const build = targets.find((t) => rules.build.includes(t));
    if (build) return { kind: "build", label: `${prog} ${build}` };
    if (prog === "make" && targets.length === 0) return { kind: "build", label: "make" };
    return null;
  }
  return null;
}

/**
 * Recognizes a build or test command in a terminal command line and returns
 * its kind plus a canonical label, or null for anything else. Chains
 * (`&&`, `||`, `;`, `|`) report their first recognized command. Handles
 * POSIX shells, PowerShell (`&` call operator, quoted paths, `.cmd`/`.exe`
 * shims) and Windows path separators.
 */
export function classifyShellCommand(commandLine: string): ShellCommandMatch | null {
  const segments = String(commandLine || "").split(/&&|\|\||[;|\r\n]/);
  for (const segment of segments) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g);
    if (!tokens) continue;
    const match = classifyTokens(tokens);
    if (match) return match;
  }
  return null;
}

/**
 * Exit codes that mean the Doctor interrupted the command (Ctrl+C), not that
 * it failed: 130/143 are SIGINT/SIGTERM in POSIX shells; -1073741510 and
 * 3221225786 are STATUS_CONTROL_C_EXIT (0xC000013A) as reported on Windows.
 */
function isInterruptExitCode(code: number): boolean {
  return code === 130 || code === 143 || code === -1073741510 || code === 3221225786;
}

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

    // ---- Terminal build/test results (shell integration) ----
    // window.onDidWriteTerminalData is a *proposed* API: without
    // enabledApiProposals it throws in stable VS Code, and proposals can't
    // ship on the Marketplace. onDidEndTerminalShellExecution is stable since
    // VS Code 1.93 and reports the command line with its real exit code
    // whenever shell integration is active (bash/zsh/fish/pwsh, Git Bash on
    // Windows; not cmd.exe). Older hosts (engines allows 1.85) either lack it
    // or still gate it behind its proposal, which throws and is caught here.
    const shellEvents = vscode.window as any;
    if (typeof shellEvents.onDidEndTerminalShellExecution === "function") {
      try {
        this.disposables.push(
          shellEvents.onDidEndTerminalShellExecution((e: any) => this.handleShellExecutionEnd(e))
        );
      } catch {
        // shell-integration events unavailable in this host
      }
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
  // Internals — terminal build/test results
  // -----------------------------------------------------------------------

  /**
   * Forwards a failed build/test command as a structured event. Successful,
   * interrupted or unknown-outcome commands and anything that isn't a
   * recognized build/test are ignored, as are low-confidence command lines
   * (scraped from the terminal buffer, may be wrong). Nothing is buffered
   * while disconnected: a stale failure isn't worth mentioning later.
   */
  private handleShellExecutionEnd(e: any): void {
    const exitCode = e?.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode === 0) return;
    if (isInterruptExitCode(exitCode)) return;
    const commandLine = e?.execution?.commandLine;
    // TerminalShellExecutionCommandLineConfidence.Low === 0
    if (!commandLine || typeof commandLine.value !== "string" || commandLine.confidence === 0) return;
    const match = classifyShellCommand(commandLine.value);
    if (!match || !this.wsClient?.isConnected()) return;
    const evt: TerminalEvent = {
      kind: match.kind === "test" ? "test-fail" : "build-error",
      command: match.label,
      exitCode,
      timestamp: Date.now(),
    };
    this.wsClient.notify("vscode:terminal-event", evt);
  }

  // -----------------------------------------------------------------------
  // Internals — git (best-effort)
  // -----------------------------------------------------------------------

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
