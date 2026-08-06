/**
 * Minimal in-process `vscode` module stub for fast unit tests.
 *
 * Unit tests run in plain Node (mocha) - there is no extension host, so
 * `require("vscode")` would throw. This helper intercepts Module._load and
 * serves a configurable stub instead. It is installed by passing
 * `--require ./out/src/test/unit/helpers/vscode-stub.js` to mocha, so every
 * compiled extension module that imports `vscode` gets this object.
 *
 * Tests mutate `vscodeStub` directly (e.g. set `window.activeTextEditor`,
 * configure `workspace._config`, seed `languages._diagnostics`) and fire
 * events through the `_emitters` helpers. Call `resetVscodeStub()` in
 * beforeEach to restore defaults.
 */

type Listener = (...args: any[]) => void;

interface Emitter {
  on(listener: Listener): { dispose(): void };
  emit(...args: any[]): void;
}

function createEmitter(): Emitter {
  const listeners: Listener[] = [];
  return {
    on(listener: Listener) {
      listeners.push(listener);
      return {
        dispose() {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    emit(...args: any[]) {
      for (const fn of [...listeners]) {
        try { fn(...args); } catch (_) { /* listener errors must not break the stub */ }
      }
    },
  };
}

function createStatusBarItem() {
  return {
    text: "",
    tooltip: "",
    command: "",
    show() {},
    hide() {},
    dispose() {},
  };
}

function createStub(): any {
  const windowEmitters = {
    activeTextEditor: createEmitter(),
    textEditorSelection: createEmitter(),
    windowState: createEmitter(),
    writeTerminalData: createEmitter(),
    colorTheme: createEmitter(),
  };
  const workspaceEmitters = {
    workspaceFolders: createEmitter(),
    save: createEmitter(),
    configuration: createEmitter(),
  };
  const tasksEmitters = {
    startTask: createEmitter(),
    endTask: createEmitter(),
    processEnd: createEmitter(),
  };
  const languagesEmitters = {
    diagnostics: createEmitter(),
  };

  const windowSection: any = {
    _emitters: windowEmitters,
    _createdStatusBarItems: [] as any[],
    activeTextEditor: undefined,
    createStatusBarItem: (_alignment: number, _priority?: number) => {
      const item = createStatusBarItem();
      windowSection._createdStatusBarItems.push(item);
      return item;
    },
    onDidChangeActiveTextEditor: (cb: Listener) => windowEmitters.activeTextEditor.on(cb),
    onDidChangeTextEditorSelection: (cb: Listener) => windowEmitters.textEditorSelection.on(cb),
    onDidChangeWindowState: (cb: Listener) => windowEmitters.windowState.on(cb),
    onDidWriteTerminalData: (cb: Listener) => windowEmitters.writeTerminalData.on(cb),
    onDidChangeActiveColorTheme: (cb: Listener) => windowEmitters.colorTheme.on(cb),
    _messages: [] as Array<{ kind: string; text: string }>,
    showInformationMessage: async (text: string) => {
      windowSection._messages.push({ kind: "info", text: String(text) });
    },
    showWarningMessage: async (text: string) => {
      windowSection._messages.push({ kind: "warning", text: String(text) });
    },
    showErrorMessage: async (text: string) => {
      windowSection._messages.push({ kind: "error", text: String(text) });
    },
    showQuickPick: async () => undefined,
  };

  const workspaceSection: any = {
    _emitters: workspaceEmitters,
    _config: {},
    workspaceFolders: [],
    getConfiguration: (_section: string) => ({
      get: (key: string) => workspaceSection._config[key],
    }),
    // Configurable by tests via workspaceSection._getWorkspaceFolder.
    getWorkspaceFolder: (_uri: any) =>
      workspaceSection._getWorkspaceFolder ? workspaceSection._getWorkspaceFolder(_uri) : undefined,
    onDidChangeWorkspaceFolders: (cb: Listener) => workspaceEmitters.workspaceFolders.on(cb),
    onDidSaveTextDocument: (cb: Listener) => workspaceEmitters.save.on(cb),
    onDidChangeConfiguration: (cb: Listener) => workspaceEmitters.configuration.on(cb),
  };

  const languagesSection: any = {
    _emitters: languagesEmitters,
    _diagnostics: [],
    getDiagnostics: () => languagesSection._diagnostics,
    onDidChangeDiagnostics: (cb: Listener) => languagesEmitters.diagnostics.on(cb),
    registerInlineCompletionItemProvider: () => ({ dispose() {} }),
  };
  const commandsSection: any = {
    _executed: [] as Array<{ cmd: string; args: any[] }>,
    executeCommand: async (cmd: string, ...args: any[]) => {
      commandsSection._executed.push({ cmd, args });
    },
    registerCommand: () => ({ dispose() {} }),
  };

  return {
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    InlineCompletionItem: class InlineCompletionItem {
      public insertText: string;
      public text: string;
      public range: any;
      public constructor(text: string, range?: any) {
        this.insertText = text;
        this.text = text;
        this.range = range;
      }
    },
    Position: class Position {
      public constructor(public line: number, public character: number) {}
    },
    Range: class Range {
      public constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number
      ) {}
    },
    window: windowSection,
    workspace: workspaceSection,
    languages: languagesSection,
    tasks: {
      _emitters: tasksEmitters,
      onDidStartTask: (cb: Listener) => tasksEmitters.startTask.on(cb),
      onDidEndTask: (cb: Listener) => tasksEmitters.endTask.on(cb),
      onDidEndTaskProcess: (cb: Listener) => tasksEmitters.processEnd.on(cb),
    },
    commands: commandsSection,
    extensions: {
      getExtension: () => undefined,
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
    },
    env: {
      openExternal: async () => true,
    },
  };
}

export const vscodeStub: any = createStub();

export function resetVscodeStub(): void {
  const fresh = createStub();
  for (const key of Object.keys(fresh)) {
    delete vscodeStub[key];
    vscodeStub[key] = fresh[key];
  }
}

// Install the stub for any later `require("vscode")`.
const Module = require("module") as any;
const originalLoad = Module._load;
Module._load = function (this: any, request: string, parent: any, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
