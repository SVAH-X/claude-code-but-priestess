import * as vscode from "vscode";
import { generateApiShim } from "./api-shim";

export class PetPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private wsClient: any
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "assets"),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "focusChat":
          vscode.commands.executeCommand("workbench.view.extension.prts-sidebar");
          break;
        case "settings:get":
          try {
            const res = await this.wsClient.send("settings:get");
            webviewView.webview.postMessage({ ...res, reqId: msg.reqId });
          } catch (_) { /* timeout */ }
          break;
        case "desktop-pet:cat-mode-get":
          try {
            const res = await this.wsClient.send("desktop-pet:cat-mode-get");
            webviewView.webview.postMessage({ ...res, reqId: msg.reqId });
          } catch (_) { /* timeout */ }
          break;
      }
    });

    // Forward cat mode and settings from WS
    if (this.wsClient) {
      this.wsClient.on("desktop-pet:cat-mode", (data: any) => {
        webviewView.webview.postMessage(data);
      });
      this.wsClient.on("settings:state", (data: any) => {
        webviewView.webview.postMessage(data);
      });
    }

    // Theme sync
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.syncTheme(webviewView.webview);
      }
    });
    vscode.window.onDidChangeActiveColorTheme(() => {
      this.syncTheme(webviewView.webview);
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const petScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "pet.js")
    );
    const characterDir = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "character")
    );

    const shim = generateApiShim({
      panel: "pet",
      characterBaseUri: characterDir.toString().replace(/\/?$/, "/"),
    });

    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;"
  />
  <title>PRTS Pet</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    canvas {
      display: block;
      cursor: pointer;
      image-rendering: auto;
    }
  </style>
</head>
<body>
  <canvas id="petCanvas"></canvas>
  <script>${shim}</script>
  <script src="${petScriptUri}"></script>
</body>
</html>`;
  }

  private syncTheme(webview: vscode.Webview) {
    const kind = vscode.window.activeColorTheme.kind;
    const scheme =
      kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
        ? "dark"
        : "light";
    webview.postMessage({ type: "theme", scheme });
  }
}
