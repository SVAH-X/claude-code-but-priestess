import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { generateApiShim } from "./api-shim";
import { ContextCapture } from "./context-capture";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private wsUnsubs: (() => void)[] = [];
  private themeUnsub: vscode.Disposable | null = null;
  /**
   * Temp directories created for fix-diff / HTML preview files. Cleaned up
   * in dispose() so previews do not leak one directory each.
   */
  private tempDirs: string[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private wsClient: any,
    private contextCapture?: ContextCapture
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    // Clean up previous wiring to prevent listener accumulation on re-resolve.
    for (const unsub of this.wsUnsubs) { try { unsub(); } catch (_) { /* ignore */ } }
    this.wsUnsubs.length = 0;
    if (this.themeUnsub) { this.themeUnsub.dispose(); this.themeUnsub = null; }


    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "assets"),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Relay postMessage between webview shim and WS client
    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg, webviewView.webview);
    });

    // Forward WS events to the webview
    this.wireWsEvents(webviewView.webview);

    // Follow VS Code theme changes
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.syncTheme(webviewView.webview);
      }
    });

    this.themeUnsub = vscode.window.onDidChangeActiveColorTheme(() => {
      this.syncTheme(webviewView.webview);
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "styles.css")
    );
    const petCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "pet.css")
    );
    const rendererUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "renderer.js")
    );
    const characterDir = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "character")
    );

    const shim = generateApiShim({
      panel: "chat",
      characterBaseUri: characterDir.toString().replace(/\/?$/, "/"),
    });

    // Stamped up front so the first paint already matches the editor; the
    // "theme" message then keeps it in sync as the theme changes.
    return `<!doctype html>
<html lang="zh-CN" data-theme="${this.themeScheme()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};"
  />
  <title>PRTS Chat</title>
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="stylesheet" href="${petCssUri}" />
  <style>
    /* Adapt PRTS variables to VS Code theme */
    :root {
      --stage-target-h: 28vh;
      --composer-min-h: 32px;
    }
    body {
      /* Inherit VS Code sidebar colors */
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
      padding: 0;
      margin: 0;
      border-radius: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    /* Remove the Electron close button / drag handle */
    .top-bar { display: none !important; }
    .resize-handle { display: none !important; }

    /* Character stage */
    .stage {
      position: relative;
      width: 100%;
      flex-shrink: 0;
      height: var(--stage-target-h, 28vh);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
    }
    #petCanvas {
      display: block;
      image-rendering: auto;
    }
    .bubble {
      position: absolute;
      top: 8px;
      right: 12px;
      max-width: 60%;
      padding: 6px 10px;
      border-radius: 10px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-size: 0.85em;
      opacity: 0;
      transition: opacity 0.25s, transform 0.25s;
      transform: translateY(6px);
      pointer-events: none;
    }
    .bubble.show { opacity: 1; transform: translateY(0); }

    /* Chat stream */
    .main-area {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .chat-stream {
      flex: 1;
      padding: 8px 12px;
      overflow-y: auto;
    }
    .msg { margin-bottom: 10px; line-height: 1.5; }
    .msg.user { text-align: right; }
    .msg.assistant { text-align: left; }
    .msg.system { text-align: center; font-size: 0.8em; opacity: 0.6; }
    .msg.tool { text-align: left; }

    /* Composer */
    .composer {
      flex-shrink: 0;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      display: flex;
      flex-direction: column;
    }
    #composer {
      display: flex;
      gap: 6px;
    }
    #composerInput {
      flex: 1;
      resize: none;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: inherit;
      min-height: var(--composer-min-h, 32px);
      max-height: 120px;
    }
    #composerInput:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    #sendBtn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
    }
    #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
    #sendBtn:disabled { opacity: 0.5; cursor: default; }
    .cwd-line {
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      margin: 4px 0 0 0;
      padding: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Context badge on user messages */
    .context-badge {
      display: block;
      margin-top: 4px;
      padding: 2px 8px;
      font-size: 0.72em;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      border-radius: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      opacity: 0.75;
    }
    /* Apply fix button on code blocks */
    .apply-fix-btn {
      display: block;
      margin-top: 4px;
      padding: 2px 10px;
      font-size: 0.75em;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      float: right;
    }
    .apply-fix-btn:hover { background: var(--vscode-button-hoverBackground); }
    .code-block-wrapper { overflow: hidden; }

    /* HTML preview panel */
    .preview-divider { display: none; }
    .html-preview { display: none; }
  </style>
</head>
<body>
  <header class="top-bar" id="dragHandle" style="display:none">
    <div class="bar-title" id="barTitle">
      <span class="version-badge" id="versionBadge"></span>
      <span class="provider-badge" id="providerBadge">Detecting...</span>
      <span class="agent-badge" id="agentBadge" hidden>⚡ agent</span>
    </div>
    <div class="bar-actions" id="barActions">
      <button type="button" id="clearBtn" hidden>Clear</button>
      <button type="button" id="cancelBtn" hidden>Stop</button>
      <button type="button" id="closeBtn" hidden>&times;</button>
    </div>
  </header>
  <section class="stage" id="petStage">
    <canvas id="petCanvas" width="380" height="180"></canvas>
    <div class="bubble" id="petBubble" aria-live="polite"></div>
  </section>
  <div class="main-area" id="mainArea">
    <main class="chat-stream" id="chatStream">
      <p class="empty-hint">博士，早上好。</p>
    </main>
    <div class="preview-divider" id="previewDivider" hidden></div>
    <aside class="html-preview" id="htmlPreview" hidden>
      <header class="preview-header">
        <span class="preview-title" id="previewTitle">HTML Preview</span>
        <div class="preview-actions">
          <button type="button" id="openInBrowserBtn" class="ghost preview-btn">Open in Browser</button>
          <button type="button" id="closePreviewBtn" class="ghost preview-btn preview-close">&times;</button>
        </div>
      </header>
      <iframe id="previewFrame" sandbox="allow-scripts allow-forms allow-modals" srcdoc=""></iframe>
    </aside>
  </div>
  <footer class="composer">
    <form id="composer" autocomplete="off">
      <textarea id="composerInput" rows="1" placeholder="说点什么…" enterkeyhint="send"></textarea>
      <button type="submit" id="sendBtn" disabled>&#x27A4;</button>
    </form>
    <p class="cwd-line" id="cwdLine"></p>
  </footer>
  <script>${shim}</script>
  <script src="${rendererUri}"></script>
</body>
</html>`;
  }

  /**
   * Sends an error envelope back to the webview. Every request handler
   * below routes failures through this helper: a ws request rejects when
   * the tray app is closed or times out, and without a .catch() the
   * rejection would become an unhandled promise rejection in the extension
   * host while the chat panel silently waits. The webview shim resolves
   * __prts_request() with this envelope, so the renderer can surface the
   * failure to the user instead of hanging.
   */
  private replyWithError(webview: vscode.Webview, resultType: string, reqId: unknown, error: unknown) {
    try {
      webview.postMessage({
        type: resultType,
        reqId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (_) {
      // The webview may have been disposed while the request was in flight.
    }
  }

  private handleWebviewMessage(msg: any, webview: vscode.Webview) {
    if (!this.wsClient) return;

    const type = msg.type;

    switch (type) {
      case "chat:send":
        this.wsClient
          .request("chat:send", {
            text: msg.text,
            context: this.contextCapture?.getCurrentContext() || null,
          })
          .then((res: any) => {
            webview.postMessage({
              type: "chat:send:result",
              reqId: msg.reqId,
              ...res,
            });
          })
          .catch((err: any) => {
            this.replyWithError(webview, "chat:send:result", msg.reqId, err);
          });
        break;
      case "chat:cancel":
        // chat:cancel is a fire-and-forget notification - the server never
        // replies, so there is nothing to resolve or reject here.
        this.wsClient.notify("chat:cancel");
        break;
      case "chat:clear":
        this.wsClient
          .request("chat:clear")
          .then(() => {
            webview.postMessage({ type: "chat:clear:result", reqId: msg.reqId });
          })
          .catch((err: any) => {
            this.replyWithError(webview, "chat:clear:result", msg.reqId, err);
          });
        break;
      case "chat:get-history":
        this.wsClient
          .request("chat:get-history")
          .then((res: any) => {
            webview.postMessage({
              type: "chat:get-history:result",
              reqId: msg.reqId,
              history: res.history,
            });
          })
          .catch((err: any) => {
            this.replyWithError(webview, "chat:get-history:result", msg.reqId, err);
          });
        break;
      case "settings:get":
        this.wsClient
          .request("settings:get")
          .then((res: any) => {
            webview.postMessage({
              type: "settings:get:result",
              reqId: msg.reqId,
              state: res.state,
            });
          })
          .catch((err: any) => {
            this.replyWithError(webview, "settings:get:result", msg.reqId, err);
          });
        break;
      case "settings:set":
        this.wsClient
          .request("settings:set", { patch: msg.patch })
          .catch((err: any) => {
            this.replyWithError(webview, "settings:set:result", msg.reqId, err);
          });
        break;
      case "desktop-pet:cat-mode-get":
        this.wsClient
          .request("desktop-pet:cat-mode-get")
          .then((res: any) => {
            webview.postMessage({
              type: "desktop-pet:cat-mode-get:result",
              reqId: msg.reqId,
              ...res,
            });
          })
          .catch((err: any) => {
            this.replyWithError(webview, "desktop-pet:cat-mode-get:result", msg.reqId, err);
          });
        break;
      case "fix:apply":
        // Open a diff view comparing the suggested fix against the original file.
        this.applyFix(msg.filePath, msg.newCode);
        break;
      case "html:open-in-browser":
        // Open the generated HTML in the built-in Simple Browser (sandboxed)
        // rather than the system browser - see openHtmlInBrowser().
        this.openHtmlInBrowser(msg.html);
        break;
      case "preview:open":
      case "preview:close":
        // These are local to the webview - no server round-trip needed
        break;
      default:
        break;
    }
  }

  private wireWsEvents(webview: vscode.Webview) {
    if (!this.wsClient) return;

    const events = [
      "chat:chunk",
      "chat:status",
      "chat:history",
      "chat:tool",
      "chat:mood",
      "chat:proactive",
      "chat:queue",
      "chat:context-attached",
      "settings:state",
      "desktop-pet:cat-mode",
    ];

    for (const evt of events) {
      const handler = (data: any) => {
        if (this.wsClient) webview.postMessage(data);
      };
      this.wsClient.on(evt, handler);
      this.wsUnsubs.push(() => { try { (this.wsClient as any)?.removeListener?.(evt, handler); } catch (_) { /* ignore */ } });
    }
  }

  private themeScheme(): "dark" | "light" {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
      ? "dark"
      : "light";
  }

  private syncTheme(webview: vscode.Webview) {
    webview.postMessage({ type: "theme", scheme: this.themeScheme() });
  }

  /**
   * Opens assistant-generated HTML in the VS Code Simple Browser (built-in,
   * sandboxed) instead of the system browser: the content comes from the
   * model and may contain scripts, so keeping it inside VS Code avoids
   * exposing it to the user's default browser with full local privileges.
   * The temp file is tracked for cleanup on dispose(), same as fix diffs.
   */
  private openHtmlInBrowser(html: string) {
    if (typeof html !== "string" || !html.trim()) {
      vscode.window.showErrorMessage("PRTS: 没有可预览的 HTML 内容。");
      return;
    }
    try {
      const tmpDir = this.createTempDir("prts-preview-");
      const tmpFile = path.join(tmpDir, "preview.html");
      fs.writeFileSync(tmpFile, html, "utf8");
      vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(tmpFile), "simpleBrowser");
    } catch (err) {
      vscode.window.showErrorMessage("PRTS: 打开预览失败 — " + (err as Error).message);
    }
  }

  /**
   * Creates a temp directory and tracks it for cleanup on dispose(). Diff and
   * HTML preview files would otherwise leak one directory per preview.
   */
  private createTempDir(prefix: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.tempDirs.push(tmpDir);
    return tmpDir;
  }

  private applyFix(filePath: string, newCode: string) {
    const uri = vscode.Uri.file(filePath);
    try {
      if (!fs.existsSync(uri.fsPath)) {
        vscode.window.showErrorMessage("PRTS: File not found: " + filePath);
        return;
      }
      // Safety: only allow files inside an open workspace folder.
      // getWorkspaceFolder() uses VS Code's own path normalization (handles
      // case differences on Windows), unlike a manual startsWith() compare
      // that would both false-reject valid paths and be bypassable via
      // symlinks pointing outside the workspace.
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        vscode.window.showErrorMessage("PRTS: File is outside the workspace: " + filePath);
        return;
      }
      const tmpDir = this.createTempDir("prts-suggestion-");
      const tmpFile = path.join(tmpDir, path.basename(filePath));
      fs.writeFileSync(tmpFile, newCode, "utf8");
      const tmpUri = vscode.Uri.file(tmpFile);
      vscode.commands.executeCommand("vscode.diff", uri, tmpUri,
        `PRTS Suggestion — ${path.basename(filePath)}`);
    } catch (err) {
      vscode.window.showErrorMessage("PRTS: Failed to create suggestion diff: " +
        (err as Error).message);
    }
  }

  /**
   * Cleans up temp files created for fix diffs / HTML previews and
   * unsubscribes WS relays. Called from extension deactivate(); VS Code
   * disposes the provider's own registered subscriptions separately.
   */
  dispose(): void {
    for (const dir of this.tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    this.tempDirs.length = 0;
    for (const unsub of this.wsUnsubs) { try { unsub(); } catch (_) { /* ignore */ } }
    this.wsUnsubs.length = 0;
    if (this.themeUnsub) { this.themeUnsub.dispose(); this.themeUnsub = null; }
  }
}
